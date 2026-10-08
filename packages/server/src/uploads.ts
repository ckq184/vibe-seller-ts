// 上传契约的单一定义（app/uploads.py 移植）。
// 允许类型恒定：png/jpeg/gif/webp/pdf；上限 100MB（max_upload_size settings 键
// 回给前端的数字）。错误面：类型不符 400、超限 413、空文件 400。
// 差异记录：Python 逐 chunk 流式写盘（峰值内存 = 一个 chunk）；Hono parseBody
// 先缓冲整个 body——用 Content-Length 预检早拒 + 缓冲后总量复查保住 413/400
// 契约，但内存峰值不同（无流式管道可用，Hono 侧约束）。

import { HttpError } from "./types";

export const ALLOWED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
export const ALLOWED_UPLOAD_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"];

export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

/** `104857600` → `'100MB'`（错误文案用）。 */
export function humanSize(numBytes: number): string {
  const mb = numBytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)}MB` : `${numBytes}B`;
}

export function rejectDisallowedType(contentType: string | undefined): void {
  if (!contentType || !ALLOWED_UPLOAD_TYPES.has(contentType)) {
    throw new HttpError(400, `File type not allowed: ${contentType ?? ""}`);
  }
}
