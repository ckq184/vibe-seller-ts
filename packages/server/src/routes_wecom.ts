// 批次 4.6 路由：wecom-bots(8)。契约对齐 app/routers/wecom_bots.py。
// 安全契约：webhook URL 内嵌 secret key——列表端点打码（host + key 尾 4 位），
// 完整 URL 仅单查/创建/更新返回；send-file 路径白名单（realpath 必须落在已知
// 安全根内：/tmp、/private/tmp、downloads/——绝不放行整个 ~/.vibe-seller，
// 否则 agent 可借 bot 外泄 DB/jwt_secret/店铺资料）。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { maskWebhookUrl, sendWebhook, sendFileWebhook, type FetchImpl } from "./channels/wecom";

export interface WecomDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  /** 测试注入 webhook 传输层。 */
  fetchImpl?: FetchImpl;
}

const DEFAULT_TEST_MESSAGE = "Vibe Seller: WeCom bot connection test ✅";

interface BotRow {
  id: string;
  name: string;
  webhook_url: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

function allowedRoots(config: ServerConfig): string[] {
  // 与原实现逐字一致：/tmp、/private/tmp、downloads/。不存在的根按 resolve 落盘
  //（Windows 上 resolve('/tmp') = 当前盘根 tmp——与 Python Path('/tmp').resolve() 同语义）。
  const roots = ["/tmp", "/private/tmp", join(config.homeDir, "downloads")];
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return resolve(r);
    }
  });
}

/** 路径白名单：展开 ~、要求绝对路径、realpath 后必须落在安全根内。 */
export function resolveSafeFile(rawPath: string, config: ServerConfig): string {
  const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
  if (!isAbsolute(expanded)) throw new HttpError(400, "File path must be absolute");
  let resolved: string;
  try {
    resolved = realpathSync(expanded);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      // 不存在的文件：realpath 失败，按父目录逐级解析（Python resolve() 对不存在路径同样宽松）
      resolved = resolve(expanded);
    } else {
      throw new HttpError(400, "Invalid file path");
    }
  }
  for (const root of allowedRoots(config)) {
    if (resolved === root || resolved.startsWith(root + "/") || resolved.startsWith(root + "\\")) return resolved;
  }
  throw new HttpError(400, "File path is outside the allowed directories");
}

function summary(b: BotRow): Record<string, unknown> {
  return { id: b.id, name: b.name, webhook_url_masked: maskWebhookUrl(b.webhook_url), created_at: b.created_at, updated_at: b.updated_at };
}

function full(b: BotRow): Record<string, unknown> {
  return { id: b.id, name: b.name, webhook_url: b.webhook_url, created_at: b.created_at, updated_at: b.updated_at };
}

function getBotOr404(db: DatabaseSync, id: string): BotRow {
  const row = db.prepare("SELECT * FROM wecom_bots WHERE id = ?").get(id) as BotRow | undefined;
  if (!row) throw new HttpError(404, "Bot not found");
  return row;
}

export function registerWecomRoutes(app: Hono, deps: WecomDeps): void {
  const { db, auth, config } = deps;
  const fetchImpl = deps.fetchImpl ?? (fetch as FetchImpl);

  app.get("/api/wecom-bots", (c) => {
    getCurrentUser(c, auth);
    const rows = db.prepare("SELECT * FROM wecom_bots ORDER BY created_at DESC").all() as unknown as BotRow[];
    return c.json(rows.map(summary));
  });

  app.get("/api/wecom-bots/:bot_id", (c) => {
    getCurrentUser(c, auth);
    return c.json(full(getBotOr404(db, c.req.param("bot_id") ?? "")));
  });

  app.post("/api/wecom-bots", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; webhook_url?: string };
    const name = (body.name ?? "").trim();
    const url = (body.webhook_url ?? "").trim();
    if (!name) throw new HttpError(400, "Name is required");
    if (!url) throw new HttpError(400, "Webhook URL is required");
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO wecom_bots (id, name, webhook_url, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, url, user.id, now, now);
    return c.json(full(getBotOr404(db, id)));
  });

  app.put("/api/wecom-bots/:bot_id", async (c) => {
    getCurrentUser(c, auth);
    const bot = getBotOr404(db, c.req.param("bot_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const key of ["name", "webhook_url"]) {
      if (key in body) {
        const value = body[key];
        if (value === null) throw new HttpError(400, `${key} cannot be null`);
        const str = String(value).trim();
        if (!str) throw new HttpError(400, `${key} cannot be blank`);
        updates[key] = str;
      }
    }
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`);
      const values = Object.values(updates).map((v) => String(v));
      db.prepare(`UPDATE wecom_bots SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, new Date().toISOString(), bot.id);
    }
    return c.json(full(getBotOr404(db, bot.id)));
  });

  app.delete("/api/wecom-bots/:bot_id", (c) => {
    getCurrentUser(c, auth);
    getBotOr404(db, c.req.param("bot_id") ?? "");
    db.prepare("DELETE FROM wecom_bots WHERE id = ?").run(c.req.param("bot_id") ?? "");
    return c.json({ ok: true });
  });

  app.post("/api/wecom-bots/:bot_id/test", async (c) => {
    getCurrentUser(c, auth);
    const bot = getBotOr404(db, c.req.param("bot_id") ?? "");
    const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
    const content = (body?.content ?? "").trim() || DEFAULT_TEST_MESSAGE;
    const { ok, message } = await sendWebhook(bot.webhook_url, content, "text", fetchImpl);
    return c.json({ ok, message: message || "Message sent" });
  });

  app.post("/api/wecom-bots/:bot_id/send", async (c) => {
    getCurrentUser(c, auth);
    const bot = getBotOr404(db, c.req.param("bot_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; msgtype?: string };
    const content = (body.content ?? "").trim();
    if (!content) throw new HttpError(400, "content cannot be blank");
    const msgtype = body.msgtype ?? "text";
    if (msgtype !== "text" && msgtype !== "markdown") throw new HttpError(400, "msgtype must be 'text' or 'markdown'");
    const { ok, message } = await sendWebhook(bot.webhook_url, content, msgtype, fetchImpl);
    return c.json({ ok, message: message || "Message sent" });
  });

  app.post("/api/wecom-bots/:bot_id/send-file", async (c) => {
    getCurrentUser(c, auth);
    const bot = getBotOr404(db, c.req.param("bot_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const raw = (body.path ?? "").trim();
    if (!raw) throw new HttpError(400, "path cannot be blank");
    const safePath = resolveSafeFile(raw, config);
    // 文件缺失/过大由 sendFileWebhook 统一裁决（{ok:false,message}，HTTP 200）——
    // 与原实现一致，不在路由层提前 400。
    const { ok, message } = await sendFileWebhook(bot.webhook_url, safePath, fetchImpl);
    return c.json({ ok, message: message || "File sent" });
  });
}
