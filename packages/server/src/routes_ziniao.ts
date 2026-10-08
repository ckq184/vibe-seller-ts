// 批次 4.6 路由：ziniao-accounts(6)。契约对齐 app/routers/ziniao_accounts.py。
// 密码 Fernet（JWT_SECRET 派生）；解密失败 → 400 detail={"status":"credentials_error"}
//（结构化，前端 Sidebar 渲染在 Edit 按钮旁）。browsers/restart 调紫鸟本地 HTTP API
//（browser/ziniao.ts），错误映射逐条对齐（新终端登录/-10003 结构化透传）。

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import type { ServerConfig } from "./config";
import { deriveFernetKey, fernetDecryptText, fernetEncrypt } from "./crypto/fernet";
import * as telemetry from "./telemetry/core";
import { TelemetryEvent } from "./telemetry/events";
import { ZiniaoNormalModeError, ensureZiniaoRunning, getZiniaoStatus, killAndRelaunchZiniao, tryConnectZiniao, type FetchImpl, type ZiniaoUserInfo } from "./browser/ziniao";

export interface ZiniaoDeps {
  config: ServerConfig;
  db: DatabaseSync;
  auth: AuthContext;
  jwtSecret: string;
  /** 测试注入紫鸟 HTTP 传输层。 */
  fetchImpl?: FetchImpl;
}

