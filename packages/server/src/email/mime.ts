// 最小 MIME 解析：只覆盖消费方实际用到的一面（app/channels/email_poller.py +
// app/routers/email_polling.py 的 Python `email` 标准库用法）——
//   头折叠（continuation 行）、RFC 2047 编码词解码（=?charset?B/Q?…?=）、
//   multipart 递归展开（walk 语义）、payload 按 Content-Transfer-Encoding 解码
//   （base64/quoted-printable/7bit/8bit/binary）、text 提取、HTML 提取、
//   attachment 元数据（≤10MB 落盘语义由调用方处理）。
// 差异记录：Python parseaddr/编码词表覆盖 RFC 2231 的分段 filename*0* 等
// 长尾场景，这里做最常见形式（filename*="…"/filename*=charset''enc），
// 超出面按 PRD §4.2 的消费面裁剪原则记录。

const RFC2047_RE = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

/** RFC 2047 编码词解码（Subject/filename 等），对齐 email.header.decode_header 的常用面。 */
export function decodeHeaderValue(raw: string): string {
  if (!raw) return "";
  // 先整体解码（同词相邻无空白时 Python decode_header 也是拼接）。
  const parts: string[] = [];
  let lastEnd = 0;
  for (const m of raw.matchAll(RFC2047_RE)) {
    if (m.index > lastEnd) parts.push(raw.slice(lastEnd, m.index));
    parts.push(decodeWord(m[1]!, m[2]!, m[3]!));
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < raw.length) parts.push(raw.slice(lastEnd));
  return parts.join("");
}

function decodeWord(charset: string, encoding: string, text: string): string {
  try {
    let buf: Buffer;
    if (encoding.toLowerCase() === "b") {
      buf = Buffer.from(text, "base64");
    } else {
      // Q 编码：下划线即空格，=XX 十六进制。
      const expanded = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      buf = Buffer.from(expanded, "latin1");
    }
    return decodeCharset(buf, charset);
  } catch {
    return text;
  }
}

function decodeCharset(buf: Buffer, charset: string): string {
  const label = charset.toLowerCase().split(/[.:]/)[0] || "utf-8";
  const aliases: Record<string, string> = { gb2312: "gbk", gb18030: "gbk", "utf8": "utf-8", "us-ascii": "utf-8", "": "utf-8" };
  const enc = aliases[label] ?? label;
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

export interface ParsedMessage {
  headers: Record<string, string>;
  /** 与 Python msg.walk() 同序的部分列表（含自身），multipart 容器也在内。 */
  parts: MimeNode[];
}

export interface MimeNode {
  headers: Record<string, string>;
  body: Buffer | null; // 解码后（base64/qp）；容器为 null
  children: MimeNode[];
}

/** 解析原始 RFC822 字节为结构化消息（multipart 递归）。 */
export function parseMessage(raw: Buffer): ParsedMessage {
  const { headers, bodyStart } = splitHeaders(raw);
  const node = buildNode(raw.subarray(bodyStart), headers);
  const parts: MimeNode[] = [];
  walk(node, parts);
  return { headers, parts };
}

function walk(node: MimeNode, out: MimeNode[]): void {
  out.push(node);
  for (const c of node.children) walk(c, out);
}

function splitHeaders(raw: Buffer): { headers: Record<string, string>; bodyStart: number } {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const headText = end === -1 ? text : text.slice(0, end);
  const bodyStart = end === -1 ? raw.length : end + (text.slice(end).startsWith("\r\n\r\n") ? 4 : 2);
  // 折叠：以空白开头的行并入上一行（RFC 5322 continuation）。
  const headers: Record<string, string> = {};
  let current: string | null = null;
  for (const line of headText.split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && current) {
      headers[current] += " " + line.trim();
    } else {
      const idx = line.indexOf(":");
      if (idx > 0) {
        current = line.slice(0, idx).trim().toLowerCase();
        headers[current] = line.slice(idx + 1).trim();
      }
    }
  }
  return { headers, bodyStart };
}

