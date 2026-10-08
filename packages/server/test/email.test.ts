// 批次 4.6 契约测试：IMAP 客户端（脚本化连接层）、MIME 解析、per-account SQLite、
// email 路由面（discover/test/CRUD/links/sync-now/poll）。形状按
// docs/phase4-backend-inventory.md 与原 routers/email_accounts.py 钉死。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSessionToken } from "../src/jwt";
import { HttpError } from "../src/types";
import { ImapClient, imapSearchDate, type ImapDuplex } from "../src/email/imap";
import { extractAttachments, extractHtmlBody, extractTextBody, epochOf, htmlToText, normalizeDate, parseMessage } from "../src/email/mime";
import { EmailStore } from "../src/email/db";
import { buildMimeMessage } from "../src/email/sender";
import { registerEmailRoutes, type EmailDeps } from "../src/routes_email";
import { discoverImap, discoverSmtp } from "../src/channels/discovery";
import type { ServerConfig } from "../src/config";

// ── IMAP 客户端（脚本化连接层，PRD §6 测试约定） ──

function scriptedDuplex(script: string[]): { conn: ImapDuplex; written: string[] } {
  const lines = [...script];
  const written: string[] = [];
  const conn: ImapDuplex = {
    async readLine() {
      const line = lines.shift();
      if (line === undefined) throw new Error("script exhausted");
      return line;
    },
    async readBytes(n: number) {
      const chunk = lines.shift();
      if (chunk === undefined) throw new Error("script exhausted (literal)");
      return Buffer.from(chunk.slice(0, n), "utf8");
    },
    async write(data) {
      written.push(String(data));
      // 每个 tag 命令触发脚本的下一行组——这里由测试脚本显式预排。
    },
    async end() {},
  };
  return { conn, written };
}

describe("IMAP 客户端（脚本化连接层）", () => {
  it("login/select/search/fetch/logout 全程；literal 读为 Buffer", async () => {
    const raw = "Subject: hi\r\n\r\nbody";
    const { conn, written } = scriptedDuplex([
      "* OK IMAP4rev1 ready",
      "A1 OK LOGIN done",
      "A2 OK [READ-ONLY] INBOX selected",
      "* SEARCH 1 2 3",
      "A3 OK SEARCH done",
      `* 1 FETCH (RFC822 {${raw.length}}`,
      raw + "\r\n",
      ")",
      "A4 OK FETCH done",
      "A5 OK LOGOUT done",
    ]);
    const client = new ImapClient(async () => conn);
    await client.login("u", "p");
    await client.select("INBOX", true);
    const ids = await client.search("SINCE 01-Jan-2026");
    expect(ids).toEqual(["1", "2", "3"]);
    const fetched = await client.fetch("1", "RFC822 FLAGS");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.meta).toContain("FETCH");
    expect(fetched[0]!.data.toString("utf8")).toBe(raw);
    await client.logout();
    expect(written.some((w) => w.includes("EXAMINE \"INBOX\""))).toBe(true);
    expect(written.some((w) => w.includes("A5 LOGOUT"))).toBe(true);
  });

  it("NO/BAD 结束行 → ImapError（登录失败面）", async () => {
    const { conn } = scriptedDuplex(["* OK ready", "A1 NO AUTHENTICATIONFAILED"]);
    const client = new ImapClient(async () => conn);
    await expect(client.login("u", "bad")).rejects.toThrow(/AUTHENTICATIONFAILED/);
  });

  it("imapSearchDate 格式对齐 strftime('%d-%b-%Y')", () => {
    expect(imapSearchDate(new Date(Date.UTC(2026, 2, 5)))).toBe("05-Mar-2026");
  });
});

// ── MIME 解析 ──

