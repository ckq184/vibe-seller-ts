// SMTP 发信 + 发送记录落 per-account DB（app/email/sender.py 移植）。
// 成功返回 {ok:true, message_id}；失败返回 {ok:false, error}——错误串永不回显密码。

import { randomUUID } from "node:crypto";
import { SmtpClient } from "./smtp";
import type { EmailStore } from "./db";

export interface EmailAccountRow {
  id: string;
  email: string;
  encrypted_password: string;
  imap_host: string;
  imap_port: number | null;
  use_ssl: number | boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_use_tls: number | boolean;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

/** RFC 2047 B 编码编码词（非 ASCII Subject 用，MIMEText utf-8 的线格式等价）。 */
function encodeHeaderText(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(s) && !s.includes("?=")) return s;
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return `=?utf-8?B?${b64}?=`;
}

/** 组装 multipart/mixed 报文（对齐 sender.py 的 MIMEMultipart('mixed') 结构：
 * 有 body_html 时嵌 multipart/alternative(plain+html)，无则单一 text/plain）。 */
export function buildMimeMessage(opts: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  messageId: string;
  dateIso: string;
  attachments?: { filename: string; data: Buffer }[];
}): string {
  const boundary = `===============_${randomUUID().replace(/-/g, "")}==`;
  const altBoundary = `===============_${randomUUID().replace(/-/g, "")}==`;
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to.join(", ")}`);
  lines.push(`Subject: ${encodeHeaderText(opts.subject)}`);
  lines.push(`Message-ID: ${opts.messageId}`);
  lines.push(`Date: ${opts.dateIso}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");
  const part = (headers: string[], bodyText: string): string[] => [...headers, "", ...bodyText.split(/\r?\n/), "", `--${boundary}`];
  lines.push(`--${boundary}`);
  if (opts.bodyHtml) {
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push("");
    lines.push(`--${altBoundary}`);
    lines.push(...part(["Content-Type: text/plain; charset='utf-8'", "Content-Transfer-Encoding: base64"], Buffer.from(opts.body, "utf8").toString("base64")));
    lines.push(`--${altBoundary}`);
    lines.push(...part(["Content-Type: text/html; charset='utf-8'", "Content-Transfer-Encoding: base64"], Buffer.from(opts.bodyHtml, "utf8").toString("base64")));
    lines.push(`--${altBoundary}--`);
    lines.push("", `--${boundary}`);
  } else {
    lines.push(...part(["Content-Type: text/plain; charset='utf-8'", "Content-Transfer-Encoding: base64"], Buffer.from(opts.body, "utf8").toString("base64")));
  }
  for (const att of opts.attachments ?? []) {
    lines.push(...part(
      [
        `Content-Type: application/octet-stream; name="${att.filename.replace(/["\\]/g, "_")}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${att.filename.replace(/["\\]/g, "_")}"`,
      ],
      att.data.toString("base64").replace(/(.{76})/g, "$1\r\n"),
    ));
  }
  lines.push("");
  return lines.join("\r\n");
}

export async function sendEmail(
  account: Pick<EmailAccountRow, "id" | "email" | "smtp_host" | "smtp_port" | "smtp_use_tls">,
  password: string,
  to: string | string[],
  subject: string,
  body: string,
  bodyHtml?: string | null,
  attachments?: { filename: string; data: Buffer }[],
  store?: EmailStore,
): Promise<{ ok: boolean; message_id?: string; error?: string }> {
  const recipients = Array.isArray(to) ? [...to] : [to];
  const smtpHost = account.smtp_host;
  const smtpPort = account.smtp_port ?? 465;
  const useTls = Boolean(account.smtp_use_tls);
  if (!smtpHost) return { ok: false, error: "No SMTP host configured for this account" };

  const messageId = `<${randomUUID()}@vibe-seller>`;
  const dateIso = new Date().toISOString();
  const message = buildMimeMessage({ from: account.email, to: recipients, subject, body, bodyHtml, messageId, dateIso, attachments });

  try {
    const client = new SmtpClient(SmtpClient.defaultFactory(smtpHost, smtpPort, !useTls));
    await client.connect();
    await client.ehlo();
    if (useTls) {
      await client.starttls();
      await client.ehlo();
    }
    await client.authLogin(account.email, password);
    await client.mailFrom(account.email);
    for (const r of recipients) await client.rcptTo(r);
    await client.data(message);
    await client.quit();
  } catch (e) {
    // Python 区分 SMTPAuthenticationError；TS 的 SmtpError 不分型，统一带服务器文案。
    return { ok: false, error: `SMTP error: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 发送即本地落库（folder=Sent），代理/MCP 立即可见
  if (store) {
    try {
      store.initEmailDb(account.id);
      store.storeEmails(account.id, [
        {
          message_id: messageId,
          folder: "Sent",
          subject,
          sender: account.email,
          recipient: recipients.join(", "),
          date: dateIso,
          body_text: body,
          body_html: bodyHtml ?? null,
          email_account: account.email,
          fetched_at: dateIso,
        },
      ]);
    } catch {
      // 与原实现同：记录失败只写日志，不影响发送结果
    }
  }
  return { ok: true, message_id: messageId };
}