function buildNode(body: Buffer, headers: Record<string, string>): MimeNode {
  const contentType = parseContentType(headers["content-type"] ?? "");
  const node: MimeNode = { headers, body: decodeBody(body, headers), children: [] };
  if (contentType.type.startsWith("multipart/") && contentType.boundary) {
    const children = splitMultipart(body, contentType.boundary).map((chunk) => {
      const { headers: ch, bodyStart } = splitHeaders(chunk);
      return buildNode(chunk.subarray(bodyStart), ch);
    });
    node.children = children;
    node.body = null;
  }
  return node;
}

export function parseContentType(value: string): { type: string; charset: string; boundary: string | null; params: Record<string, string> } {
  const type = value.split(";")[0] ?? "";
  const rest = value.split(";").slice(1);
  const params: Record<string, string> = {};
  for (const p of rest) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim().toLowerCase();
    let v = p.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return {
    type: type.trim().toLowerCase() || "text/plain",
    charset: params["charset"] ?? "",
    boundary: params["boundary"] ?? null,
    params,
  };
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const lines: Buffer[] = [];
  let current: Buffer[] = [];
  const dash = `--${boundary}`;
  for (const line of splitLines(body)) {
    const s = line.toString("latin1");
    if (s === dash || s === dash + "--") {
      if (current.length) lines.push(joinLines(current));
      current = [];
      if (s === dash + "--") break;
      continue;
    }
    current.push(line);
  }
  if (current.length && lines.length === 0) lines.push(joinLines(current));
  // 每段去掉尾部的空行分隔（CRLF CRLF 后是下一段边界）
  return lines;
}

function splitLines(body: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 10) {
      let end = i;
      if (end > start && body[end - 1] === 13) end -= 1;
      out.push(body.subarray(start, end));
      start = i + 1;
    }
  }
  if (start < body.length) out.push(body.subarray(start));
  return out;
}

function joinLines(lines: Buffer[]): Buffer {
  return Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\r\n")]));
}

function decodeBody(body: Buffer, headers: Record<string, string>): Buffer | null {
  if (body.length === 0) return null;
  const cte = (headers["content-transfer-encoding"] ?? "").trim().toLowerCase();
  // 去掉结尾的 CRLF（multipart 段的 body 边界前换行）——Python email 解析同样不把它算进 payload。
  let raw = body;
  if (raw.length >= 2 && raw[raw.length - 2] === 13 && raw[raw.length - 1] === 10) raw = raw.subarray(0, raw.length - 2);
  try {
    if (cte === "base64") return Buffer.from(raw.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
    if (cte === "quoted-printable") {
      const s = raw.toString("latin1");
      const bytes: number[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "=") {
          if (s[i + 1] === "\r" && s[i + 2] === "\n") {
            i += 2; // 软换行
          } else if (s[i + 1] === "\n") {
            i += 1;
          } else {
            const h = s.slice(i + 1, i + 3);
            if (/^[0-9A-Fa-f]{2}$/.test(h)) {
              bytes.push(parseInt(h, 16));
              i += 2;
            } else bytes.push(s.charCodeAt(i));
          }
        } else bytes.push(s.charCodeAt(i));
      }
      return Buffer.from(bytes);
    }
    return raw; // 7bit/8bit/binary/未声明
  } catch {
    return raw;
  }
}

/** 部分 → Content-Type；multipart 容器返回 text/plain 之外照实返回。 */
function nodeContentType(node: MimeNode): { type: string; charset: string } {
  const ct = parseContentType(node.headers["content-type"] ?? "");
  return { type: ct.type, charset: ct.charset };
}

function nodeText(node: MimeNode): string | null {
  if (node.body === null) return null;
  const { charset } = nodeContentType(node);
  return decodeCharset(node.body, charset || "utf-8");
}

