// 共享邮件轮询/同步工具（app/channels/email_poller.py 移植）。
// 两层：
//   1. syncAccountEmails —— 每账户 IMAP → per-account SQLite 富抽取（HTML/附件/Sent）。
//   2. pollLink —— email_polling 路由的轻量封装（seen_message_ids + 水位推进）。

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImapClient, ImapError, imapSearchDate } from "../email/imap";
import { decodeHeaderValue, extractAttachments, extractHtmlBody, extractTextBody, normalizeDate, parseMessage } from "../email/mime";
import type { EmailStore } from "../email/db";
import type { EmailAccountRow } from "../email/sender";

export const MAX_SEEN_IDS = 500;
export const POLL_COOLDOWN_SECONDS = 60;
export const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const SENT_FOLDER_NAMES = ["Sent", "Sent Messages", "Sent Items", "[Gmail]/Sent Mail", "INBOX.Sent", "已发送"];

// 锁：并发进来串行化（asyncio.Lock 的 TS 等价——promise 链）。
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function makeClient(account: Pick<EmailAccountRow, "imap_host" | "imap_port" | "use_ssl">): ImapClient {
  return new ImapClient(ImapClient.defaultFactory(account.imap_host, account.imap_port ?? 993, Boolean(account.use_ssl)));
}

export async function syncAccountEmails(
  account: EmailAccountRow,
  password: string,
  store: EmailStore,
): Promise<number> {
  return withLock(`sync:${account.id}`, async () => {
    store.initEmailDb(account.id);
    return syncAccountLocked(account, password, store);
  });
}

async function syncAccountLocked(account: EmailAccountRow, password: string, store: EmailStore): Promise<number> {
  const mail = makeClient(account);
  try {
    await mail.login(account.email, password);
    let totalNew = await syncFolder(mail, account, password, "INBOX", store);
    const sentFolder = await detectSentFolder(mail, account.id, store);
    if (sentFolder) totalNew += await syncFolder(mail, account, password, sentFolder, store);
    return totalNew;
  } finally {
    await mail.logout().catch(() => undefined);
  }
}

async function detectSentFolder(mail: ImapClient, accountId: string, store: EmailStore): Promise<string | null> {
  // 缓存复用 sync_state 的 watermark_date 字段（原实现同款复用）。
  const cached = store.getSyncState(accountId, "__sent_folder__");
  if (cached.watermark_date) return cached.watermark_date;
  try {
    const lines = await mail.list();
    const folders: string[] = [];
    for (const line of lines) {
      const folder = parseFolderName(line);
      if (folder) folders.push(folder);
      if (line.includes("\\Sent")) {
        store.updateSyncState(accountId, "__sent_folder__", { watermark_date: folder });
        return folder;
      }
    }
    for (const name of SENT_FOLDER_NAMES) {
      if (folders.includes(name)) {
        store.updateSyncState(accountId, "__sent_folder__", { watermark_date: name });
        return name;
      }
    }
  } catch {
    // 与原实现同：Sent 探测失败不影响 INBOX 同步
  }
  return null;
}

/** _parse_folder_name 移植：`(\flags) "delimiter" "folder"` → 末个带引号串。 */
export function parseFolderName(listLine: string): string | null {
  const parts = listLine.split('"');
  if (parts.length >= 3) return parts[parts.length - 2] ?? null;
  const sp = listLine.split(" ");
  if (sp.length >= 2) return sp[sp.length - 1]!.replace(/^"|"$/g, "");
  return null;
}

