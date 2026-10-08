// Fernet 对称加密的零依赖实现（纯 node:crypto），逐字节兼容 Python cryptography.fernet。
// 对应原 app/utils/crypto.py：key = urlsafe_b64(sha256(JWT_SECRET))，Python 的
// PBKDF2（默认轮数 200000）只影响 KDF 不影响 token 格式——这里密钥直接由 sha256
// 派生，与 Python 同一公式，因此原地升级后 TS 能解 Python 加密的老数据，反之亦然。
//
// Fernet token 格式（全部大端）：
//   0x80 || timestamp(8B) || IV(16B) || AES-128-CBC(PKCS7(plaintext)) || HMAC-SHA256
// 其中签名密钥 = key 前 16 字节、加密密钥 = key 后 16 字节；HMAC 覆盖
// version..ciphertext 全段；base64url（Python 输出带 = padding，这里保持一致）。
// 解密先常量时间验 HMAC 再解密（对齐 cryptography 的顺序）。

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface FernetKey {
  signKey: Buffer;
  encKey: Buffer;
}

/** sha256(JWT_SECRET) → 32 字节 Fernet key（对齐 crypto.py::_get_fernet 的派生）。 */
export function deriveFernetKey(jwtSecret: string): FernetKey {
  const key = createHash("sha256").update(jwtSecret, "utf8").digest();
  return { signKey: key.subarray(0, 16), encKey: key.subarray(16) };
}

function b64url(buf: Buffer): string {
  // Python base64.urlsafe_b64encode 带 '=' padding；补齐使两语言输出逐字节一致。
  const s = buf.toString("base64url");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

/** 加密。tsSeconds 仅供测试注入固定时间戳；缺省取当前时间。 */
export function fernetEncrypt(key: FernetKey, plaintext: string | Buffer, tsSeconds?: number): string {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", key.encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(tsSeconds ?? Math.floor(Date.now() / 1000)));
  const mac = createHmac("sha256", key.signKey)
    .update(Buffer.concat([Buffer.from([0x80]), ts, iv, ciphertext]))
    .digest();
  return b64url(Buffer.concat([Buffer.from([0x80]), ts, iv, ciphertext, mac]));
}

export class FernetError extends Error {}

/** 解密；任何格式/HMAC/填充错误抛 FernetError（调用方决定 400/502 语义）。 */
export function fernetDecrypt(key: FernetKey, token: string): Buffer {
  const data = Buffer.from(token, "base64"); // Node 的 base64 解码同时接受 url-safe 字符
  // 最短合法 token：1 + 8 + 16 + 16(一个 AES 块) + 32 = 73
  if (data.length < 73 || data.length % 16 !== 9 || data[0] !== 0x80) {
    throw new FernetError("Invalid Fernet token");
  }
  const signed = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const expected = createHmac("sha256", key.signKey).update(signed).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new FernetError("HMAC check failed");
  }
  const iv = data.subarray(9, 25);
  const ciphertext = data.subarray(25, data.length - 32);
  try {
    const decipher = createDecipheriv("aes-128-cbc", key.encKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new FernetError("Invalid Fernet token payload");
  }
}

export function fernetDecryptText(key: FernetKey, token: string): string {
  return fernetDecrypt(key, token).toString("utf8");
}
