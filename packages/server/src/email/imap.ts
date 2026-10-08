// 最小 IMAP 客户端（零依赖，node:net/node:tls）。
// 命令面对齐消费方：app/channels/email_poller.py（LIST/SELECT(readonly)/SEARCH(SINCE)/
// FETCH(RFC822 [FLAGS])/LOGIN/LOGOUT）与 app/routers/email_polling.py、email_accounts.py
// 的连通性测试（LOGIN/LOGOUT）。Python imaplib 不在 TS 复刻——自研最小客户端是
// PRD §4.2 的预裁决。连接层抽象成可注入的 ImapDuplex，测试喂脚本化字节流。

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** 连接层抽象：行读 + 定长字节读 + 写。真实实现包 net/tls socket；测试注入假流。 */
export interface ImapDuplex {
  readLine(): Promise<string>;
  readBytes(n: number): Promise<Buffer>;
  write(data: string | Buffer): Promise<void>;
  end(): Promise<void>;
  /** STARTTLS 升级需要底层 socket；注入的假流可不提供。 */
  rawSocket?: Socket;
  upgradeTls?(): Promise<void>;
}

export class ImapError extends Error {
  constructor(message: string, readonly status: "NO" | "BAD" | undefined) {
    super(message);
  }
}

export class ImapClient {
  private conn: ImapDuplex | null = null;
  private tag = 0;
  private prefix = "A";

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
    if (!this.conn) {
      this.conn = await this.factory();
      const greeting = await this.conn.readLine();
      if (!greeting.startsWith("* OK")) throw new ImapError(`Bad IMAP greeting: ${greeting}`, undefined);
    }
    return this.conn;
  }  /** 发一条命令，收集非 tag 行直到带 tag 的结束行；IMAP literal（{n}）读为 Buffer 片段。 */
  private async command(cmd: string): Promise<(string | Buffer)[]> {
    const conn = await this.ensureConn();
    const tag = `${this.prefix}${++this.tag}`;
    await conn.write(`${tag} ${cmd}\r\n`);
    const parts: (string | Buffer)[] = [];
    for (;;) {
      const line = await conn.readLine();
      if (line.startsWith(tag)) {
        const rest = line.slice(tag.length).trimStart();
        if (rest.startsWith("OK")) return parts;
        const m = /^(NO|BAD)\s*(.*)$/.exec(rest);
        throw new ImapError(m ? m[2] || rest : rest, m ? (m[1] as "NO" | "BAD") : undefined);
      }
      parts.push(line);
      // 行尾 {n} = literal：紧随 n 字节原始数据（可能含 \r\n），读完后继续收行。
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) parts.push(await conn.readBytes(Number(lit[1])));
    }
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`LOGIN ${quoteString(user)} ${quoteString(password)}`);
  }

  /** SELECT（readonly=true 加 EXAMINE 语义，与原实现 mail.select(folder, readonly=True) 对齐）。 */
  async select(folder: string, readonly = false): Promise<void> {
    if (readonly) {
      // IMAP4 EXAMINE；imaplib 的 readonly 即走 EXAMINE。
      await this.command(`EXAMINE ${quoteMailbox(folder)}`);
    } else {
      await this.command(`SELECT ${quoteMailbox(folder)}`);
    }
  }

  /** SEARCH；criteria 已由调用方拼好（如 `(SINCE 01-Jan-2026)` 的裸参数）。返回序号数组。 */
  async search(criteria: string): Promise<string[]> {
    const parts = await this.command(`SEARCH ${criteria}`);
    const line = parts.find((p) => typeof p === "string" && p.startsWith("* SEARCH")) as string | undefined;
    if (!line) return [];
    return line.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean);
  }

  /** LIST；返回原始响应行（文件夹探测用，解析交给调用方——对齐 _parse_folder_name）。 */
  async list(): Promise<string[]> {
    const parts = await this.command(`LIST "" "*"`);
    return parts.filter((p): p is string => typeof p === "string");
  }

  /**
   * FETCH。items 形如 "RFC822" 或 "RFC822 FLAGS"。返回每条消息的
   * { meta, data }——meta 是 FETCH 元数据行（含 FLAGS），data 是 literal 原始字节，
   * 对齐 imaplib fetch 出的 msg_data[0] = (meta_bytes, raw_bytes)。
   */
  async fetch(sequenceSet: string, items: string): Promise<{ meta: string; data: Buffer }[]> {
    const parts = await this.command(`FETCH ${sequenceSet} (${items})`);
    const out: { meta: string; data: Buffer }[] = [];
    let pendingMeta: string | null = null;
    for (const part of parts) {
      if (typeof part === "string") {
        if (part.startsWith("* ") && part.includes("FETCH")) pendingMeta = part;
      } else if (pendingMeta) {
        out.push({ meta: pendingMeta, data: part });
        pendingMeta = null;
      }
    }
    return out;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } finally {
      await this.conn?.end();
      this.conn = null;
    }
  }
}

export function socketDuplex(socket: Socket): ImapDuplex {
  let buffer = Buffer.alloc(0);
  let closed = false;
  let closedPromise: Promise<void> | null = null;
  const waiters: ((got: boolean) => void)[] = [];

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (waiters.length) waiters.shift()!(true);
  });
  socket.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(false);
  });
  socket.on("error", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(false);
  });

  function waitForData(): Promise<void> {
    if (closed) return Promise.resolve();
    if (!closedPromise) closedPromise = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    return new Promise<void>((resolve) => waiters.push(() => resolve()));
  }

  return {
    rawSocket: socket,
    async readLine() {
      for (;;) {
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          let line = buffer.subarray(0, idx).toString("utf8");
          buffer = buffer.subarray(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          return line;
        }
        if (closed) throw new ImapError("Connection closed", undefined);
        await waitForData();
      }
    },
    async readBytes(n) {
      while (buffer.length < n) {
        if (closed) throw new ImapError("Connection closed mid-literal", undefined);
        await waitForData();
      }
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return out;
    },
    async write(data) {
      await new Promise<void>((resolve, reject) => {
        socket.write(data, (err) => (err ? reject(err) : resolve()));
      });
    },
    async end() {
      socket.end();
    },
  };
}

/** IMAP 字符串字面量：带引号并转义 \ 与 "（LOGIN 参数用）。 */
export function quoteString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 邮箱名：含空格/特殊字符时加引号；UTF-7 编码交给服务器容忍（原实现同样直传 UTF-8 文件夹名）。 */
export function quoteMailbox(name: string): string {
  return quoteString(name);
}

// ── 小工具：Date → IMAP SEARCH 的日期格式（dd-Mon-yyyy，对齐 strftime('%d-%b-%Y')）。 ──
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function imapSearchDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