async function syncFolder(mail: ImapClient, account: EmailAccountRow, password: string, folder: string, store: EmailStore): Promise<number> {
  void password;
  const accountId = account.id;
  const state = store.getSyncState(accountId, folder);
  const sinceDate = state.watermark_date ? isoToDate(state.watermark_date) : daysAgoUtc(DEFAULT_LOOKBACK_DAYS);
  const seenIds = new Set(state.seen_message_ids);

  try {
    await mail.select(folder, true);
  } catch (e) {
    // 文件夹选不进（不存在/权限）→ 跳过，对齐原实现 debug 返回 0
    if (e instanceof ImapError) return 0;
    throw e;
  }

  const nums = await mail.search(`SINCE ${imapSearchDate(sinceDate)}`);
  const attDir = store.attachmentsDirForAccount(accountId);
  const toStore: Parameters<EmailStore["storeEmails"]>[1] = [];

  for (const num of nums) {
    const fetched = await mail.fetch(num, "RFC822 FLAGS");
    if (!fetched.length) continue;
    const { meta, data } = fetched[0]!;
    const msg = parseMessage(data);

    const messageId = msg.headers["message-id"]?.trim() || num;
    if (seenIds.has(messageId)) continue;

    const flagsMatch = /FLAGS\s*\(([^)]*)\)/.exec(meta);
    const flagsStr = flagsMatch ? flagsMatch[1] : "";

    const rawAttachments = extractAttachments(msg);
    const attachmentMeta = [];
    for (const { meta: m, data: d } of rawAttachments) {
      const entry: Record<string, unknown> = { filename: m.filename, content_type: m.content_type, size: m.size };
      if (d && d.length <= MAX_ATTACHMENT_SIZE) {
        const safeName = m.filename.replace(/\//g, "_").replace(/\\/g, "_").replace(/\0/g, "");
        const midHash = createHash("sha256").update(messageId).digest("hex").slice(0, 8);
        const savePath = join(attDir, `${midHash}_${safeName}`);
        await writeFile(savePath, d);
        entry.local_path = savePath;
      }
      attachmentMeta.push(entry);
    }

    toStore.push({
      message_id: messageId,
      folder,
      subject: decodeHeaderValue(msg.headers["subject"] ?? ""),
      sender: msg.headers["from"] ?? "",
      recipient: msg.headers["to"] ?? "",
      date: normalizeDate(msg.headers["date"] ?? ""),
      body_text: extractTextBody(msg),
      body_html: extractHtmlBody(msg),
      raw_headers: JSON.stringify(msg.headers),
      attachments: attachmentMeta.length ? JSON.stringify(attachmentMeta) : null,
      flags: flagsStr,
      fetched_at: new Date().toISOString(),
      email_account: account.email,
    });
    seenIds.add(messageId);
  }

  const newCount = store.storeEmails(accountId, toStore);

  // seen 截尾：list 保插入序，保留最新（对齐原实现）。
  let seenList = [...seenIds];
  if (seenList.length > MAX_SEEN_IDS) seenList = seenList.slice(seenList.length - MAX_SEEN_IDS);

  const now = new Date().toISOString();
  store.updateSyncState(accountId, folder, { watermark_date: now, last_polled_at: now, seen_message_ids: seenList });
  return newCount;
}

// ── Legacy poll wrapper（email_polling 路由用） ─────────────

export interface PolledEmail {
  message_id: string;
  subject: string;
  sender: string;
  date: string;
  body: string;
  email_account: string;
}

/** _poll_link 移植：独立于 sync 的轻量拉取（INBOX、seen_message_ids、水位推进）。 */
export async function pollLink(
  link: { id: string; watermark_date: string | null; seen_message_ids: string | null },
  account: EmailAccountRow,
  password: string,
): Promise<PolledEmail[]> {
  return withLock(`poll:${link.id}`, async () => {
    const sinceDate = link.watermark_date ? isoToDate(link.watermark_date) : daysAgoUtc(DEFAULT_LOOKBACK_DAYS);
    let seenIds = new Set<string>();
    if (link.seen_message_ids) {
      try {
        const parsed = JSON.parse(link.seen_message_ids);
        if (Array.isArray(parsed)) seenIds = new Set(parsed.map(String));
      } catch {
        seenIds = new Set();
      }
    }

    const messages: PolledEmail[] = [];
    try {
      const mail = makeClient(account);
      await mail.login(account.email, password);
      await mail.select("INBOX", true);
      const nums = await mail.search(`SINCE ${imapSearchDate(sinceDate)}`);
      for (const num of nums) {
        const fetched = await mail.fetch(num, "RFC822");
        if (!fetched.length) continue;
        const msg = parseMessage(fetched[0]!.data);
        const messageId = msg.headers["message-id"]?.trim() || num;
        if (seenIds.has(messageId)) continue;
        messages.push({
          message_id: messageId,
          subject: decodeHeaderValue(msg.headers["subject"] ?? ""),
          sender: msg.headers["from"] ?? "",
          date: msg.headers["date"] ?? "",
          body: extractTextBody(msg),
          email_account: account.email,
        });
      }
      await mail.logout();
    } catch {
      // 与原实现同：轮询失败只记日志返回已有消息
    }

    if (messages.length) {
      const allSeen = new Set<string>([...seenIds, ...messages.map((m) => m.message_id)]);
      let list = [...allSeen];
      if (list.length > MAX_SEEN_IDS) list = list.slice(list.length - MAX_SEEN_IDS);
      link.seen_message_ids = JSON.stringify(list);
      link.watermark_date = new Date().toISOString();
    }
    return messages;
  });
}

function daysAgoUtc(days: number): Date {
  return new Date(Date.now() - days * 86400_000);
}

/** datetime.fromisoformat(watermark).date() 的等价：取 ISO 串的日期部分（UTC 侧）。 */
function isoToDate(iso: string): Date {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return daysAgoUtc(DEFAULT_LOOKBACK_DAYS);
  return new Date(t);
}
