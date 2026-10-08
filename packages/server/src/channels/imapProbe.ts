// IMAP/SMTP 连通性探测（email_accounts.py 里三个 test 端点的共享实现面）。
// 返回 {ok, message}，永不抛错、永不回显密码（对齐原实现的 to_thread + try/except）。

import { ImapClient } from "../email/imap";
import { SmtpClient } from "../email/smtp";
import type { EmailAccountRow } from "../email/sender";

export type ImapProbeResult = { ok: boolean; message: string };
export type ImapProbe = (host: string, port: number, useSsl: boolean, email: string, password: string) => Promise<ImapProbeResult>;
export type SmtpProbe = (host: string, port: number, useTls: boolean, email: string, password: string) => Promise<ImapProbeResult>;

export async function testImapConnection(
  params: { email: string; imap_host: string; imap_port: number; password: string; use_ssl: boolean },
  probe?: ImapProbe,
): Promise<ImapProbeResult> {
  return (probe ?? defaultImapProbe)(params.imap_host, params.imap_port, params.use_ssl, params.email, params.password);
}

export async function testImapAccount(account: EmailAccountRow, password: string, probe?: ImapProbe): Promise<ImapProbeResult> {
  return (probe ?? defaultImapProbe)(account.imap_host, account.imap_port ?? 993, Boolean(account.use_ssl), account.email, password);
}

export async function testSmtpAccount(account: EmailAccountRow, password: string, probe?: SmtpProbe): Promise<ImapProbeResult> {
  return (probe ?? defaultSmtpProbe)(account.smtp_host!, account.smtp_port ?? 587, Boolean(account.smtp_use_tls), account.email, password);
}

export const defaultImapProbe: ImapProbe = async (host, port, useSsl, email, password) => {
  const mail = new ImapClient(ImapClient.defaultFactory(host, port, useSsl));
  try {
    await mail.login(email, password);
    await mail.logout();
    return { ok: true, message: "Connection successful" };
  } catch (e) {
    // 对齐原实现：IMAP 认证失败 vs 连接失败 分文案（TS 客户端统一 ImapError，
    // 用 status===NO 近似 imaplib.IMAP4.error 的认证分支）。
    try {
      await mail.logout();
    } catch {
      /* 已断开 */
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg.includes("AUTHENTICATIONFAILED") || msg.includes("LOGIN failed") ? `IMAP login failed: ${msg}` : `Connection failed: ${msg}` };
  }
};

export const defaultSmtpProbe: SmtpProbe = async (host, port, useTls, email, password) => {
  const client = new SmtpClient(SmtpClient.defaultFactory(host, port, !useTls));
  try {
    await client.connect();
    await client.ehlo();
    if (useTls) {
      await client.starttls();
      await client.ehlo();
    }
    await client.authLogin(email, password);
    await client.quit();
    return { ok: true, message: "SMTP connection successful" };
  } catch (e) {
    try {
      await client.quit();
    } catch {
      /* 已断开 */
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: /auth|535|534/i.test(msg) ? `SMTP auth failed: ${msg}` : `SMTP connection failed: ${msg}` };
  }
};