describe("MIME 最小解析", () => {
  it("multipart/base64/RFC2047：text 提取 + HTML 提取 + 附件元数据", () => {
    const textB64 = Buffer.from("订单已发货，请查收。", "utf8").toString("base64");
    const htmlB64 = Buffer.from("<p>Order <b>shipped</b></p>", "utf8").toString("base64");
    const attB64 = Buffer.from("CSV,data\n1,2", "utf8").toString("base64");
    const raw = [
      "From: Amazon <no-reply@amazon.com>",
      "To: seller@example.com",
      "Subject: =?utf-8?B?" + Buffer.from("发货通知", "utf8").toString("base64") + "?=",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BOUND"',
      "",
      "--BOUND",
      'Content-Type: multipart/alternative; boundary="ALT"',
      "",
      "--ALT",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      textB64,
      "--ALT",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      htmlB64,
      "--ALT--",
      "--BOUND",
      "Content-Type: application/csv; name=\"report.csv\"",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="report.csv"',
      "",
      attB64,
      "--BOUND--",
    ].join("\r\n");

    const msg = parseMessage(Buffer.from(raw, "utf8"));
    expect(msg.headers["subject"]).toContain("=?utf-8?B?");
    expect(extractTextBody(msg)).toBe("订单已发货，请查收。");
    expect(extractHtmlBody(msg)).toContain("<b>shipped</b>");
    const atts = extractAttachments(msg);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.meta.filename).toBe("report.csv");
    expect(atts[0]!.data?.toString("utf8")).toBe("CSV,data\n1,2");
  });

  it("解码 Subject 编码词（RFC 2047）", () => {
    const raw = "Subject: =?utf-8?B?" + Buffer.from("促销活动", "utf8").toString("base64") + "?=\r\n\r\nx";
    const msg = parseMessage(Buffer.from(raw, "utf8"));
    expect(extractTextBody(msg)).toBe("x");
  });

  it("htmlToText：script/style 剥除、块标签转行、&nbsp; 归一（防 LIKE 失配）", () => {
    const text = htmlToText("<div>a&nbsp;b</div><script>x()</script><style>.i{}</style><p>c<br/>d</p>");
    expect(text).toBe("a b\nc\nd");
    expect(text).not.toContain("\u00a0");
  });

  it("normalizeDate：RFC 2822 → UTC ISO；坏值回退原串", () => {
    const iso = normalizeDate("Mon, 05 Oct 2026 08:00:00 +0000");
    expect(iso).toBe("2026-10-05T08:00:00.000Z");
    expect(normalizeDate("not-a-date")).toBe("not-a-date");
    expect(normalizeDate("")).toBe("");
  });

  it("epochOf：裸日期时间按 UTC（SQLite strftime 语义）", () => {
    expect(epochOf("2026-10-05T08:00:00")).toBe(Math.floor(Date.parse("2026-10-05T08:00:00Z") / 1000));
    expect(epochOf("2026-10-05 08:00:00")).toBe(epochOf("2026-10-05T08:00:00")); // 空格与 T 同值
    expect(epochOf("2026-10-05")).toBe(Math.floor(Date.parse("2026-10-05T00:00:00Z") / 1000));
    expect(epochOf("2026-10-05T08:00:00Z")).toBe(epochOf("2026-10-05T08:00:00"));
    expect(epochOf("garbage")).toBeNull();
    expect(epochOf(null)).toBeNull();
  });

  it("buildMimeMessage：多收件人 + base64 正文 + Message-ID/Date 头", () => {
    const msg = buildMimeMessage({ from: "a@x.com", to: ["b@y.com", "c@z.com"], subject: "标题", body: "正文", messageId: "<id@vibe-seller>", dateIso: "2026-10-08T00:00:00.000Z" });
    expect(msg).toContain("From: a@x.com");
    expect(msg).toContain("To: b@y.com, c@z.com");
    expect(msg).toContain("Message-ID: <id@vibe-seller>");
    expect(msg).toContain("=?utf-8?B?");
    expect(Buffer.from(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/.exec(msg)![1]!, "base64").toString("utf8")).toBe("正文");
  });
});

// ── per-account SQLite ──

