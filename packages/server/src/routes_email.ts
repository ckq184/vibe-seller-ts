// 批次 4.6 路由：email_accounts(16) + email_polling(1) + stores-email links(3)。
// 契约对齐 app/routers/email_accounts.py、app/routers/email_polling.py；错误恒 {"detail"}。
// 密码红线：列表/响应永不回显 encrypted_password（EmailAccountResponse 无该字段）。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { deriveFernetKey, fernetDecryptText, fernetEncrypt } from "./crypto/fernet";
import { EmailStore } from "./email/db";
import { sendEmail, type EmailAccountRow } from "./email/sender";
import { pollLink, syncAccountEmails, POLL_COOLDOWN_SECONDS } from "./channels/emailPoller";
import { discoverImap, discoverSmtp } from "./channels/discovery";
import { randomUUID } from "node:crypto";

export interface EmailDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  /** Fernet 派生源（与 auth 同一 JWT_SECRET）。 */
  jwtSecret: string;
  /** 测试注入 IMAP/SMTP 探测层；缺省真实 net/tls。 */
  imapProbe?: {
    testImap(host: string, port: number, useSsl: boolean, email: string, password: string): Promise<{ ok: boolean; message: string }>;
    testSmtp(host: string, port: number, useTls: boolean, email: string, password: string): Promise<{ ok: boolean; message: string }>;
  };
  /** 测试注入 sync/poll 的 IMAP 层。 */
  syncImpl?: (account: EmailAccountRow, password: string, store: EmailStore) => Promise<number>;
  pollImpl?: (link: { id: string; watermark_date: string | null; seen_message_ids: string | null }, account: EmailAccountRow, password: string) => Promise<unknown[]>;
}

interface EmailAccountRowFull extends EmailAccountRow {}

function rowToResponse(r: EmailAccountRowFull): Record<string, unknown> {
  return {
    id: r.id,
    email: r.email,
    imap_host: r.imap_host,
    imap_port: r.imap_port,
    use_ssl: Boolean(r.use_ssl),
    smtp_host: r.smtp_host,
    smtp_port: r.smtp_port,
    smtp_use_tls: Boolean(r.smtp_use_tls),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getAccountOr404(db: DatabaseSync, accountId: string): EmailAccountRowFull {
  const row = db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(accountId) as EmailAccountRowFull | undefined;
  if (!row) throw new HttpError(404, "Email account not found");
  return row;
}

/** 422 语义：pydantic 缺必填 → 422（对齐 FastAPI 校验边界）。 */
function requireFields(body: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      throw new HttpError(422, `${f} required`);
    }
  }
}

