// Per-account SQLite 邮件存储（app/email/db.py 逐函数移植，node:sqlite 直开同一文件）。
// 每个邮箱账户一个独立 DB：EMAIL_DBS_DIR/email_<id>.db，代理/MCP 面直接用 sqlite3 CLI 查。
// 红线（原实现同款注释的教训）：水位游标的轴是 received_epoch =
// COALESCE(fetched_at, date) 的 epoch 秒（INTEGER）；绝不能拿 ISO 字符串 date
// （TEXT）和 epoch 游标比较——SQLite 里 TEXT 恒大于 INTEGER，会静默泄漏全表。

import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { epochOf } from "./mime";

export interface StoredEmail {
  message_id: string;
  folder: string;
  subject: string | null;
  sender: string | null;
  recipient: string | null;
  date: string | null;
  body_text: string | null;
  body_html: string | null;
  raw_headers: string | null;
  attachments: string | null;
  flags: string | null;
  fetched_at: string;
  email_account: string | null;
  received_epoch: number | null;
}

export class EmailStore {
  constructor(private readonly emailDbsDir: string) {}

  emailDbDir(): string {
    mkdirSync(this.emailDbsDir, { recursive: true });
    return this.emailDbsDir;
  }

  dbPathForAccount(accountId: string): string {
    return join(this.emailDbDir(), `email_${accountId}.db`);
  }