describe("per-account email SQLite", () => {
  let dir: string;
  let store: EmailStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibe-emdb-"));
    store = new EmailStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("init/store/getNewEmailsSince：epoch 轴 INTEGER 比较（TEXT date 泄漏教训）", () => {
    store.initEmailDb("acct1");
    store.initEmailDb("acct1"); // 幂等
    const n = store.storeEmails("acct1", [
      { message_id: "m1", folder: "INBOX", subject: "老邮件", date: "2026-09-01T00:00:00Z", fetched_at: "2026-10-01T00:00:00Z", email_account: "a@x.com" },
      { message_id: "m2", folder: "INBOX", subject: "新邮件", date: "2026-10-05T00:00:00Z", fetched_at: "2026-10-06T00:00:00Z", email_account: "a@x.com" },
    ]);
    expect(n).toBe(2);
    // 光标在 10-03（epoch）：只回 m2。水位绝不能用 TEXT date 轴——TEXT 恒大于 INTEGER。
    const cursor = Math.floor(Date.parse("2026-10-03T00:00:00Z") / 1000);
    const { emails, maxEpoch } = store.getNewEmailsSince("acct1", cursor);
    expect(emails.map((e) => e.message_id)).toEqual(["m2"]);
    expect(maxEpoch).toBe(Math.floor(Date.parse("2026-10-06T00:00:00Z") / 1000));
    // 无新邮件 → max 回退到 since（水位单调不回退契约）
    const again = store.getNewEmailsSince("acct1", Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000));
    expect(again.emails).toHaveLength(0);
    expect(again.maxEpoch).toBe(Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000));
  });

  it("sync_state：COALESCE upsert + seen ids JSON 轮转", () => {
    store.initEmailDb("a"); // update_sync_state 假定 DB 已初始化（Python 同约定）
    store.updateSyncState("a", "INBOX", { watermark_date: "2026-10-01T00:00:00Z" });
    store.updateSyncState("a", "INBOX", { last_polled_at: "2026-10-02T00:00:00Z", seen_message_ids: ["x"] });
    const state = store.getSyncState("a", "INBOX");
    expect(state.watermark_date).toBe("2026-10-01T00:00:00Z");
    expect(state.last_polled_at).toBe("2026-10-02T00:00:00Z");
    expect(state.seen_message_ids).toEqual(["x"]);
    // 部分更新不清其他字段
    store.updateSyncState("a", "INBOX", { seen_message_ids: ["x", "y"] });
    expect(store.getSyncState("a", "INBOX").watermark_date).toBe("2026-10-01T00:00:00Z");
    expect(store.getSyncState("a", "INBOX").seen_message_ids).toEqual(["x", "y"]);
  });

  it("searchEmails：日期 + 关键词 LIKE", () => {
    store.initEmailDb("s");
    store.storeEmails("s", [
      { message_id: "1", subject: "flash sale", body_text: "promotion starts", date: "2026-10-05", fetched_at: "2026-10-05" },
      { message_id: "2", subject: "invoice", body_text: "paid", date: "2026-10-06", fetched_at: "2026-10-06" },
    ]);
    const rows = store.searchEmails("s", "2026-10-01", ["promotion"]);
    expect(rows.map((r) => r.message_id)).toEqual(["1"]);
    expect(store.searchEmails("s", "2026-10-01", [])).toHaveLength(2);
    expect(store.searchEmails("missing-db", "2026-01-01", [])).toHaveLength(0);
  });
});

// ── 发现 ──

describe("IMAP/SMTP 发现", () => {
  it("known 表 + 启发式回退", () => {
    expect(discoverImap("a@gmail.com")).toEqual({ imap_host: "imap.gmail.com", imap_port: 993, source: "known" });
    expect(discoverImap("a@some-shop.de").source).toBe("heuristic");
    expect(discoverSmtp("a@qq.com")).toEqual({ smtp_host: "smtp.qq.com", smtp_port: 465, smtp_use_starttls: false, source: "known" });
    expect(discoverSmtp("a@gmail.com").smtp_use_starttls).toBe(true);
  });
});

// ── email 路由面 ──

