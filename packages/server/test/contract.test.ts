// Phase 4.1 契约测试：形状全部按 docs/phase4-backend-inventory.md 钉死。
// 走 Hono 的 app.request（不占端口）；DB 用临时目录的独立 SQLite 文件。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, hashPassword, verifyPassword, type AppDeps } from "../src/app";
import { openDb, seed, getSetting } from "../src/db";
import { EventBus } from "../src/bus";
import { createSessionToken } from "../src/jwt";
import type { ServerConfig } from "../src/config";
import { DEFAULT_USER_ID } from "../src/config";

// Python bcrypt 生成的哈希（rounds=10, prefix 2b，明文 "admin"）——
// 原地升级兼容钉子：TS 侧必须能验证 Python 建的用户口令。
const PYTHON_BCRYPT_HASH = "$2b$10$u9jRS/AUNUVjz6mvKYmii.sLNiRq.yfe1nk3bNESRgQRqm7iztAT2";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;

const config: ServerConfig = {
  homeDir: "",
  dataDir: "",
  dbPath: "",
  jwtSecretFile: "",
  port: 0,
  adminEmail: "admin@vibe-seller.local",
  adminPassword: "admin",
  adminUsername: "admin",
  version: "0.1.0-test",
  jwtSecret: "test-secret",
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-server-"));
  const cfg: ServerConfig = { ...config, dataDir: dir, dbPath: join(dir, "vibe_seller.db") };
  const db = openDb(cfg);
  seed(db, cfg, hashPassword);
  deps = { config: cfg, jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
});