  attachmentsDirForAccount(accountId: string): string {
    const d = join(this.emailDbDir(), `email_${accountId}_attachments`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private open(accountId: string): DatabaseSync {
    return new DatabaseSync(this.dbPathForAccount(accountId));
  }

  /** init_email_db 等价：建表 + 老库补 received_epoch 列 + 建索引 + 回填 epoch。 */
  initEmailDb(accountId: string): string {
    const path = this.dbPathForAccount(accountId);
    const conn = new DatabaseSync(path);
    try {
      conn.exec("PRAGMA journal_mode=WAL");
      // 基础 schema：只引用首版即存在的列；received_epoch 的索引刻意不在这里建
      // （老库 CREATE TABLE IF NOT EXISTS 不会补列，同脚本建索引会直接炸掉整个同步）。
      conn.exec(`
        CREATE TABLE IF NOT EXISTS emails (
          message_id    TEXT NOT NULL,
          folder        TEXT NOT NULL DEFAULT 'INBOX',
          subject       TEXT,
          sender        TEXT,
          recipient     TEXT,
          date          TEXT,
          body_text     TEXT,
          body_html     TEXT,
          raw_headers   TEXT,
          attachments   TEXT,
          flags         TEXT,
          fetched_at    TEXT,
          email_account TEXT,
          received_epoch INTEGER,
          PRIMARY KEY (message_id, folder)
        );
        CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender);
        CREATE INDEX IF NOT EXISTS idx_emails_date   ON emails(date);
        CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder);
        CREATE TABLE IF NOT EXISTS sync_state (
          folder            TEXT PRIMARY KEY,
          watermark_date    TEXT,
          last_polled_at    TEXT,
          seen_message_ids  TEXT
        );
      `);
      const cols = (conn.prepare("PRAGMA table_info(emails)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("received_epoch")) {
        conn.exec("ALTER TABLE emails ADD COLUMN received_epoch INTEGER");
      }
      conn.exec("CREATE INDEX IF NOT EXISTS idx_emails_recv ON emails(received_epoch)");
      // 老库回填：轴与清扫过滤器一致（COALESCE(fetched_at, date)）。
      // TS 侧不走 strftime——逐行用 epochOf（SQLite 无法回填时同样落 NULL）。
      const backfill = conn.prepare(
        "SELECT rowid, fetched_at, date FROM emails WHERE received_epoch IS NULL",
      ).all() as { rowid: number | bigint; fetched_at: string | null; date: string | null }[];
      const upd = conn.prepare("UPDATE emails SET received_epoch = ? WHERE rowid = ?");
      for (const r of backfill) {
        upd.run(epochOf(r.fetched_at ?? r.date), Number(r.rowid));
      }
    } finally {
      conn.close();
    }
    return path;
  }

  /** store_emails 等价：INSERT OR IGNORE，返回新插入行数。 */
  storeEmails(accountId: string, emails: Partial<StoredEmail>[]): number {
    if (!emails.length) return 0;
    const path = this.dbPathForAccount(accountId);
    const conn = new DatabaseSync(path);
    let newCount = 0;
    try {
      const stmt = conn.prepare(
        `INSERT OR IGNORE INTO emails
         (message_id, folder, subject, sender, recipient,
          date, body_text, body_html, raw_headers,
          attachments, flags, fetched_at, email_account, received_epoch)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const em of emails) {
        const fetchedAt = em.fetched_at ?? new Date().toISOString();
        const date = em.date ?? null;
        const r = stmt.run(
          em.message_id ?? "",
          em.folder ?? "INBOX",
          em.subject ?? null,
          em.sender ?? null,
          em.recipient ?? null,
          date,
          em.body_text ?? null,
          em.body_html ?? null,
          em.raw_headers ?? null,
          em.attachments ?? null,
          em.flags ?? null,
          fetchedAt,
          em.email_account ?? null,
          // received_epoch 轴：到达时间，发送者 date 兜底——与 get_new_emails_since 一致。
          em.received_epoch ?? epochOf(fetchedAt ?? date),
        );
        newCount += Number(r.changes);
      }
    } finally {
      conn.close();
    }
    return newCount;
  }

  /** get_new_emails_since 等价：严格新于 since_epoch 的行 + 可持久化的 max epoch。 */
  getNewEmailsSince(
    accountId: string,
    sinceEpoch: number,
    folder = "INBOX",
    limit = 200,
  ): { emails: Record<string, unknown>[]; maxEpoch: number } {
    const path = this.dbPathForAccount(accountId);
    if (!existsSync(path)) return { emails: [], maxEpoch: sinceEpoch };
    const conn = new DatabaseSync(path);
    try {
      // 优先用落库的 received_epoch 列，兜底实时算——表达式与原实现逐字一致
      //（同一 SQLite 引擎，strftime 语义相同；COALESCE 守护未回填的老行）。
      const epochExpr = "COALESCE(received_epoch, CAST(strftime('%s', COALESCE(fetched_at, date)) AS INTEGER))";
      const rows = conn
        .prepare(
          `SELECT message_id, folder, subject, sender, recipient,
                  date, body_text, ${epochExpr} AS epoch
           FROM emails
           WHERE folder = ? AND ${epochExpr} > ?
           ORDER BY epoch ASC
           LIMIT ?`,
        )
        .all(folder, sinceEpoch, limit) as Record<string, unknown>[];
      let maxEpoch = sinceEpoch;
      for (const em of rows) {
        const ep = em.epoch as number | null;
        if (ep !== null && ep !== undefined && ep > maxEpoch) maxEpoch = ep;
      }
      return { emails: rows, maxEpoch };
    } finally {
      conn.close();
    }
  }

  getSyncState(accountId: string, folder: string): { watermark_date?: string; last_polled_at?: string; seen_message_ids: string[] } {
    const path = this.dbPathForAccount(accountId);
    if (!existsSync(path)) return { seen_message_ids: [] };
    const conn = new DatabaseSync(path);
    try {
      const row = conn
        .prepare("SELECT watermark_date, last_polled_at, seen_message_ids FROM sync_state WHERE folder=?")
        .get(folder) as { watermark_date: string | null; last_polled_at: string | null; seen_message_ids: string | null } | undefined;
      if (!row) return { seen_message_ids: [] };
      let seen: string[] = [];
      if (row.seen_message_ids) {
        try {
          const parsed = JSON.parse(row.seen_message_ids);
          if (Array.isArray(parsed)) seen = parsed.map(String);
        } catch {
          /* 与原实现同：解析失败视为空 */
        }
      }
      return {
        watermark_date: row.watermark_date ?? undefined,
        last_polled_at: row.last_polled_at ?? undefined,
        seen_message_ids: seen,
      };
    } finally {
      conn.close();
    }
  }

  /** update_sync_state 等价：COALESCE upsert——只更新显式给出的字段。 */
  updateSyncState(
    accountId: string,
    folder: string,
    opts: { watermark_date?: string | null; last_polled_at?: string | null; seen_message_ids?: string[] | null } = {},
  ): void {
    const path = this.dbPathForAccount(accountId);
    const conn = new DatabaseSync(path);
    try {
      conn.prepare(
        `INSERT INTO sync_state (folder, watermark_date, last_polled_at, seen_message_ids)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(folder) DO UPDATE SET
           watermark_date=COALESCE(excluded.watermark_date, watermark_date),
           last_polled_at=COALESCE(excluded.last_polled_at, last_polled_at),
           seen_message_ids=COALESCE(excluded.seen_message_ids, seen_message_ids)`,
      ).run(
        folder,
        opts.watermark_date ?? null,
        opts.last_polled_at ?? null,
        opts.seen_message_ids !== undefined && opts.seen_message_ids !== null ? JSON.stringify(opts.seen_message_ids) : null,
      );
    } finally {
      conn.close();
    }
  }

  /** search_emails 等价：日期 + 关键词检索（waiting checker 用）。 */
  searchEmails(accountId: string, since: string, keywords: string[], folders?: string[]): Record<string, unknown>[] {
    const path = this.dbPathForAccount(accountId);
    if (!existsSync(path)) return [];
    const conn = new DatabaseSync(path);
    try {
      const clauses: string[] = ["date >= ?"];
      const params: string[] = [since];
      if (folders && folders.length) {
        clauses.push(`folder IN (${folders.map(() => "?").join(",")})`);
        params.push(...folders);
      }
      const kwParts: string[] = [];
      for (const kw of keywords) {
        kwParts.push("(subject LIKE ? OR body_text LIKE ?)");
        params.push(`%${kw}%`, `%${kw}%`);
      }
      if (kwParts.length) clauses.push(`(${kwParts.join(" OR ")})`);
      const rows = conn
        .prepare(`SELECT * FROM emails WHERE ${clauses.join(" AND ")} ORDER BY date DESC`)
        .all(...params) as Record<string, unknown>[];
      return rows;
    } finally {
      conn.close();
    }
  }
}
