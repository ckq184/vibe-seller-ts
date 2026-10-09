// 路由装配：Hono app，FastAPI 契约对齐。批次 4.1 面：
// health/version/plugins/system + auth(8) + settings(GET/PUT) + users(4) + telemetry/locale + sse + SPA。
// 错误形状恒为 {"detail": "..."}（FastAPI HTTPException 契约，前端按此解析）。

import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import bcrypt from "bcryptjs";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config";
import { DEFAULT_USER_ID } from "./config";
import { getSetting, getUserById, isAuthRequired, type UserRow } from "./db";
import { createSessionToken, USER_SESSION_EXPIRE_SECONDS } from "./jwt";
import { getCurrentUser, requireAdmin, userResponse, COOKIE_NAME, type AuthContext } from "./auth";
import { EventBus } from "./bus";
import { HttpError } from "./types";
import { registerTaskRoutes } from "./routes_tasks";
import { registerScheduleRoutes } from "./routes_schedules";
import { registerWorkspaceRoutes } from "./routes_workspace";
import { registerProfilesRoutes } from "./routes_profiles";
import { registerEmailRoutes } from "./routes_email";
import { registerChannelRoutes } from "./routes_channels";
import { registerWecomRoutes } from "./routes_wecom";
import { registerEventRoutes } from "./routes_events";
import { registerDidaRoutes } from "./routes_dida365";
import { registerZiniaoRoutes } from "./routes_ziniao";
import { registerBrowserRoutes } from "./routes_browser";
import { registerVisionRoutes } from "./routes_vision";
import { registerAttachmentRoutes } from "./routes_attachments";
import { BrowserStarter } from "./browser/starter";
import * as gws from "./workspace/gws";
import * as telemetry from "./telemetry/core";
import { TelemetryEvent } from "./telemetry/events";
import { WorkspaceManager } from "./workspace/manager";
import { KnowledgeSyncManager, SkillsSyncManager } from "./workspace/sync";
import { WorkspaceAssistantManager } from "./workspace/assistant";
import { ProfileManager } from "./profiles/manager";
import { TaskOrchestrator, type EngineFactory } from "./agent/orchestrator";
import { VibeScheduler, startScheduler } from "./scheduler/scheduler";
import { defaultEngineFactory } from "./agent/engine";

export interface AppDeps {
  config: ServerConfig;
  jwtSecret: string;
  db: DatabaseSync;
  bus: EventBus;
  /** 缺省用 defaultEngineFactory(process.env, config)（VIBE_BRIDGE_* 配置）；测试注入 scripted。 */
  engineFactory?: EngineFactory;
  maxConcurrent?: number;
  /** 生产 boot 打开（调度器 7 系统作业 + schedule 重建 + 队列恢复）；测试缺省关，保确定性。 */
  runScheduler?: boolean;
  /** 生产 boot 打开（knowledge/skills 冷却门控的远端同步检查）；测试缺省关，避免网络。 */
  bootSync?: boolean;
  /** 测试注入浏览器启动器（缺省真 BrowserStarter——会 spawn Chrome，测试必须注入）。 */
  starter?: BrowserStarter;
}

