// 批次 4.5 profiles 契约测试：默认种子、CRUD、set-default（含排程联动）、
// validate 探针（本地 http 假端点）、presets 目录、UI profiles.json → pi profile 派生。

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { ProfileManager } from "../src/profiles/manager";
import { DEFAULT_PROFILE_ID } from "../src/profiles/presets";
import type { ServerConfig } from "../src/config";
import { DEFAULT_USER_ID } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let cookie: string;
let httpServer: Server;
let httpPort = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-prof-"));
  const config: ServerConfig = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  const db = openDb(config);
  seed(db, config, hashPassword);
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  // validate 探针假端点：probeUrl 会在基址后拼 /v1/messages
  httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.includes("/ok")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "glm-5.2", content: [] }));
    } else if (url.pathname.includes("/authz")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  httpPort = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  deps.db.close();
  await new Promise<void>((done) => httpServer.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});

const req = (path: string, init?: RequestInit) =>
  app.request(path, { ...init, headers: { cookie, ...(init?.headers as Record<string, string> | undefined) } });
const post = (path: string, body?: unknown) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const put = (path: string, body: unknown) => req(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string) => req(path, { method: "PATCH" });
const del = (path: string) => req(path, { method: "DELETE" });

const GLM_ENV = {
  ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
  ANTHROPIC_MODEL: "glm-5.2[1m]",
  ANTHROPIC_AUTH_TOKEN: "sk-test-glm",
};

describe("profiles CRUD 契约", () => {
  it("首启只有 default（Claude）档", async () => {
    const res = await req("/api/profiles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: Record<string, unknown>[] };
    expect(body.profiles).toEqual([
      { id: "default", name: "Claude", description: "System default configuration", env: {}, load_global_mcp: false },
    ]);
  });

  it("create → 落盘原格式 profiles.json；缺 id/name → 400（KeyError 同形）", async () => {
    const res = await post("/api/profiles", { id: "glm", name: "GLM", env: GLM_ENV, description: "zhi pu" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "glm", name: "GLM", env: GLM_ENV, load_global_mcp: false });
    const file = JSON.parse(readFileSync(join(dir, "profiles.json"), "utf8")) as { profiles: Record<string, { env: Record<string, string> }> };
    expect(file.profiles.glm!.env).toEqual(GLM_ENV);

    const noId = await post("/api/profiles", { name: "x" });
    expect(noId.status).toBe(400);
    expect(await noId.json()).toEqual({ detail: "'id'" });
    const noName = await post("/api/profiles", { id: "x2" });
    expect(noName.status).toBe(400);
    expect(await noName.json()).toEqual({ detail: "'name'" });
  });

  it("update：未知 400；存在则合并", async () => {
    const missing = await put("/api/profiles/nope", { description: "x" });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { detail: string }).detail).toBe("Profile nope not found");
    const ok = await put("/api/profiles/glm", { description: "updated desc" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: "glm", description: "updated desc", name: "GLM" });
  });

  it("delete：default 拒绝 400；缺失幂等 ok；删当前默认回落 default", async () => {
    expect((await del("/api/profiles/default")).status).toBe(400);
    expect((await post("/api/profiles", { id: "tmp", name: "T" })).status).toBe(200);
    await patch("/api/profiles/tmp/set-default");
    expect(((await (await req("/api/auth/me")).json()) as { default_profile_id: string }).default_profile_id).toBe("tmp");
    expect(await (await del("/api/profiles/tmp")).json()).toEqual({ ok: true });
    expect(((await (await req("/api/auth/me")).json()) as { default_profile_id: string }).default_profile_id).toBe(DEFAULT_PROFILE_ID);
    // 缺失档案 delete → 幂等 ok（原实现 pop 缺键不报错）
    expect(await (await del("/api/profiles/ghost")).json()).toEqual({ ok: true });
  });
});

