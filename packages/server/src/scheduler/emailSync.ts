// 全账户周期邮件同步（app/scheduler/email_sync.py 移植）。
// 5 分钟一跑；信号量并发 3（避免 IMAP 雷群）；单账户失败互不拖累。
// maybe_seed_sync_state：per-account sync_state 为空时用 StoreEmailLink 的
// 最老水位 + seen ids 播种（与 routes_email 里的版本同语义，两处共用此份）。

import type { DatabaseSync } from "node:sqlite";
import { deriveFernetKey, fernetDecryptText } from "../crypto/fernet";
import { EmailStore } from "../email/db";
import { syncAccountEmails } from "../channels/emailPoller";
import type { EmailAccountRow } from "../email/sender";

export async function maybeSeedSyncState(db: DatabaseSync, store: EmailStore, jwtSecret: string, accountId: string): Promise<void> {
  store.initEmailDb(accountId);
  const state = store.getSyncState(accountId, "INBOX");
  if (state.watermark_date || state.last_polled_at || state.seen_message_ids.length) return;
  const links = db.prepare("SELECT watermark_date, seen_message_ids FROM store_email_links WHERE email_account_id = ?").all(accountId) as {
    watermark_date: string | null;
    seen_message_ids: string | null;
  }[];
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
        /* 坏 JSON 视为空（原实现同） */
      }
    }
  }
  if (oldestWm) store.updateSyncState(accountId, "INBOX", { watermark_date: oldestWm, seen_message_ids: [...new Set(allSeen)] });
}

export async function syncAllEmailAccounts(db: DatabaseSync, homeDir: string, jwtSecret: string): Promise<number> {
  const accounts = db.prepare("SELECT * FROM email_accounts").all() as unknown as EmailAccountRow[];
  if (!accounts.length) return 0;
  const store = new EmailStore(`${homeDir}/data/email_dbs`);
  const key = deriveFernetKey(jwtSecret);
  const MAX_CONCURRENT = 3;
  let index = 0;
  let synced = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = index++;
      if (i >= accounts.length) return;
      const account = accounts[i]!;
      try {
        await maybeSeedSyncState(db, store, jwtSecret, account.id);
        const password = fernetDecryptText(key, account.encrypted_password);
        const newCount = await syncAccountEmails(account, password, store);
        if (newCount) {
          console.log(`[vibe-server] Synced ${newCount} new email(s) for ${account.email}`);
          synced += newCount;
        }
      } catch (e) {
        console.warn(`[vibe-server] Email sync failed for ${account.email}: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  return synced;
}