/** _extract_body 等价：multipart 里第一个 text/plain；非 multipart text/html 时转文本。 */
export function extractTextBody(msg: ParsedMessage): string {
  const root = msg.parts[0]!;
  const rootType = nodeContentType(root).type;
  if (!rootType.startsWith("multipart/")) {
    const text = nodeText(root) ?? "";
    if (rootType === "text/html") return htmlToText(text);
    return text;
  }
  for (const part of msg.parts) {
    if (nodeContentType(part).type === "text/plain") {
      const t = nodeText(part);
      if (t && t.length) return t;
    }
  }
  // multipart 无 text/plain → 回退 HTML（对齐原实现的回退语义）
  const html = extractHtmlBody(msg);
  if (html) return htmlToText(html);
  return "";
}

/** _extract_html_body 等价。 */
export function extractHtmlBody(msg: ParsedMessage): string | null {
  const root = msg.parts[0]!;
  const rootType = nodeContentType(root).type;
  if (!rootType.startsWith("multipart/")) {
    return rootType === "text/html" ? (nodeText(root) ?? null) : null;
  }
  for (const part of msg.parts) {
    if (nodeContentType(part).type === "text/html") {
      const t = nodeText(part);
      if (t && t.length) return t;
    }
  }
  return null;
}

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
}

/** _extract_attachments 的解析面：列出 disposition=attachment 的部分及解码字节。 */
export function extractAttachments(msg: ParsedMessage): { meta: AttachmentMeta; data: Buffer | null }[] {
  const out: { meta: AttachmentMeta; data: Buffer | null }[] = [];
  const root = msg.parts[0]!;
  if (!nodeContentType(root).type.startsWith("multipart/")) return out;
  for (const part of msg.parts) {
    const disposition = part.headers["content-disposition"] ?? "";
    if (!disposition.toLowerCase().startsWith("attachment")) continue;
    const ct = parseContentType(part.headers["content-type"] ?? "");
    const filename = decodeFilename(disposition, part.headers["content-type"] ?? "");
    if (!filename) continue;
    out.push({
      meta: { filename, content_type: ct.type || "application/octet-stream", size: part.body?.length ?? 0 },
      data: part.body,
    });
  }
  return out;
}

function decodeFilename(disposition: string, contentType: string): string {
  // filename="..." / filename*=UTF-8''%E2%80%A6 / RFC 2231 filename*0*=…
  const star = /filename\*=(?:([^']*)')([^']*)'([^;]+)/i.exec(disposition);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[3]!.replace(/\+/g, "%2B"));
      return decodeHeaderValue(star[1] ? decoded : decoded);
    } catch {
      return star[3]!;
    }
  }
  const quoted = /filename="?([^";]+)"?/i.exec(disposition);
  if (quoted) return decodeHeaderValue(quoted[1]!.trim());
  const name = /name="?([^";]+)"?/i.exec(contentType);
  if (name) return decodeHeaderValue(name[1]!.trim());
  return "";
}

/** _html_to_text 移植：去 script/style/注释、块标签转行、实体反转义、空白折叠。 */
export function htmlToText(html: string): string {
  if (!html) return "";
  let cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = htmlUnescape(cleaned);
  // &nbsp; → U+00A0 不被 [ \t]+ 吞，SQL LIKE 会对不上普通空格关键词——先归一。
  cleaned = cleaned.replace(/\u00a0/g, " ");
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "…", mdash: "—", ndash: "–",
};

function htmlUnescape(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** RFC 2822 Date → UTC ISO（对齐 _normalize_date；解析失败回退原串）。 */
export function normalizeDate(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString();
}

/** SQLite strftime('%s', COALESCE(fetched_at, date)) 的 TS 等价（epoch 秒，失败 null）。
 * SQLite 把 'YYYY-MM-DD[ HH:MM:SS]' 视为 UTC——这里按 UTC 解析，别用 Date.parse 的
 * 本地时区语义。 */
export function epochOf(coalesced: string | null | undefined): number | null {
  if (!coalesced) return null;
  const s = coalesced.trim();
  const bare = /^(\d{4}-\d{2}-\d{2})([ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/.exec(s);
  let t: number;
  if (bare) {
    const time = bare[3] ?? "00:00:00";
    t = Date.parse(`${bare[1]}T${time}Z`);
  } else {
    t = Date.parse(s);
  }
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
