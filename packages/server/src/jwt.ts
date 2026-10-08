// JWT HS256（与 PyJWT 逐字节兼容的头/载荷格式）：header 固定
// {"alg":"HS256","typ":"JWT"}，payload {sub, role, exp}（exp=epoch 秒）。
// 手写而非引库：格式面小且要求与 Python 侧完全一致。

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export interface TokenPayload {
  sub: string;
  role: string;
  exp: number;
}

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${HEADER}.${body}.${hmac(`${HEADER}.${body}`, secret)}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, body, signature] = parts as [string, string, string];
  const expected = hmac(`${header}.${body}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  if (header !== HEADER) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (typeof payload.exp !== "number" || Date.now() / 1000 >= payload.exp) return undefined;
    if (typeof payload.sub !== "string") return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export const USER_SESSION_EXPIRE_SECONDS = 24 * 60 * 60; // 24h 交互会话
export const SERVICE_TOKEN_EXPIRE_SECONDS = 7 * 24 * 60 * 60; // 7d 服务令牌

export function createSessionToken(userId: string, role: string, secret: string, ttlSeconds = USER_SESSION_EXPIRE_SECONDS): string {
  return signToken({ sub: userId, role, exp: Math.floor(Date.now() / 1000) + ttlSeconds }, secret);
}
