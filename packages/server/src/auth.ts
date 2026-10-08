// 认证依赖：get_current_user 判定树 + require_admin + cookie 语义，
// 与原 app/auth.py 逐分支对齐（判定树见 docs/phase4-backend-inventory.md §3）。

import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./types";
import { getUserById, isAuthRequired, type UserRow } from "./db";
import { verifyToken } from "./jwt";
import { DEFAULT_USER_ID } from "./config";

export interface AuthContext {
  db: DatabaseSync;
  jwtSecret: string;
}

export const COOKIE_NAME = "auth_token";

function tokenFromRequest(c: Context): string | undefined {
  const cookie = getCookie(c, COOKIE_NAME);
  if (cookie) return cookie;
  const header = c.req.header("Authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return undefined;
}

/** 与原 get_current_user 同判定树；失败抛 401（FastAPI 形状 {detail}）。 */
export function getCurrentUser(c: Context, auth: AuthContext): UserRow {
  const { db, jwtSecret } = auth;
  const token = tokenFromRequest(c);
  const authOn = isAuthRequired(db);

  if (token) {
    const payload = verifyToken(token, jwtSecret);
    if (payload) {
      const user = getUserById(db, payload.sub);
      if (user && user.is_active) return user;
    }
    // token 存在但无效/过期/用户没了：仅在强制认证时拒绝；
    // 否则落到默认 admin（换装后旧 cookie 不该把免认证服务器锁进登录页）
    if (authOn) throw new HttpError(401, "Invalid token");
  }

  if (!authOn) {
    const fallback = getUserById(db, DEFAULT_USER_ID);
    if (fallback) return fallback;
  }

  throw new HttpError(401, "Not authenticated");
}

export function requireAdmin(c: Context, auth: AuthContext): UserRow {
  const user = getCurrentUser(c, auth);
  if (user.role !== "admin") throw new HttpError(403, "Admin access required");
  return user;
}

export function userResponse(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    is_active: Boolean(u.is_active),
    avatar_url: u.avatar_url,
    plan_mode_default: Boolean(u.plan_mode_default),
    debug_mode: Boolean(u.debug_mode),
    default_profile_id: u.default_profile_id,
    sync_profile_to_schedules: Boolean(u.sync_profile_to_schedules),
    created_at: u.created_at,
  };
}