interface ZiniaoAccountRow {
  id: string;
  name: string;
  company: string;
  username: string;
  encrypted_password: string;
  socket_port: number | null;
  client_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function accountResponse(a: ZiniaoAccountRow): Record<string, unknown> {
  // 永不回显 encrypted_password
  return {
    id: a.id,
    name: a.name,
    company: a.company,
    username: a.username,
    socket_port: a.socket_port,
    client_path: a.client_path,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function registerZiniaoRoutes(app: Hono, deps: ZiniaoDeps): void {
  const { db, auth } = deps;
  const key = deriveFernetKey(deps.jwtSecret);
  const fetchImpl = deps.fetchImpl;

  const decryptOr400 = (encrypted: string): string => {
    // JWT_SECRET 换装后老密文解不开 → 结构化 400（重输密码即可修）。
    try {
      return fernetDecryptText(key, encrypted);
    } catch {
      throw new HttpError(400, JSON.stringify({ status: "credentials_error" }));
    }
  };

  const getAccountOr404 = (id: string): ZiniaoAccountRow => {
    const row = db.prepare("SELECT * FROM ziniao_accounts WHERE id = ?").get(id) as ZiniaoAccountRow | undefined;
    if (!row) throw new HttpError(404, "Ziniao account not found");
    return row;
  };

  const userInfoOf = (a: ZiniaoAccountRow): ZiniaoUserInfo => ({
    company: a.company,
    username: a.username,
    password: decryptOr400(a.encrypted_password),
  });

  app.get("/api/ziniao-accounts", (c) => {
    getCurrentUser(c, auth);
    const rows = db.prepare("SELECT * FROM ziniao_accounts ORDER BY created_at DESC").all() as unknown as ZiniaoAccountRow[];
    return c.json(rows.map(accountResponse));
  });

  app.post("/api/ziniao-accounts", async (c) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const f of ["name", "company", "username", "password"]) {
      if (!body[f]) throw new HttpError(422, `${f} required`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ziniao_accounts (id, name, company, username, encrypted_password, socket_port, client_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      String(body["name"]),
      String(body["company"]),
      String(body["username"]),
      fernetEncrypt(key, String(body["password"])),
      Number(body["socket_port"] ?? 16851),
      (body["client_path"] as string) ?? "ziniao",
      now,
      now,
    );
    // 原 ziniao_accounts.py:86：commit 后统计（含新账号）→ 分桶
    const total = (db.prepare("SELECT COUNT(*) AS n FROM ziniao_accounts").get() as { n: number }).n;
    telemetry.send(TelemetryEvent.ZINIAO_ACCOUNT_ADDED, { account_count_after_bucket: telemetry.countBucket(total || 0) });
    return c.json(accountResponse(getAccountOr404(id)));
  });

  app.put("/api/ziniao-accounts/:account_id", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(c.req.param("account_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    // password 显式 null/空串 = 不改（前端不碰密码的编辑场景，对齐原实现）。
    if ("password" in body && body["password"]) updates["encrypted_password"] = fernetEncrypt(key, String(body["password"]));
    for (const f of ["name", "company", "username", "socket_port", "client_path"]) {
      if (f in body && body[f] !== null) updates[f] = body[f];
    }
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`);
      const values = Object.values(updates).map((v) => (typeof v === "number" ? v : String(v)));
      db.prepare(`UPDATE ziniao_accounts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, new Date().toISOString(), account.id);
    } else {
      db.prepare("UPDATE ziniao_accounts SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), account.id);
    }
    return c.json(accountResponse(getAccountOr404(account.id)));
  });

  app.delete("/api/ziniao-accounts/:account_id", (c) => {
    getCurrentUser(c, auth);
    const account = db.prepare("SELECT * FROM ziniao_accounts WHERE id = ?").get(c.req.param("account_id") ?? "") as ZiniaoAccountRow | undefined;
    if (account) {
      db.prepare("DELETE FROM ziniao_accounts WHERE id = ?").run(account.id);
      // 原 ziniao_accounts.py:131：仅账号存在才发
      telemetry.send(TelemetryEvent.ZINIAO_ACCOUNT_REMOVED, {});
    }
    // 原实现：不存在也返回 {ok:true}
    return c.json({ ok: true });
  });

  app.get("/api/ziniao-accounts/:account_id/browsers", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(c.req.param("account_id") ?? "");
    const userInfo = userInfoOf(account);
    const clientPath = account.client_path || "ziniao";
    try {
      await ensureZiniaoRunning(account.socket_port ?? 16851, clientPath, userInfo, fetchImpl);
    } catch (e) {
      if (e instanceof ZiniaoNormalModeError) {
        const status = await getZiniaoStatus(account.socket_port ?? 16851, userInfo, fetchImpl);
        throw new HttpError(502, JSON.stringify(status));
      }
      // 尽力给结构化状态；拿不到就透传原始消息
      try {
        const status = await getZiniaoStatus(account.socket_port ?? 16851, userInfo, fetchImpl);
        throw new HttpError(502, JSON.stringify(status));
      } catch (inner) {
        if (inner instanceof HttpError) throw inner;
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
    }

    const data = { action: "getBrowserList", requestId: randomUUID(), ...userInfo };
    const { result } = await tryConnectZiniao(account.socket_port ?? 16851, data, 120_000, fetchImpl);
    if (!result) throw new HttpError(502, "No response from Ziniao client");

    const statusCode = String(result["statusCode"] ?? "");
    // Ziniao 的 statusCode 与失败模式不是 1:1——默认透传 err 原文，少数签名映射结构化。
    if (statusCode !== "0") {
      const errMsg = String(result["err"] ?? "").trim();
      if (errMsg.includes("新终端登录")) throw new HttpError(502, JSON.stringify({ status: "new_terminal_login" }));
      if (statusCode === "-10003") {
        throw new HttpError(502, JSON.stringify({ status: "no_permission", message: errMsg }));
      }
      throw new HttpError(502, errMsg ? `Ziniao API error: ${errMsg}` : `Ziniao API error (statusCode=${statusCode})`);
    }

    const browsers = (result["browserList"] ?? result["data"] ?? []) as Record<string, unknown>[];
    return c.json(
      browsers.map((b) => ({
        browser_name: String(b["browserName"] ?? b["name"] ?? "Unknown"),
        browser_oauth: String(b["browserOauth"] ?? b["oauth"] ?? ""),
      })),
    );
  });

  app.post("/api/ziniao-accounts/:account_id/restart", async (c) => {
    getCurrentUser(c, auth);
    const account = getAccountOr404(c.req.param("account_id") ?? "");
    const userInfo = userInfoOf(account);
    const clientPath = account.client_path || "ziniao";
    // 安全闸：仅 normal mode 可强重启（防误杀活跃 WebDriver 会话）。
    const status = await getZiniaoStatus(account.socket_port ?? 16851, userInfo, fetchImpl);
    if (status.status !== "running_normal") {
      throw new HttpError(409, `Cannot restart: Ziniao is in "${status.status}" state, not "running_normal"`);
    }
    try {
      await killAndRelaunchZiniao(account.socket_port ?? 16851, clientPath, userInfo, fetchImpl);
      return c.json({ ok: true });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
  });
}
