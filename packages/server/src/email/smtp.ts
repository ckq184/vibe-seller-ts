// 最小 SMTP 客户端（零依赖，node:net/node:tls）。
// 命令面对齐 app/email/sender.py 的 smtplib 用法：
//   EHLO → [STARTTLS → EHLO] → AUTH LOGIN → MAIL FROM → RCPT TO* → DATA → QUIT。
// use_tls=false = SMTP_SSL（TLS 直连，缺省 465）；true = STARTTLS（缺省 587）。
// 连接层复用 ImapDuplex 抽象（同一套可注入测试面）。

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ImapDuplex } from "./imap";
import { ImapError, socketDuplex } from "./imap";

export class SmtpError extends Error {}

interface Reply {
  code: number;
  lines: string[];
}

export class SmtpClient {
  private conn: ImapDuplex | null = null;
  private socket: Socket | null = null;

  constructor(private readonly factory: () => Promise<ImapDuplex>) {}

  static defaultFactory(host: string, port: number, tls: boolean): () => Promise<ImapDuplex> {
    return async () => {
      const socket: Socket = tls
        ? tlsConnect({ host, port, servername: host })
        : netConnect({ host, port });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once(tls ? "secureConnect" : "connect", () => {
          socket.off("error", reject);
          resolve();
        });
      });
      return socketDuplex(socket);
    };
  }

  private async ensureConn(): Promise<ImapDuplex> {
    if (!this.conn) this.conn = await this.factory();
    return this.conn;
  }

  /** 读一条 SMTP 应答（多行 250-… 连续直到 250 空格行）。 */
  private async readReply(): Promise<Reply> {
    const conn = await this.ensureConn();
    const lines: string[] = [];
    for (;;) {
      const line = await conn.readLine();
      if (line.length < 4 || !/^\d{3}[ -]/.test(line)) throw new SmtpError(`Malformed SMTP reply: ${line}`);
      lines.push(line);
      if (line[3] === " ") {
        const code = Number.parseInt(line.slice(0, 3), 10);
        if (code >= 500) throw new SmtpError(lines.map((l) => l.slice(4)).join(" / "));
        return { code, lines };
      }
    }
  }

  private async cmd(cmd: string, expect = 250): Promise<Reply> {
    const conn = await this.ensureConn();
    await conn.write(`${cmd}\r\n`);
    const reply = await this.readReply();
    if (expect >= 0 && reply.code !== expect) throw new SmtpError(`SMTP ${cmd.split(" ")[0]} failed: ${reply.lines.join(" / ")}`);
    return reply;
  }

  async connect(): Promise<void> {
    await this.ensureConn();
    await this.readReply(); // 220 greeting
  }

  async ehlo(): Promise<string[]> {
    const r = await this.cmd("EHLO vibe-seller", 250);
    return r.lines.map((l) => l.slice(4));
  }

  /** STARTTLS 升级：复用底层 socket 做 TLS 握手，返回后需重新 EHLO。 */
  async starttls(): Promise<void> {
    await this.cmd("STARTTLS", 220);
    const raw = this.conn?.rawSocket;
    if (!raw) throw new SmtpError("STARTTLS not available on injected connection");
    const secure = tlsConnect({ socket: raw });
    await new Promise<void>((resolve, reject) => {
      secure.once("error", reject);
      secure.once("secureConnect", () => {
        secure.off("error", reject);
        resolve();
      });
    });
    this.socket = secure;
    this.conn = socketDuplex(secure);
  }

  async authLogin(user: string, password: string): Promise<void> {
    await this.cmd("AUTH LOGIN", 334);
    await this.cmd(Buffer.from(user, "utf8").toString("base64"), 334);
    await this.cmd(Buffer.from(password, "utf8").toString("base64"), 235);
  }

  async mailFrom(from: string): Promise<void> {
    await this.cmd(`MAIL FROM:<${from}>`, 250);
  }

  async rcptTo(to: string): Promise<void> {
    await this.cmd(`RCPT TO:<${to}>`, 250);
  }

  /** DATA：内容做 dot-stuffing，以 \r\n.\r\n 结束（smtplib.sendmail 的线协议等价）。 */
  async data(message: string): Promise<void> {
    const conn = await this.ensureConn();
    await this.cmd("DATA", 354);
    const stuffed = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
    await conn.write(stuffed.endsWith("\r\n") ? stuffed + ".\r\n" : stuffed + "\r\n.\r\n");
    await this.readReply();
  }

  async quit(): Promise<void> {
    try {
      await this.cmd("QUIT", 221);
    } finally {
      await this.conn?.end();
      this.conn = null;
      this.socket = null;
    }
  }
}