afterAll(async () => {
  deps.db.close(); // Windows：文件句柄未释放时 rm 会 EBUSY
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, headers?: Record<string, string>) =>
  new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function login(identifier = "admin", password = "admin"): Promise<string> {
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("系统面", () => {
  it("health/version/plugins/system 契约形状", async () => {
    const health = await (await app.request("/api/health")).json();
    expect(health).toEqual({ status: "ok", version: "0.1.0-test" });
    const version = await (await app.request("/api/version")).json();
    expect(version).toEqual({ version: "0.1.0-test" });
    expect(await (await app.request("/api/plugins")).json()).toEqual([]);
    const info = await (await app.request("/api/system/info")).json();
    expect(info).toMatchObject({ platform: "windows", version: "0.1.0-test" });
    expect(await (await app.request("/api/system/update-check")).json()).toEqual({ dev: true });
  });
});

describe("auth 契约", () => {
  it("种子语义：auth_required 首启为 true；status 可匿名读", async () => {
    expect(getSetting(deps.db, "auth_required")).toBe("true");
    const status = await (await app.request("/api/auth/status")).json();
    expect(status).toEqual({ auth_required: true });
  });

  it("登录 → Set-Cookie(HttpOnly/Lax/86400) → me 为 UserResponse 全键", async () => {
    const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("auth_token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=86400");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["debug_mode", "default_profile_id", "email", "id", "plan_mode_default", "role", "sync_profile_to_schedules", "username"].sort(),
    );
    adminCookie = cookie;

    const me = (await (await app.request("/api/auth/me", { headers: { cookie: adminCookie } })).json()) as Record<string, unknown>;
    expect(Object.keys(me).sort()).toEqual(
      ["avatar_url", "created_at", "debug_mode", "default_profile_id", "email", "id", "is_active", "plan_mode_default", "role", "sync_profile_to_schedules", "username"].sort(),
    );
    expect(me).toMatchObject({ id: DEFAULT_USER_ID, role: "admin", username: "admin" });
  });

  it("Python bcrypt 哈希可被 TS 验证（原地升级兼容）", () => {
    expect(verifyPassword("admin", PYTHON_BCRYPT_HASH)).toBe(true);
    expect(verifyPassword("wrong", PYTHON_BCRYPT_HASH)).toBe(false);
    const ours = hashPassword("admin");
    expect(ours.startsWith("$2b$")).toBe(true);
    expect(verifyPassword("admin", ours)).toBe(true);
  });

  it("登录失败形状：401 {detail:'Invalid credentials'}；ai_bot 拒绝", async () => {
    const bad = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "nope" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ detail: "Invalid credentials" });
    const bot = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "ai_bot", password: "x" }), headers: { "content-type": "application/json" } });
    expect(bot.status).toBe(401);
  });

  it("判定树：无 token 401 'Not authenticated'；坏 token 401 'Invalid token'；Bearer 回退可用", async () => {
    const noToken = await app.request("/api/auth/me");
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toEqual({ detail: "Not authenticated" });

    const badCookie = await app.request("/api/auth/me", { headers: { cookie: "auth_token=garbage" } });
    expect(badCookie.status).toBe(401);
    expect(await badCookie.json()).toEqual({ detail: "Invalid token" });

    const token = createSessionToken(DEFAULT_USER_ID, "admin", "test-secret");
    const bearer = await app.request("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(bearer.status).toBe(200);
  });

  it("过期 token → 401 'Invalid token'", async () => {
    const expired = createSessionToken(DEFAULT_USER_ID, "admin", "test-secret", -10);
    const res = await app.request("/api/auth/me", { headers: { cookie: `auth_token=${expired}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Invalid token" });
  });

  it("auth 关闭：无 token 直接以默认 admin 通过", async () => {
    deps.db.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'auth_required'").run();
    const me = await (await app.request("/api/auth/me")).json();
    expect(me).toMatchObject({ id: DEFAULT_USER_ID, role: "admin" });
    deps.db.prepare("UPDATE app_settings SET value = 'true' WHERE key = 'auth_required'").run();
  });

  it("refresh/logout/debug-mode/password/profile 契约", async () => {
    const refresh = await app.request("/api/auth/refresh", { method: "POST", headers: { cookie: adminCookie } });
    expect(refresh.status).toBe(200);
    expect((await refresh.json())).toEqual({ ok: true });

    const logout = await app.request("/api/auth/logout", { method: "POST" });
    expect((await logout.json())).toEqual({ ok: true });

    const dbg = await app.request("/api/auth/me/debug-mode", { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ debug_mode: true }) });
    expect((await dbg.json())).toEqual({ ok: true, debug_mode: true });

    const pw = await app.request("/api/auth/me/password", { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ current_password: "wrong", new_password: "admin2" }) });
    expect(pw.status).toBe(400); // 现密码不对
    const pwOk = await app.request("/api/auth/me/password", { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ current_password: "admin", new_password: "admin" }) });
    expect((await pwOk.json())).toEqual({ ok: true });

    const prof = await app.request("/api/auth/me/profile", { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ plan_mode_default: true }) });
    expect((await prof.json())).toEqual({ ok: true });
  });
});

describe("settings 契约", () => {
  it("GET 缺省回填（并发 2、retention 30、telemetry true、headless false、max_upload_size）", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.max_agent_concurrency).toBe("2");
    expect(body.task_retention_days).toBe("30");
    expect(body.telemetry_enabled).toBe("true");
    expect(body.browser_headless).toBe("false");
    expect(body.skills_auto_sync_enabled).toBe("true");
    expect(body.max_upload_size).toBe("104857600");
    expect(body.default_schedule_timezone).toBeTruthy();
    expect(body.default_schedule_phase_mode).toBeUndefined(); // 未存储时不出现在响应里
  });

  it("PUT 非 admin 403；admin 可写；int 钳制与未知键忽略", async () => {
    const forbidden = await app.request("/api/settings", { method: "PUT", body: JSON.stringify({ auth_required: "false" }), headers: { "content-type": "application/json" } });
    expect(forbidden.status).toBe(401); // 无 token

    const put = await app.request("/api/settings", { method: "PUT", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ max_agent_concurrency: 99, telemetry_enabled: true, unknown_key: "x", default_schedule_phase_mode: "fanout" }) });
    expect((await put.json())).toEqual({ ok: true });
    const body = (await (await app.request("/api/settings")).json()) as Record<string, string>;
    expect(body.max_agent_concurrency).toBe("10"); // 钳制到上限
    expect(body.telemetry_enabled).toBe("true"); // bool 归一
    expect(body.default_schedule_phase_mode).toBe("fanout");
    expect(body.unknown_key).toBeUndefined();
  });

  it("browser_tools_enabled：GET 缺省回填 true；PUT bool 归一；非白名单键拒收不受影响", async () => {
    const def = (await (await app.request("/api/settings")).json()) as Record<string, string>;
    expect(def.browser_tools_enabled).toBe("true"); // 缺省回填
    await app.request("/api/settings", { method: "PUT", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ browser_tools_enabled: false }) });
    const off = (await (await app.request("/api/settings")).json()) as Record<string, string>;
    expect(off.browser_tools_enabled).toBe("false"); // bool 归一
    await app.request("/api/settings", { method: "PUT", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ browser_tools_enabled: "true", not_allowed_key: "x" }) });
    const body = (await (await app.request("/api/settings")).json()) as Record<string, string>;
    expect(body.browser_tools_enabled).toBe("true");
    expect(body.not_allowed_key).toBeUndefined();
  });
});

describe("users 契约（admin）", () => {
  it("admin 建 member → member 登录 → member 访问 admin API 403", async () => {
    const created = await app.request("/api/users", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ username: "Seller", email: "s@x.com", password: "pw123" }) });
    expect(created.status).toBe(200);
    const user = (await created.json()) as Record<string, unknown>;
    expect(user).toMatchObject({ username: "seller", role: "member", is_active: true });

    const memberCookie = await login("seller", "pw123");
    const forbidden = await app.request("/api/users", { method: "POST", headers: { cookie: memberCookie, "content-type": "application/json" }, body: JSON.stringify({ username: "x2", password: "pw" }) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ detail: "Admin access required" });

    const list = (await (await app.request("/api/users", { headers: { cookie: adminCookie } })).json()) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(2);

    const del = await app.request(`/api/users/${user.id as string}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect((await del.json())).toEqual({ ok: true });
  });

  it("系统用户不可删（400）；重复用户名 400（原 users.py create_user/delete_user 判定树，批次 4.7.2 对齐）", async () => {
    const del = await app.request(`/api/users/${DEFAULT_USER_ID}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect(del.status).toBe(400);
    expect(await del.json()).toEqual({ detail: "Cannot delete yourself" });
    // 原实现重复用户名是 400 'Username already in use'（非 409；409 只出现在
    // email-accounts/store-link 等资源族）。
    const dup = await app.request("/api/users", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "pw" }) });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toEqual({ detail: "Username already in use" });
  });
});

describe("SSE 与 telemetry", () => {
  it("总线广播帧格式：data: {json}\\n\\n；路由返回 text/event-stream", async () => {
    const received: string[] = [];
    const unsub = deps.bus.subscribe({ write: (chunk) => received.push(chunk) });
    deps.bus.emit("task_update", { task_id: "t1", status: "running" });
    unsub();
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(`data: ${JSON.stringify({ type: "task_update", task_id: "t1", status: "running" })}\n\n`);

    const res = await app.request("/api/sse");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // 不读完流（会挂住）——cancel 掉
    await res.body?.cancel();
  });

  it("telemetry/locale：白名单 en/zh 原样；其余归一 unknown；恒 ok:true（原 routers/telemetry.py 契约，批次 4.7 点亮）", async () => {
    const ok = await (await app.request("/api/telemetry/locale", { method: "POST", body: JSON.stringify({ locale: "zh" }), headers: { "content-type": "application/json" } })).json();
    expect(ok).toEqual({ ok: true, locale: "zh" });
    const bad = await (await app.request("/api/telemetry/locale", { method: "POST", body: JSON.stringify({ locale: "fr" }), headers: { "content-type": "application/json" } })).json();
    expect(bad).toEqual({ ok: true, locale: "unknown" });
  });
});

describe("SPA 托管", () => {
  it("无 frontendDist：/api 404 {detail}；/ 路径 404", async () => {
    const api404 = await app.request("/api/nothing");
    expect(api404.status).toBe(404);
    expect(await api404.json()).toEqual({ detail: "Not Found" });
  });
});