export function registerEmailRoutes(app: Hono, deps: EmailDeps): void {
  const { config, db, auth } = deps;
  const store = new EmailStore(`${config.homeDir}/data/email_dbs`);
  const fernetKey = deriveFernetKey(deps.jwtSecret);

  const decrypt = (enc: string): string => fernetDecryptText(fernetKey, enc);
  const encrypt = (plain: string): string => fernetEncrypt(fernetKey, plain);

  const doSync = deps.syncImpl ?? ((account, password, st) => syncAccountEmails(account, password, st));
  const doPoll =
    deps.pollImpl ??
    ((link, account, password) => pollLink(link as { id: string; watermark_date: string | null; seen_message_ids: string | null }, account, password));

  // ── 发现 ──
  app.get("/api/email-accounts/discover", (c) => {
    getCurrentUser(c, auth);
    const email = c.req.query("email");
    if (!email) throw new HttpError(422, "email required");
    const r = discoverImap(email);
    return c.json({ imap_host: r.imap_host, imap_port: r.imap_port, source: r.source });
  });

  app.get("/api/email-accounts/discover-smtp", (c) => {
    getCurrentUser(c, auth);
    const email = c.req.query("email");
    if (!email) throw new HttpError(422, "email required");
    const r = discoverSmtp(email);
    return c.json({ smtp_host: r.smtp_host, smtp_port: r.smtp_port, smtp_use_starttls: r.smtp_use_starttls, source: r.source });
  });

  // ── 未落库配置连通性测试 ──
  app.post("/api/email-accounts/test", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    requireFields(body, ["email", "imap_host", "password"]);
    const { testImapConnection } = await import("./channels/imapProbe");
    return c.json(
      await testImapConnection(
        {
          email: String(body.email),
          imap_host: String(body.imap_host),
          imap_port: Number(body.imap_port ?? 993),
          password: String(body.password),
          use_ssl: body.use_ssl === undefined ? true : Boolean(body.use_ssl),
        },
        deps.imapProbe?.testImap,
      ),
    );
  });

  // ── CRUD ──
  app.post("/api/email-accounts", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    requireFields(body, ["email", "password"]);
    const email = String(body.email);

    let imapHost = (body.imap_host as string) || "";
    let imapPort = body.imap_port === undefined ? 993 : Number(body.imap_port);
    if (!imapHost) {
      const d = discoverImap(email);
      imapHost = d.imap_host;
      imapPort = d.imap_port;
      // source === 'unknown' 不存在于 discover（恒有启发式回退），故不会 400。
    }

    const exists = db.prepare("SELECT id FROM email_accounts WHERE email = ?").get(email);
    if (exists) throw new HttpError(409, "Email account already exists");

    let smtpHost = (body.smtp_host as string) || null;
    let smtpPort = body.smtp_port === undefined ? null : Number(body.smtp_port);
    let smtpUseTls = body.smtp_use_tls === undefined ? true : Boolean(body.smtp_use_tls);
    if (!smtpHost) {
      const d = discoverSmtp(email);
      smtpHost = d.smtp_host;
      smtpPort = d.smtp_port;
      smtpUseTls = d.smtp_use_starttls;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO email_accounts (id, email, encrypted_password, imap_host, imap_port, use_ssl,
                                   smtp_host, smtp_port, smtp_use_tls, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, email, encrypt(String(body.password)), imapHost, imapPort, body.use_ssl === undefined ? 1 : body.use_ssl ? 1 : 0, smtpHost, smtpPort, smtpUseTls ? 1 : 0, user.id, now, now);
    return c.json(rowToResponse(getAccountOr404(db, id)));
  });

  app.get("/api/email-accounts", (c) => {
    getCurrentUser(c, auth);
    const rows = db.prepare("SELECT * FROM email_accounts ORDER BY created_at DESC").all() as unknown as EmailAccountRowFull[];
    return c.json(rows.map(rowToResponse));
  });

  app.put("/api/email-accounts/:account_id", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(db, c.req.param("account_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    const assign = (col: string, value: string | number | null) => {
      updates.push(`${col} = ?`);
      params.push(value);
    };
    // password 单独处理（加密落库）；显式 null 的 password = 不改。
    if ("password" in body && body.password !== null && body.password !== undefined) {
      assign("encrypted_password", encrypt(String(body.password)));
    }
    if (body.email !== undefined) assign("email", String(body.email));
    if (body.imap_host !== undefined) assign("imap_host", String(body.imap_host));
    if (body.imap_port !== undefined) assign("imap_port", Number(body.imap_port));
    if (body.use_ssl !== undefined) assign("use_ssl", body.use_ssl ? 1 : 0);
    if (body.smtp_host !== undefined) assign("smtp_host", body.smtp_host === null ? null : String(body.smtp_host));
    if (body.smtp_port !== undefined) assign("smtp_port", body.smtp_port === null ? null : Number(body.smtp_port));
    if (body.smtp_use_tls !== undefined) assign("smtp_use_tls", body.smtp_use_tls ? 1 : 0);
    if (!updates.length) throw new HttpError(422, "no fields to update");
    updates.push("updated_at = ?");
    params.push(new Date().toISOString(), account.id);
    db.prepare(`UPDATE email_accounts SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    return c.json(rowToResponse(getAccountOr404(db, account.id)));
  });

  app.delete("/api/email-accounts/:account_id", (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(db, c.req.param("account_id") ?? "");
    db.prepare("DELETE FROM store_email_links WHERE email_account_id = ?").run(account.id);
    db.prepare("DELETE FROM email_accounts WHERE id = ?").run(account.id);
    return c.json({ ok: true });
  });

  // ── 已落库连通性测试 ──
  app.post("/api/email-accounts/:account_id/test", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(db, c.req.param("account_id") ?? "");
    const { testImapAccount } = await import("./channels/imapProbe");
    return c.json(await testImapAccount(account, decrypt(account.encrypted_password), deps.imapProbe?.testImap));
  });

  app.post("/api/email-accounts/:account_id/test-smtp", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(db, c.req.param("account_id") ?? "");
    if (!account.smtp_host) return c.json({ ok: false, message: "No SMTP host configured" });
    const { testSmtpAccount } = await import("./channels/imapProbe");
    return c.json(await testSmtpAccount(account, decrypt(account.encrypted_password), deps.imapProbe?.testSmtp));
  });

  // ── SMTP 发信 ──
  app.post("/api/email-accounts/:account_id/send", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(db, c.req.param("account_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as { to?: string | string[]; subject?: string; body?: string; body_html?: string | null };
    if (!body.to || body.subject === undefined || !body.body) throw new HttpError(422, "to, subject and body required");
    const result = await sendEmail(account, decrypt(account.encrypted_password), body.to, String(body.subject), String(body.body), body.body_html ?? null, undefined, store);
    if (!result.ok) throw new HttpError(502, result.error ?? "Send failed");
    return c.json(result);
  });

  // ── 立即同步（带 30s 冷却） ──
  app.post("/api/email-accounts/sync-now", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { account_email?: string };
    if (!body.account_email) throw new HttpError(422, "account_email required");
    const account = db.prepare("SELECT * FROM email_accounts WHERE email = ?").get(body.account_email) as EmailAccountRowFull | undefined;
    if (!account) throw new HttpError(404, `No account found for ${body.account_email}`);

    const SYNC_COOLDOWN_SECONDS = 30;
    const state = store.getSyncState(account.id, "INBOX");
    if (state.last_polled_at) {
      const last = Date.parse(state.last_polled_at);
      if (!Number.isNaN(last) && (Date.now() - last) / 1000 < SYNC_COOLDOWN_SECONDS) {
        return c.json({ ok: true, account_email: body.account_email, new_emails: 0, last_polled_at: state.last_polled_at, skipped: true });
      }
    }

    await maybeSeedSyncState(db, store, account.id);
    try {
      const newCount = await doSync(account, decrypt(account.encrypted_password), store);
      const after = store.getSyncState(account.id, "INBOX");
      return c.json({ ok: true, account_email: body.account_email, new_emails: newCount, last_polled_at: after.last_polled_at ?? null });
    } catch (e) {
      throw new HttpError(502, `Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── 代理/MCP 面：每账户 DB 路径 + schema + 防泄漏脚注（契约原样保留） ──
  app.get("/api/email-accounts/info-by-store/:store_id", (c) => {
    getCurrentUser(c, auth);
    const storeId = c.req.param("store_id") ?? "";
    const rows = db
      .prepare(
        `SELECT l.id AS link_id, a.* FROM store_email_links l
         JOIN email_accounts a ON l.email_account_id = a.id
         WHERE l.store_id = ?`,
      )
      .all(storeId) as unknown as (EmailAccountRowFull & { link_id: string })[];
    const accounts = rows.map((acct) => {
      store.initEmailDb(acct.id);
      const path = store.dbPathForAccount(acct.id);
      return {
        account_id: acct.id,
        email: acct.email,
        db_path: path,
        attachments_dir: `${store.emailDbDir()}/email_${acct.id}_attachments`,
        smtp_configured: Boolean(acct.smtp_host),
      };
    });
    return c.json({
      store_id: storeId,
      accounts,
      schema:
        "emails(message_id, folder, subject, sender, recipient, date, body_text, body_html, raw_headers, attachments, flags, fetched_at, email_account, received_epoch)",
      column_notes:
        "`date` = sender-supplied ISO string, for DISPLAY only. Never compare it with >/< against the epoch watermark. For any \"since <time>\" filter use `received_epoch` (unix seconds, arrival axis) — that is the axis the email_watermark cursor is measured in, so `received_epoch > <cursor>` is a correct INTEGER compare.",
      sample_queries: [
        "sqlite3 <db_path> \"SELECT subject, sender, date FROM emails WHERE folder='INBOX' ORDER BY received_epoch DESC LIMIT 20\"",
        "sqlite3 <db_path> \"SELECT subject, sender, date FROM emails WHERE subject LIKE '%keyword%'\"",
        "sqlite3 <db_path> \"SELECT subject, sender, date FROM emails WHERE received_epoch > <watermark_epoch> ORDER BY received_epoch ASC\"",
      ],
      watermark_note:
        "For a scheduled \"new emails since the last run\" sweep, do NOT query here — call vibe_seller_get_new_emails. It reads the email_watermark cursor and filters server-side, so already-processed emails never enter your context. If you do query raw, filter on received_epoch (NOT date).",
      sync_interval: "5 minutes (automatic)",
    });
  });

  // ── 链接面 ──
  app.get("/api/email-accounts/:account_id/links", (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(db, c.req.param("account_id") ?? "");
    void account;
    const rows = db
      .prepare(
        `SELECT l.id AS link_id, l.store_id, l.watermark_date, l.last_polled_at, s.name AS store_name
         FROM store_email_links l JOIN stores s ON l.store_id = s.id
         WHERE l.email_account_id = ? ORDER BY l.created_at DESC`,
      )
      .all(c.req.param("account_id") ?? "") as { link_id: string; store_id: string; watermark_date: string | null; last_polled_at: string | null; store_name: string }[];
    return c.json(
      rows.map((r) => ({ link_id: r.link_id, store_id: r.store_id, store_name: r.store_name, watermark_date: r.watermark_date, last_polled_at: r.last_polled_at })),
    );
  });

  app.get("/api/stores/:store_id/emails", (c) => {
    getCurrentUser(c, auth);
    const storeId = c.req.param("store_id") ?? "";
    if (!db.prepare("SELECT id FROM stores WHERE id = ?").get(storeId)) throw new HttpError(404, "Store not found");
    const rows = db
      .prepare(
        `SELECT l.*, a.email AS acct_email FROM store_email_links l
         JOIN email_accounts a ON l.email_account_id = a.id
         WHERE l.store_id = ? ORDER BY l.created_at DESC`,
      )
      .all(storeId) as { id: string; store_id: string; email_account_id: string; watermark_date: string | null; last_polled_at: string | null; acct_email: string }[];
    return c.json(
      rows.map((r) => ({
        id: r.id,
        store_id: r.store_id,
        email_account_id: r.email_account_id,
        email: r.acct_email,
        watermark_date: r.watermark_date,
        last_polled_at: r.last_polled_at,
      })),
    );
  });

  app.post("/api/stores/:store_id/emails", async (c) => {
    getCurrentUser(c, auth);
    const storeId = c.req.param("store_id") ?? "";
    if (!db.prepare("SELECT id FROM stores WHERE id = ?").get(storeId)) throw new HttpError(404, "Store not found");
    const body = (await c.req.json().catch(() => ({}))) as { email_account_id?: string };
    if (!body.email_account_id) throw new HttpError(422, "email_account_id required");
    const account = db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(body.email_account_id) as EmailAccountRowFull | undefined;
    if (!account) throw new HttpError(404, "Email account not found");
    const exists = db.prepare("SELECT id FROM store_email_links WHERE store_id = ? AND email_account_id = ?").get(storeId, account.id);
    if (exists) throw new HttpError(409, "Email already linked to this store");
    const id = randomUUID();
    db.prepare("INSERT INTO store_email_links (id, store_id, email_account_id, created_at) VALUES (?, ?, ?, ?)").run(id, storeId, account.id, new Date().toISOString());
    return c.json({
      id,
      store_id: storeId,
      email_account_id: account.id,
      email: account.email,
      watermark_date: null,
      last_polled_at: null,
    });
  });

  app.delete("/api/stores/:store_id/emails/:link_id", (c) => {
    getCurrentUser(c, auth);
    const link = db.prepare("SELECT * FROM store_email_links WHERE id = ?").get(c.req.param("link_id") ?? "") as { store_id: string } | undefined;
    if (!link || link.store_id !== c.req.param("store_id")) throw new HttpError(404, "Store email link not found");
    db.prepare("DELETE FROM store_email_links WHERE id = ?").run(c.req.param("link_id") ?? "");
    return c.json({ ok: true });
  });

  // ── 店铺级拉新信（email_polling.py） ──
  app.post("/api/stores/:store_id/emails/poll", async (c) => {
    getCurrentUser(c, auth);
    const storeId = c.req.param("store_id") ?? "";
    if (!db.prepare("SELECT id FROM stores WHERE id = ?").get(storeId)) throw new HttpError(404, "Store not found");
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
    const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);

    const rows = db
      .prepare(
        `SELECT l.*, a.id AS acct_id FROM store_email_links l
         JOIN email_accounts a ON l.email_account_id = a.id
         WHERE l.store_id = ?`,
      )
      .all(storeId) as { id: string; watermark_date: string | null; seen_message_ids: string | null; last_polled_at: string | null; acct_id: string }[];

    if (!rows.length) return c.json({ emails: [], count: 0, total: 0 });

    const allEmails: unknown[] = [];
    const now = Date.now();
    for (const link of rows) {
      if (link.last_polled_at) {
        const last = Date.parse(link.last_polled_at);
        if (!Number.isNaN(last) && (now - last) / 1000 < POLL_COOLDOWN_SECONDS) continue;
      }
      const account = getAccountOr404(db, link.acct_id);
      const emails = await doPoll(link, account, decrypt(account.encrypted_password));
      allEmails.push(...emails);
      // 水位推进落库（pollLink 就地改写 link 的水位字段）
      db.prepare("UPDATE store_email_links SET seen_message_ids = ?, watermark_date = ?, last_polled_at = ? WHERE id = ?").run(
        link.seen_message_ids ?? null,
        link.watermark_date ?? null,
        new Date().toISOString(),
        link.id,
      );
    }

    const total = allEmails.length;
    const page = limit === 0 ? allEmails : allEmails.slice(offset, offset + limit);
    return c.json({ emails: page, count: page.length, total });
  });
}

/** maybe_seed_sync_state 移植：per-account sync_state 为空时用 StoreEmailLink 水位播种。 */
async function maybeSeedSyncState(db: DatabaseSync, store: EmailStore, accountId: string): Promise<void> {
  store.initEmailDb(accountId);
  const state = store.getSyncState(accountId, "INBOX");
  if (state.watermark_date || state.last_polled_at || state.seen_message_ids.length) return;
  const links = db
    .prepare("SELECT watermark_date, seen_message_ids FROM store_email_links WHERE email_account_id = ?")
    .all(accountId) as { watermark_date: string | null; seen_message_ids: string | null }[];
  if (!links.length) return;
  let oldestWm: string | null = null;
  const allSeen: string[] = [];
  for (const link of links) {
    if (link.watermark_date && (oldestWm === null || link.watermark_date < oldestWm)) oldestWm = link.watermark_date;
    if (link.seen_message_ids) {
      try {
        const parsed = JSON.parse(link.seen_message_ids);
        if (Array.isArray(parsed)) allSeen.push(...parsed.map(String));
      } catch {
        /* 同原实现 */
      }
    }
  }
  if (oldestWm) {
    store.updateSyncState(accountId, "INBOX", { watermark_date: oldestWm, seen_message_ids: [...new Set(allSeen)] });
  }
}
