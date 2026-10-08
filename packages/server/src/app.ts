// 路由装配：Hono app，FastAPI 契约对齐。批次 4.1 面：
// health/version/plugins/system + auth(8) + settings(GET/PUT) + users(4) + telemetry/locale + sse + SPA。
// 错误形状恒为 {"detail": "..."}（FastAPI HTTPException 契约，前端按此解析）。

import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import bcrypt from "bcryptjs";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config";
import { AI_BOT_USER_ID, DEFAULT_USER_ID } from "./config";
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
    db.prepare("UPDATE users SET debug_mode = ?, updated_at = ? WHERE id = ?").run(body.debug_mode ? 1 : 0, nowIso(), user.id);
    return c.json({ ok: true, debug_mode: Boolean(body.debug_mode) });
  });

  app.patch("/api/auth/me/password", async (c) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { current_password?: string; new_password?: string };
    if (!body.new_password) throw new HttpError(422, "new_password required");
    if (body.current_password !== undefined && user.password_hash !== "disabled" && !verifyPassword(body.current_password, user.password_hash)) {
      throw new HttpError(400, "Current password is incorrect");
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
    settings.max_upload_size = String(MAX_UPLOAD_SIZE);
    return c.json(settings);
  });

  app.put("/api/settings", async (c) => {
    requireAdmin(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const upsert = db.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
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
      upsert.run(key, normalized);
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
    return c.json({ ok: true, installed: result.installed, count: result.count, subskills: result.subskills });
  });

  app.post("/api/settings/google-workspace/disable", async (c) => {
    const user = getCurrentUser(c, auth);
    if (user.role !== "admin") throw new HttpError(403, "Admin access required");
    const result = await gws.uninstallSkills(config.homeDir);
    skillsSync.markGwsInstalled(false);
    writeGwsEnabled(false);
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
    const exists = db
      .prepare("SELECT id FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)")
      .get(username, body.email ?? "\u0000");
    if (exists) throw new HttpError(409, "Username or email already registered");
    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, is_active, avatar_url,
                          plan_mode_default, debug_mode, default_profile_id, sync_profile_to_schedules,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, 0, 0, 'default', 0, ?, ?)`,
    ).run(id, username, body.email ?? null, hashPassword(body.password), body.role ?? "member", now, now);
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
    if (userId === DEFAULT_USER_ID || userId === AI_BOT_USER_ID) throw new HttpError(400, "Cannot delete system user");
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return c.json({ ok: true });
  });

  // ── telemetry ──
  app.post("/api/telemetry/locale", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { locale?: string };
    const locale = (body.locale ?? "").slice(0, 16);
    return c.json({ ok: locale === "en" || locale === "zh", locale });
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
  registerTaskRoutes(app, { config, db, auth, bus, orchestrator });
  const schedulerDeps = { config, db, bus, orchestrator, jwtSecret };
  const scheduler = new VibeScheduler(schedulerDeps);
  registerScheduleRoutes(app, { ...schedulerDeps, auth, scheduler });

  // ── 批次 4.5：workspace + profiles + assistant ──
  const workspace = new WorkspaceManager(config.homeDir);
  const knowledgeSync = new KnowledgeSyncManager({ homeDir: config.homeDir, db });
  const skillsSync = new SkillsSyncManager({ homeDir: config.homeDir, db });
  const assistant = new WorkspaceAssistantManager({ config, bus, engineFactory });
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
    const candidate = join(config.frontendDist, rel);
    if (candidate.startsWith(config.frontendDist) && existsSync(candidate)) {
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
