// WeCom 群机器人 webhook 发送器（app/notifiers/wecom.py 移植）。
// 红线：webhook URL 内嵌 secret key（?key=…）——异常串/错误信息绝不回传完整 URL；
// send-file 的上传地址由 key 推导（同一个 key 驱动 send 与 upload_media）。

const WEBHOOK_TIMEOUT_MS = 30_000;
// 群机器人文件限制：≤20MB 且 >5 字节（upload_media 文档），提前拒绝给出可读错误。
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MIN_FILE_BYTES = 6;
const UPLOAD_TIMEOUT_MS = 120_000;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export async function sendWebhook(webhookUrl: string, content: string, msgtype = "text", fetchImpl: FetchImpl = fetch): Promise<{ ok: boolean; message: string }> {
  const payload = msgtype === "markdown" ? { msgtype: "markdown", markdown: { content } } : { msgtype: "text", text: { content } };
  let data: Record<string, unknown>;
  try {
    // webhook 异常串会带 URL（含 key）——捕获后只回固定文案，与原实现一致。
    const resp = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, message: "Failed to send webhook request." };
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, message: "Failed to send webhook request." };
  }
  if (data["errcode"] === 0) return { ok: true, message: "" };
  // errmsg 来自 WeCom 本身，不含我们的 URL。
  const err = String(data["errmsg"] ?? `errcode=${data["errcode"]}`);
  return { ok: false, message: err };
}

export function webhookKey(webhookUrl: string): string {
  try {
    return new URL(webhookUrl).searchParams.get("key") ?? "";
  } catch {
    return "";
  }
}

export async function sendFileWebhook(webhookUrl: string, filePath: string, fetchImpl: FetchImpl = fetch): Promise<{ ok: boolean; message: string }> {
  const key = webhookKey(webhookUrl);
  if (!key) return { ok: false, message: "Webhook URL is missing its key= parameter." };

  const { stat, readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const name = basename(filePath);
  let size: number;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return { ok: false, message: `Not a regular file: ${name}` };
    size = st.size;
  } catch {
    return { ok: false, message: `File not found: ${name}` };
  }
  if (size < MIN_FILE_BYTES) return { ok: false, message: `File too small for WeCom (<${MIN_FILE_BYTES} bytes).` };
  if (size > MAX_FILE_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return { ok: false, message: `File too large for WeCom: ${mb} MB > 20 MB.` };
  }

  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${encodeURIComponent(key)}&type=file`;
  const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
  try {
    const bytes = await readFile(filePath);
    const form = new FormData();
    // 字段名必须 `media`；filename 必须带（对齐原实现注释）。
    form.append("media", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), name);
    const up = await fetchImpl(uploadUrl, { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    if (!up.ok) return { ok: false, message: "Failed to send file to WeCom." };
    const upData = (await up.json()) as Record<string, unknown>;
    if (upData["errcode"] !== 0) {
      const err = String(upData["errmsg"] ?? `errcode=${upData["errcode"]}`);
      return { ok: false, message: `Upload failed: ${err}` };
    }
    const mediaId = upData["media_id"];
    if (!mediaId) return { ok: false, message: "Upload succeeded but returned no media_id." };
    const resp = await fetchImpl(sendUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "file", file: { media_id: mediaId } }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, message: "Failed to send file to WeCom." };
    const data = (await resp.json()) as Record<string, unknown>;
    if (data["errcode"] === 0) return { ok: true, message: "" };
    return { ok: false, message: String(data["errmsg"] ?? `errcode=${data["errcode"]}`) };
  } catch (e) {
    // 读文件失败只回 basename——绝不回显绝对路径（与原实现同）。
    if (e instanceof Error && "code" in e && ["ENOENT", "EACCES", "EISDIR"].includes(String((e as { code?: string }).code))) {
      return { ok: false, message: `Could not read file: ${name}` };
    }
    return { ok: false, message: "Unexpected error while sending file." };
  }
}

/** webhook 打码：host + key 尾 4 位（列表端点防偷窥；坏 URL 回 '***'）。 */
export function maskWebhookUrl(url: string): string {
  try {
    const parts = new URL(url);
    const host = parts.host || "***";
    let keyTail = "";
    for (const piece of parts.search.slice(1).split("&")) {
      if (piece.startsWith("key=")) {
        const key = piece.slice(4);
        keyTail = key.length > 4 ? key.slice(-4) : "";
        break;
      }
    }
    const suffix = keyTail ? `?key=****${keyTail}` : "";
    return `https://${host}/...${suffix}`;
  } catch {
    return "***";
  }
}