// ── settings 键面（对齐 app/routers/app_settings.py） ──
const ALLOWED_KEYS = new Set([
  "auth_required",
  "browser_headless",
  "max_agent_concurrency",
  "default_schedule_phase_mode",
  "default_schedule_timezone",
  "telemetry_enabled",
  "skills_auto_sync_enabled",
  "task_retention_days",
]);
const DEFAULT_TASK_RETENTION_DAYS = 30;
const MAX_TASK_RETENTION_DAYS = 3650;
const MAX_CONCURRENCY_LIMIT = 10;
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const SKILLS_AUTO_SYNC_DEFAULT = "true";
const USER_SELECTABLE_PHASE_MODES = new Set(["fanout", "single", "two_phase"]);
const BOOL_KEYS = new Set(["auth_required", "telemetry_enabled", "browser_headless", "skills_auto_sync_enabled"]);
const INT_RANGES: Record<string, [number, number]> = {
  max_agent_concurrency: [1, MAX_CONCURRENCY_LIMIT],
  task_retention_days: [0, MAX_TASK_RETENTION_DAYS],
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** bcrypt + 72 字节截断（对齐 app/password.py）。 */
export function verifyPassword(plain: string, hashed: string): boolean {
  if (hashed === "disabled") return false;
  try {
    return bcrypt.compareSync(truncate72(plain), hashed);
  } catch {
    return false;
  }
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(truncate72(plain), 10);
}

function truncate72(plain: string): string {
  const bytes = Buffer.from(plain, "utf8");
  if (bytes.length <= 72) return plain;
  return bytes.subarray(0, 72).toString("utf8");
}

function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// _bucket_setting_value（app_settings.py:58）移植：设置值 → 隐私安全的遥测摘要。
// 差异注释：原用 int(value)（'30.5' → 失败）；TS 用 parseInt（'30.5' → 30）——
// 可达值恒为 PUT 归一化后的整数字符串，两者无可观测差异。
function bucketSettingValue(key: string, value: string): string | number | boolean | null {
  if (["auth_required", "telemetry_enabled", "browser_headless", "skills_auto_sync_enabled"].includes(key)) {
    return value === "true";
  }
  if (key === "max_agent_concurrency") {
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }
  if (key === "default_schedule_phase_mode") return value;
  if (key === "default_schedule_timezone") return telemetry.tzContinentBucket(value);
  if (key === "task_retention_days") {
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? null : telemetry.retentionDaysBucket(n);
  }
  return null;
}

export function createApp(deps: AppDeps): Hono {
  const { config, jwtSecret, db, bus } = deps;
  const auth: AuthContext = { db, jwtSecret };
  const app = new Hono();
  const nowIso = () => new Date().toISOString();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ detail: err.message }, err.status as 400);
    console.error("[vibe-server] unhandled:", err);
    return c.json({ detail: "Internal Server Error" }, 500);
  });

  const setSessionCookie = (c: Context, token: string) =>
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: USER_SESSION_EXPIRE_SECONDS,
    });

  // ── 系统面 ──
  app.get("/api/health", (c) => c.json({ status: "ok", version: config.version }));
  app.get("/api/version", (c) => c.json({ version: config.version }));
  app.get("/api/plugins", (c) => c.json([]));
  app.get("/api/system/info", (c) =>
    c.json({
      platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux",
      version: config.version,
      commit: null,
    }),
  );
  app.get("/api/system/update-check", (c) => c.json({ dev: true }));

  // ── auth（判定树与原 get_current_user 一致） ──
  app.get("/api/auth/status", (c) => c.json({ auth_required: isAuthRequired(db) }));

  app.post("/api/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { identifier?: string; password?: string };
    if (!body.identifier || !body.password) throw new HttpError(422, "identifier and password required");
    const user = body.identifier.includes("@")
      ? (db.prepare("SELECT * FROM users WHERE email = ?").get(body.identifier) as UserRow | undefined)
      : (db.prepare("SELECT * FROM users WHERE username = ?").get(body.identifier.toLowerCase()) as UserRow | undefined);
    if (!user || !user.is_active || user.role === "ai_bot" || !verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, "Invalid credentials");
    }
    setSessionCookie(c, createSessionToken(user.id, user.role, jwtSecret));
    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      default_profile_id: user.default_profile_id,
      debug_mode: Boolean(user.debug_mode),
      plan_mode_default: Boolean(user.plan_mode_default),
      sync_profile_to_schedules: Boolean(user.sync_profile_to_schedules),
    });
  });

  app.post("/api/auth/refresh", (c) => {
    const user = getCurrentUser(c, auth);
    setSessionCookie(c, createSessionToken(user.id, user.role, jwtSecret));
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", (c) => c.json(userResponse(getCurrentUser(c, auth))));

  app.patch("/api/auth/me/debug-mode", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { debug_mode?: boolean };
    const debugMode = Boolean(body.debug_mode);
    db.prepare("UPDATE users SET debug_mode = ?, updated_at = ? WHERE id = ?").run(debugMode ? 1 : 0, nowIso(), user.id);
    // 原 routers/auth.py:119 toggle_debug_mode：变更即发（bool(body.get('debug_mode', False))）
    telemetry.send(TelemetryEvent.USER_PREF_CHANGED, { key: "debug_mode", to_value: debugMode });
    return c.json({ ok: true, debug_mode: debugMode });
  });

  app.patch("/api/auth/me/password", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { current_password?: string; new_password?: string };
    if (!body.new_password) throw new HttpError(422, "new_password required");
    // 原 routers/auth.py change_password：auth_on 时 current_password 必填且
    // 必须正确（'Current password is required' / 'Current password is incorrect'）；
    // auth 关闭时跳过校验（'Skip current_password when auth off'）。
    // 批次 4.7.2 录制回放对齐：此前 TS 在缺 current_password 时静默放行。
    if (isAuthRequired(db)) {
      if (!body.current_password) throw new HttpError(400, "Current password is required");
      if (user.password_hash !== "disabled" && !verifyPassword(body.current_password, user.password_hash)) {
        throw new HttpError(400, "Current password is incorrect");
      }
    }
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(body.new_password), nowIso(), user.id);
    return c.json({ ok: true });
  });

  app.patch("/api/auth/me/profile", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      email?: string;
      plan_mode_default?: boolean;
      sync_profile_to_schedules?: boolean;
    };
    // 原 routers/auth.py change_profile：仅在实际变更分支发 user_pref_changed
    //（body 值与当前值比较）。更新本身保持既有无条件写语义不变。
    if (body.plan_mode_default !== undefined && body.plan_mode_default !== Boolean(user.plan_mode_default)) {
      telemetry.send(TelemetryEvent.USER_PREF_CHANGED, { key: "plan_mode_default", to_value: Boolean(body.plan_mode_default) });
    }
    if (body.sync_profile_to_schedules !== undefined && body.sync_profile_to_schedules !== Boolean(user.sync_profile_to_schedules)) {
      telemetry.send(TelemetryEvent.USER_PREF_CHANGED, { key: "sync_profile_to_schedules", to_value: Boolean(body.sync_profile_to_schedules) });
    }
    db.prepare(
      "UPDATE users SET username = ?, email = ?, plan_mode_default = ?, sync_profile_to_schedules = ?, updated_at = ? WHERE id = ?",
    ).run(
      body.username?.toLowerCase() ?? user.username,
      body.email ?? user.email,
      body.plan_mode_default ? 1 : 0,
      body.sync_profile_to_schedules ? 1 : 0,
      nowIso(),
      user.id,
    );
    return c.json({ ok: true });
  });

  // ── settings ──
  app.get("/api/settings", (c) => {
    const rows = db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const r of rows) if (ALLOWED_KEYS.has(r.key)) settings[r.key] = r.value;
    if (!("max_agent_concurrency" in settings)) settings.max_agent_concurrency = "2";
    if (!("default_schedule_timezone" in settings)) settings.default_schedule_timezone = serverTimezone();
    if (!("task_retention_days" in settings)) settings.task_retention_days = String(DEFAULT_TASK_RETENTION_DAYS);
    if (!("telemetry_enabled" in settings)) settings.telemetry_enabled = "true";
    if (!("browser_headless" in settings)) settings.browser_headless = "false";
    if (!("skills_auto_sync_enabled" in settings)) settings.skills_auto_sync_enabled = SKILLS_AUTO_SYNC_DEFAULT;
    // env 变量选择退出要反映到前端读到的值（app_settings.py:122），前端才不会
    // 在后端静默时初始化自己的 PostHog。
    if (telemetry.disabledViaEnv()) settings.telemetry_enabled = "false";
    settings.max_upload_size = String(MAX_UPLOAD_SIZE);
    // install_id 供前端 PostHog 复用同一 distinct_id（app_settings.py:129）
    const installId = telemetry.getInstallId();
    if (installId) settings.install_id = installId;
    return c.json(settings);
  });

  app.put("/api/settings", async (c) => {
    requireAdmin(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const upsert = db.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const accepted: [string, string][] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(key)) continue; // 未知键静默忽略
      let normalized: string;
      if (BOOL_KEYS.has(key)) {
        normalized = value === true || value === "true" || value === 1 || value === "1" ? "true" : "false";
      } else if (key in INT_RANGES) {
        const n = Number.parseInt(String(value), 10);
        if (Number.isNaN(n)) continue;
        const [lo, hi] = INT_RANGES[key]!;
        normalized = String(Math.min(hi, Math.max(lo, n)));
      } else if (key === "default_schedule_phase_mode") {
        if (!USER_SELECTABLE_PHASE_MODES.has(String(value))) continue;
        normalized = String(value);
      } else {
        normalized = String(value);
      }
      accepted.push([key, normalized]);
      upsert.run(key, normalized);
    }
    // 顺序红线（PRD §3.2 / 原 app_settings.py:213-218）：写库后先重读
    // telemetry_enabled 行更新 db_disabled 缓存，再发 setting_changed——
    // 否则 false→true 重新启用的那次事件本身会被门控拦掉。
    if ("telemetry_enabled" in body) {
      const row = getSetting(db, "telemetry_enabled");
      telemetry.setDbDisabled(row === "false");
    }
    // 每个接受的 key 一条事件，值按 _bucket_setting_value 分桶
    for (const [key, value] of accepted) {
      telemetry.send(TelemetryEvent.SETTING_CHANGED, { key, to_value: bucketSettingValue(key, value) });
    }
    return c.json({ ok: true });
  });

  // ── Google Workspace 集成（批次 4.6 收回 4.1 遗留；gws_integration.py 语义） ──
  const readGwsEnabled = (): boolean => getSetting(db, "google_workspace_enabled") === "true";
  const writeGwsEnabled = (enabled: boolean): void => {
    const value = enabled ? "true" : "false";
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('google_workspace_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  };

  app.get("/api/settings/google-workspace/status", async (c) => {
    getCurrentUser(c, auth); // 任意已认证角色：响应不泄漏秘密
    const status = await gws.checkStatus();
    return c.json({
      binary: status.binary,
      auth: status.auth,
      auth_reason: status.auth_reason,
      version: status.version,
      detail: status.detail,
      enabled: readGwsEnabled(),
      installed: gws.isInstalled(config.homeDir),
    });
  });

  app.post("/api/settings/google-workspace/enable", async (c) => {
    const user = getCurrentUser(c, auth);
    if (user.role !== "admin") throw new HttpError(403, "Admin access required");
    const status = await gws.checkStatus();
    if (!status.binary) {
      throw new HttpError(400, "gws binary not found on PATH. Install from https://github.com/googleworkspace/cli/releases");
    }
    if (!status.auth) {
      throw new HttpError(400, "gws is installed but not authenticated. Run 'gws auth login' in a terminal.");
    }
    let result: { installed: boolean; count: number; subskills: string[] };
    try {
      result = await gws.installSkills(config.homeDir);
    } catch (e) {
      console.error("[vibe-server] gws install failed");
      throw new HttpError(500, `gws install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    skillsSync.markGwsInstalled(true);
    writeGwsEnabled(true);
    // 原 app_settings.py:334：技能装完才发 enabled（success/count 分桶）
    telemetry.send(TelemetryEvent.INTEGRATION_GWS_ENABLED, {
      success: Boolean(result.installed),
      skill_count_bucket: telemetry.countBucket(Number(result.count) || 0),
    });
    return c.json({ ok: true, installed: result.installed, count: result.count, subskills: result.subskills });
  });

  app.post("/api/settings/google-workspace/disable", async (c) => {
    const user = getCurrentUser(c, auth);
    if (user.role !== "admin") throw new HttpError(403, "Admin access required");
    const result = await gws.uninstallSkills(config.homeDir);
    skillsSync.markGwsInstalled(false);
    writeGwsEnabled(false);
    telemetry.send(TelemetryEvent.INTEGRATION_GWS_DISABLED, {});
    return c.json({ ok: true, removed: result.removed });
  });

  // ── users（admin） ──
  app.get("/api/users", (c) => {
    requireAdmin(c, auth);
    const rows = db.prepare("SELECT * FROM users ORDER BY created_at").all() as unknown as UserRow[];
    return c.json(rows.map(userResponse));
  });

  app.post("/api/users", async (c) => {
    requireAdmin(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; email?: string; password?: string; role?: string };
    if (!body.username || !body.password) throw new HttpError(422, "username and password required");
    const username = body.username.toLowerCase();
    // 原 users.py create_user：跨列唯一性检查在 INSERT 前做，冲突恒 400
    //（'Username already in use' / 'Email already in use'）——批次 4.7.2 录制
    // 回放对齐（此前 TS 误用 409，原实现只有 email-accounts 复用才是 409）。
    const dupUser = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (dupUser) throw new HttpError(400, "Username already in use");
    if (body.email) {
      const dupEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(body.email);
      if (dupEmail) throw new HttpError(400, "Email already in use");
    }
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") throw new HttpError(400, "Invalid role");
    const id = crypto.randomUUID();
    const now = nowIso();
    const role = body.role ?? "member";
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, is_active, avatar_url,
                          plan_mode_default, debug_mode, default_profile_id, sync_profile_to_schedules,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, 0, 0, 'default', 0, ?, ?)`,
    ).run(id, username, body.email ?? null, hashPassword(body.password), role, now, now);
    // 原 users.py:74：commit 后发
    telemetry.send(TelemetryEvent.ADMIN_USER_CREATED, { role });
    return c.json(userResponse(getUserById(db, id)!));
  });

  app.put("/api/users/:user_id", async (c) => {
    requireAdmin(c, auth);
    const userId = c.req.param("user_id");
    const target = getUserById(db, userId);
    if (!target) throw new HttpError(404, "User not found");
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      email?: string;
      password?: string;
      role?: string;
      is_active?: boolean;
    };
    db.prepare(
      "UPDATE users SET username = ?, email = ?, password_hash = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?",
    ).run(
      body.username?.toLowerCase() ?? target.username,
      body.email ?? target.email,
      body.password ? hashPassword(body.password) : target.password_hash,
      body.role ?? target.role,
      body.is_active === undefined ? target.is_active : body.is_active ? 1 : 0,
      nowIso(),
      userId,
    );
    return c.json(userResponse(getUserById(db, userId)!));
  });

  app.delete("/api/users/:user_id", (c) => {
    requireAdmin(c, auth);
    const userId = c.req.param("user_id");
    // 原 users.py delete_user 判定树（批次 4.7.2 录制回放对齐）：先 404
    // 'User not found'，再 ai_bot 400 'Cannot delete AI bot user'，再自删
    // 400 'Cannot delete yourself'。此前的"幂等删除/系统用户"语义是 TS 侧自创。
    const target = getUserById(db, userId);
    if (!target) throw new HttpError(404, "User not found");
    if (target.role === "ai_bot") throw new HttpError(400, "Cannot delete AI bot user");
    if (userId === DEFAULT_USER_ID) throw new HttpError(400, "Cannot delete yourself");
    // 原 delete_user：删除前取角色；事件面对齐"存在才发"。
    const deletedRole = target.role;
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    if (deletedRole) telemetry.send(TelemetryEvent.ADMIN_USER_DELETED, { role: deletedRole });
    return c.json({ ok: true });
  });

  // ── telemetry ──
  // 原 routers/telemetry.py：免认证（i18n 在登录前启动）；白名单 {en,zh} 否则
  // 'unknown'；返回恒 {'ok': True, 'locale': locale}。
  // 契约对齐（批次 4.7.2 录制回放发现，修正 4.7.1 的"截断"预裁决）：原实现
  // LocalePayload 用 pydantic max_length=16，>16 字符 → FastAPI RequestValidationError
  // 422 {"detail":[{type:'string_too_long',loc:['body','locale'],msg,input,ctx}]}。
  // TS 侧按同一形状返回（录制 fixture traffic.jsonl / locale_too_long_422 步钉死）。
  app.post("/api/telemetry/locale", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { locale?: string };
    const raw = typeof body.locale === "string" ? body.locale : "";
    if (raw.length > 16) {
      return c.json(
        {
          detail: [
            {
              type: "string_too_long",
              loc: ["body", "locale"],
              msg: "String should have at most 16 characters",
              input: raw,
              ctx: { max_length: 16 },
            },
          ],
        },
        422,
      );
    }
    const locale = raw === "en" || raw === "zh" ? raw : "unknown";
    telemetry.setAppLocale(locale);
    return c.json({ ok: true, locale });
  });

  // ── SSE（免认证广播；data: 一行 JSON，30s ping，与原契约一致） ──
  app.get("/api/sse", (c) => {
    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        unsubscribe = bus.subscribe({ write: (chunk) => controller.enqueue(encoder.encode(chunk)) });
      },
      cancel() {
        unsubscribe?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  // ── 批次 4.2/4.3：stores + tasks CRUD + agent 编排；4.4：调度；4.5：workspace/profiles/assistant ──
  const engineFactory = deps.engineFactory ?? defaultEngineFactory(process.env, config);
  const orchestrator = new TaskOrchestrator({
    config,
    db,
    bus,
    engineFactory,
    maxConcurrent: deps.maxConcurrent,
  });
  // ── 批次 4.5：workspace + profiles + assistant ──
  const workspace = new WorkspaceManager(config.homeDir);
  const knowledgeSync = new KnowledgeSyncManager({ homeDir: config.homeDir, db });
  const skillsSync = new SkillsSyncManager({ homeDir: config.homeDir, db });
  const assistant = new WorkspaceAssistantManager({ config, bus, engineFactory });

  // ── 批次 4.2/4.3：stores + tasks CRUD + agent 编排；4.4：调度 ──
  // （workspace 先建：store create 的档案脚手架走 createStoreProfile，
  //   原 routers/stores.py:125 create_store_profile。）
  registerTaskRoutes(app, { config, db, auth, bus, orchestrator, createStoreProfile: workspace.createStoreProfile.bind(workspace) });
  const schedulerDeps = { config, db, bus, orchestrator, jwtSecret };
  const scheduler = new VibeScheduler(schedulerDeps);
  registerScheduleRoutes(app, { ...schedulerDeps, auth, scheduler });

  registerWorkspaceRoutes(app, { config, db, auth, bus, workspace, knowledgeSync, skillsSync, assistant });
  registerProfilesRoutes(app, { db, auth, manager: new ProfileManager(ProfileManager.defaultPath(config.homeDir)) });

  // ── 批次 4.6：外围端点 ──
  registerEmailRoutes(app, { config, db, auth, jwtSecret });
  registerChannelRoutes(app, { config, db, auth, bus });
  registerWecomRoutes(app, { config, db, auth });
  registerEventRoutes(app, { config, db, auth, bus });
  registerDidaRoutes(app, { config, db, auth, jwtSecret });
  registerZiniaoRoutes(app, { config, db, auth, jwtSecret });
  const starter = deps.starter ?? new BrowserStarter({ config, db });
  registerBrowserRoutes(app, { config, db, auth, jwtSecret, starter });
  registerVisionRoutes(app, { config, db, auth, bus });
  registerAttachmentRoutes(app, { config, db, auth });
  if (deps.runScheduler) {
    starter.cleanupStaleSessions();
    const bootResult = startScheduler(schedulerDeps, { scheduler, browserSweeper: starter });
    console.log(`[vibe-server] scheduler started: ${bootResult.systemJobIds.length} system jobs, ${bootResult.rebuilt} schedules rebuilt, recovered=${bootResult.recovered.resumed} queued / ${bootResult.recovered.marked} marked`);
  }
  if (deps.bootSync) {
    // 冷却门控（24h + 远端提交变化 / skills 另受 settings 开关）；失败只告警
    void knowledgeSync.checkAndSyncRemote().catch((e) => console.warn(`[vibe-server] knowledge boot sync failed: ${e instanceof Error ? e.message : e}`));
    void skillsSync.checkAndSyncRemote().catch((e) => console.warn(`[vibe-server] skills boot sync failed: ${e instanceof Error ? e.message : e}`));
  }

  // ── SPA 静态托管（非 /api 前缀 404 回 index.html） ──
  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return c.json({ detail: "Not Found" }, 404);
    if (!config.frontendDist) return c.json({ detail: "Not Found" }, 404);
    const rel = normalize(path).replace(/^([/\\])+/, "");
    // 前缀守卫两侧都经 resolve 归一：FRONTEND_DIST 以正斜杠传入（跨平台脚本
    // 常见写法）时 join() 产出反斜杠路径，直接 startsWith 会全部失配 → 资产
    // 请求落到 index.html（text/html），模块脚本被浏览器拒载、页面白屏。
    // （批次 4.7 前端 e2e 发现；spa.test.ts 为回归钉子。）
    const distRoot = resolve(config.frontendDist);
    const candidate = resolve(distRoot, rel);
    if ((candidate === distRoot || candidate.startsWith(distRoot + sep)) && existsSync(candidate)) {
      try {
        const body = await readFile(candidate);
        return c.body(new Uint8Array(body), 200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" });
      } catch {
        /* 落到 index.html */
      }
    }
    const index = join(config.frontendDist, "index.html");
    if (existsSync(index)) {
      return c.body(new Uint8Array(await readFile(index)), 200, { "content-type": "text/html; charset=utf-8" });
    }
    return c.json({ detail: "Not Found" }, 404);
  });

  return app;
}