describe("set-default 与排程联动", () => {
  beforeAll(async () => {
    // 排程行：本用户钉 deepseek 的、本用户 'default' 的、他人钉 glm 的
    const ins = deps.db.prepare(
      "INSERT INTO schedules (id, created_by, title, schedule_type, schedule_time, timezone, plan_version, ai_profile_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    );
    ins.run("sch-1", DEFAULT_USER_ID, "t1", "daily", "0 9 * * *", "UTC", "deepseek");
    ins.run("sch-2", DEFAULT_USER_ID, "t2", "daily", "0 9 * * *", "UTC", DEFAULT_PROFILE_ID);
    ins.run("sch-3", "other-user-0001", "t3", "daily", "0 9 * * *", "UTC", "glm");
  });

  it("未知 profile → 404；opt-in 时仅迁移本用户钉了具体档的排程", async () => {
    expect((await patch("/api/profiles/ghost/set-default")).status).toBe(404);
    // 未 opt-in：schedules_synced 恒 0
    await req("/api/auth/me/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sync_profile_to_schedules: false }) });
    const r1 = (await (await patch("/api/profiles/glm/set-default")).json()) as Record<string, unknown>;
    expect(r1).toEqual({ ok: true, default_profile_id: "glm", schedules_synced: 0 });
    // opt-in 后：只迁移本用户的 deepseek 行；'default' 行与他人排程不动
    await req("/api/auth/me/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sync_profile_to_schedules: true }) });
    const r2 = (await (await patch("/api/profiles/glm/set-default")).json()) as Record<string, unknown>;
    expect(r2).toEqual({ ok: true, default_profile_id: "glm", schedules_synced: 1 });
    const rows = deps.db.prepare("SELECT id, ai_profile_id FROM schedules WHERE id IN ('sch-1','sch-2','sch-3')").all() as { id: string; ai_profile_id: string | null }[];
    expect(rows.find((r) => r.id === "sch-1")!.ai_profile_id).toBe("glm");
    expect(rows.find((r) => r.id === "sch-2")!.ai_profile_id).toBe(DEFAULT_PROFILE_ID);
    expect(rows.find((r) => r.id === "sch-3")!.ai_profile_id).toBe("glm");
  });
});

describe("validate 探针", () => {
  it("no_endpoint / placeholder / missing_key / missing_model 均无网络即判", async () => {
    expect(await (await post("/api/profiles/validate", {})).json()).toEqual({ ok: true, code: "no_endpoint", error: "", reported_model: null });
    const ph = (await (await post("/api/profiles/validate", { env: { ANTHROPIC_BASE_URL: "https://{WorkspaceId}.maas.aliyuncs.com/apps/anthropic", ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_MODEL: "m" } })).json()) as Record<string, unknown>;
    expect(ph).toMatchObject({ ok: false, code: "placeholder" });
    const mk = (await (await post("/api/profiles/validate", { env: { ANTHROPIC_BASE_URL: "https://x.example" } })).json()) as Record<string, unknown>;
    expect(mk).toMatchObject({ ok: false, code: "missing_key" });
    const mm = (await (await post("/api/profiles/validate", { env: { ANTHROPIC_BASE_URL: "https://x.example", ANTHROPIC_AUTH_TOKEN: "k" } })).json()) as Record<string, unknown>;
    expect(mm).toMatchObject({ ok: false, code: "missing_model" });
  });

  it("真端点形状：200 message → ok+reported_model；401 → auth；[1m] 后缀剥离", async () => {
    const ok = (await (await post("/api/profiles/validate", {
      env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${httpPort}/ok`, ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_MODEL: "glm-5.2[1m]" },
    })).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, reported_model: "glm-5.2" });

    const auth = (await (await post("/api/profiles/validate", {
      env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${httpPort}/authz`, ANTHROPIC_AUTH_TOKEN: "bad", ANTHROPIC_MODEL: "m" },
    })).json()) as Record<string, unknown>;
    expect(auth).toMatchObject({ ok: false, code: "auth" });
  });
});

describe("presets 目录", () => {
  it("预设带 models 下拉选项；qwen_intl 保留 {WorkspaceId} 占位", async () => {
    const body = (await (await req("/api/profiles/presets")).json()) as {
      presets: Record<string, { name: string; env: Record<string, string>; models: { id: string }[] }>;
    };
    expect(body.presets.kimi!.name).toBe("Kimi");
    expect(body.presets.kimi!.models[0]!.id).toBe("k3[1m]");
    expect(body.presets.qwen_intl!.env.ANTHROPIC_BASE_URL).toContain("{WorkspaceId}");
    expect(body.presets.deepseek!.models).toHaveLength(2);
  });
});

describe("UI profiles.json → pi profile 派生（引擎接缝）", () => {
  it("剥 [1m]、放大上下文、内存携带密钥；default 恒 undefined", () => {
    const pm = new ProfileManager(join(dir, "profiles.json"));
    expect(pm.deriveVibeProfile(DEFAULT_PROFILE_ID)).toBeUndefined();
    const derived = pm.deriveVibeProfile("glm")!;
    expect(derived).toMatchObject({
      profileId: "glm",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      model: "glm-5.2",
      apiKey: "sk-test-glm",
      contextWindow: 1_000_000,
    });
    expect(pm.deriveVibeProfile("ghost")).toBeUndefined();
  });
});