describe("email 路由（17 端点契约）", () => {
  let dir: string;
  let app: Hono;
  let cookie: string;
  let db: import("node:sqlite").DatabaseSync;
  let syncCalls: number;
  let polled: { message_id: string }[];

  const deps: EmailDeps = {
    config: {} as ServerConfig,
    db: null as unknown as import("node:sqlite").DatabaseSync,
    auth: null as unknown as EmailDeps["auth"],
    jwtSecret: "test-secret",
    imapProbe: {
      testImap: async (host, port, useSsl) => ({ ok: host === "ok.host", message: useSsl ? `ssl:${port}` : `plain:${port}` }),
      testSmtp: async (_host, _port, useTls) => ({ ok: useTls, message: useTls ? "SMTP connection successful" : "SMTP connection failed: nope" }),
    },
    syncImpl: async (account, _password, store) => {
      syncCalls += 1;
      // 真实 sync 会推进 per-account sync_state（_sync_folder 的水位落库）——注入版同摹。
      store.updateSyncState(account.id, "INBOX", { last_polled_at: new Date().toISOString() });
      return 2;
    },
    pollImpl: async (link) => {
      polled.push({ message_id: "m-poll" });
      link.watermark_date = new Date().toISOString();
      link.seen_message_ids = JSON.stringify(["m-poll"]);
      return polled;
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibe-em-"));
    const config: ServerConfig = {
      homeDir: dir,
      dataDir: join(dir, "data"),
      dbPath: join(dir, "data", "vibe_seller.db"),
      jwtSecretFile: join(dir, "data", "jwt_secret"),
      port: 0,
      adminEmail: "a@b.c", adminPassword: "admin", adminUsername: "admin",
      version: "t", jwtSecret: "test-secret",
    };
    const { openDb, seed } = await import("../src/db");
    const { hashPassword } = await import("../src/app");
    db = openDb(config);
    seed(db, config, hashPassword);
    deps.config = config;
    deps.db = db;
    deps.auth = { db, jwtSecret: "test-secret" };
    syncCalls = 0;
    polled = [];
    app = new Hono();
    app.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ detail: err.message }, err.status as 400);
      return c.json({ detail: "Internal Server Error" }, 500);
    });
    registerEmailRoutes(app, deps);
    cookie = `auth_token=${createSessionToken("00000000-0000-0000-0000-000000000001", "admin", "test-secret")}`;
  });
  afterEach(async () => {
    db.close(); // Windows：开着连接删目录会 EBUSY
    await rm(dir, { recursive: true, force: true });
  });

  const get = (path: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  async function createStore(id: string): Promise<void> {
    db.prepare("INSERT INTO stores (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `Store ${id}`, new Date().toISOString(), new Date().toISOString());
  }

  it("discover 两个端点（known/heuristic/missing 422）", async () => {
    const r1 = await get("/api/email-accounts/discover?email=a@gmail.com");
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ imap_host: "imap.gmail.com", imap_port: 993, source: "known" });
    const r2 = await get("/api/email-accounts/discover-smtp?email=a@x.de");
    expect(await r2.json()).toMatchObject({ source: "heuristic", smtp_port: 465, smtp_use_starttls: false });
    expect((await get("/api/email-accounts/discover")).status).toBe(422);
  });

  it("test 端点（未落库探测）：注入 probe 的 ok/message 原样返回", async () => {
    const ok = await post("/api/email-accounts/test", { email: "u@x.com", imap_host: "ok.host", imap_port: 993, password: "pw", use_ssl: true });
    expect(await ok.json()).toEqual({ ok: true, message: "ssl:993" });
    const bad = await post("/api/email-accounts/test", { email: "u@x.com", imap_host: "nope", password: "pw" });
    expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("CRUD：创建（密码 Fernet 落库不回显）→ 重名 409 → 改密 → 删除", async () => {
    const created = await post("/api/email-accounts", { email: "seller@163.com", password: "secret-pw" });
    expect(created.status).toBe(200);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body["email"]).toBe("seller@163.com");
    expect(body["imap_host"]).toBe("imap.163.com"); // 自动发现
    expect(body).not.toHaveProperty("encrypted_password"); // 永不回显
    const row = db.prepare("SELECT encrypted_password FROM email_accounts WHERE email = ?").get("seller@163.com") as { encrypted_password: string };
    expect(row.encrypted_password.startsWith("gAAAAA")).toBe(true); // Fernet 密文

    const dup = await post("/api/email-accounts", { email: "seller@163.com", password: "x" });
    expect(dup.status).toBe(409);

    const list = await get("/api/email-accounts");
    expect((await list.json() as unknown[]).length).toBe(1);

    const upd = await app.request("/api/email-accounts/nonexistent", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(upd.status).toBe(404);

    const id = (body["id"] as string);
    const changePw = await app.request(`/api/email-accounts/${id}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "new-pw" }) });
    expect(changePw.status).toBe(200);

    const del = await app.request(`/api/email-accounts/${id}`, { method: "DELETE", headers: { cookie } });
    expect(await del.json()).toEqual({ ok: true });
    const gone = await app.request(`/api/email-accounts/${id}`, { method: "DELETE", headers: { cookie } });
    expect(gone.status).toBe(404);
  });

  it("账户级 test / test-smtp（无 SMTP host 短路文案）", async () => {
    // 显式 imap_host 便于注入 probe 命中 ok.host
    const created = (await (await post("/api/email-accounts", { email: "a@gmail.com", password: "pw", imap_host: "ok.host" })).json()) as { id: string };
    const t = await post(`/api/email-accounts/${created.id}/test`);
    expect(await t.json()).toEqual({ ok: true, message: "ssl:993" });
    const s = await post(`/api/email-accounts/${created.id}/test-smtp`);
    // gmail 自动发现 smtp_use_starttls=true → 注入 probe ok
    expect(((await s.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("links：建链 → 重复 409 → 账户链接列表 → 店铺列表 → 解链", async () => {
    await createStore("st1");
    const acct = (await (await post("/api/email-accounts", { email: "link@163.com", password: "pw" })).json()) as { id: string };
    const link = await post("/api/stores/st1/emails", { email_account_id: acct.id });
    expect(link.status).toBe(200);
    expect(await link.json()).toMatchObject({ store_id: "st1", email_account_id: acct.id, email: "link@163.com", watermark_date: null });
    expect((await post("/api/stores/st1/emails", { email_account_id: acct.id })).status).toBe(409);
    expect((await post("/api/stores/ghost/emails", { email_account_id: acct.id })).status).toBe(404);

    const storeListBody = (await (await get("/api/stores/st1/emails")).json()) as { id: string }[];
    expect(storeListBody).toHaveLength(1);
    const acctLinks = await get(`/api/email-accounts/${acct.id}/links`);
    expect(((await acctLinks.json()) as { store_name: string }[])[0]!.store_name).toBe("Store st1");

    const linkId = storeListBody[0]!.id;
    const unlink = await app.request(`/api/stores/st1/emails/${linkId}`, { method: "DELETE", headers: { cookie } });
    expect(await unlink.json()).toEqual({ ok: true });
    const wrongStore = await app.request(`/api/stores/st1/emails/${linkId}`, { method: "DELETE", headers: { cookie } });
    expect(wrongStore.status).toBe(404);
  });

  it("sync-now：未知账户 404；冷却内 skipped；同步后 new_emails + last_polled_at", async () => {
    await post("/api/email-accounts", { email: "sync@163.com", password: "pw" });
    const missing = await post("/api/email-accounts/sync-now", { account_email: "ghost@x.com" });
    expect(missing.status).toBe(404);

    const r1 = (await (await post("/api/email-accounts/sync-now", { account_email: "sync@163.com" })).json()) as Record<string, unknown>;
    expect(r1["ok"]).toBe(true);
    expect(r1["new_emails"]).toBe(2);
    expect(r1["last_polled_at"]).toBeTruthy();

    const r2 = (await (await post("/api/email-accounts/sync-now", { account_email: "sync@163.com" })).json()) as Record<string, unknown>;
    expect(r2["skipped"]).toBe(true); // 30s 冷却
    expect(syncCalls).toBe(1);
  });

  it("poll：fake pollImpl → emails/count/total + 水位推进落库", async () => {
    await createStore("st2");
    const acct = (await (await post("/api/email-accounts", { email: "poll@163.com", password: "pw" })).json()) as { id: string };
    await post("/api/stores/st2/emails", { email_account_id: acct.id });
    const r = (await (await post("/api/stores/st2/emails/poll")).json()) as Record<string, unknown>;
    expect(r["count"]).toBe(1);
    expect(r["total"]).toBe(1);
    const link = db.prepare("SELECT watermark_date, seen_message_ids FROM store_email_links WHERE store_id = ?").get("st2") as { watermark_date: string | null; seen_message_ids: string | null };
    expect(link.watermark_date).toBeTruthy();
    expect(JSON.parse(link.seen_message_ids!)).toEqual(["m-poll"]);
    // 60s 冷却：第二次跳过（pollImpl 不再被调用）
    const before = polled.length;
    await post("/api/stores/st2/emails/poll");
    expect(polled.length).toBe(before);
  });

  it("info-by-store：代理/MCP 面契约（schema/column_notes/sample_queries/watermark_note）", async () => {
    await createStore("st3");
    const acct = (await (await post("/api/email-accounts", { email: "info@163.com", password: "pw" })).json()) as { id: string };
    await post("/api/stores/st3/emails", { email_account_id: acct.id });
    const r = (await (await get("/api/email-accounts/info-by-store/st3")).json()) as Record<string, unknown>;
    expect(r["schema"]).toContain("received_epoch");
    expect(String(r["column_notes"])).toContain("received_epoch");
    expect(r["sample_queries"]).toBeTruthy();
    expect(String(r["watermark_note"])).toContain("vibe_seller_get_new_emails");
    const accounts = r["accounts"] as { db_path: string; smtp_configured: boolean }[];
    expect(accounts[0]!.db_path).toContain(`email_${acct.id}.db`);
    expect(accounts[0]!.smtp_configured).toBe(true);
  });
});

// ── 测试小工具 ──
// auth cookie 直签（createSessionToken 已在顶部导入）。
