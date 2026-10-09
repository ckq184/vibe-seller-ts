// 批次 4.7.1 telemetry 事件面：PRD §3.3 表格每个事件一条
// "触发点 → transport 收到正确事件名与 properties" 测试。
// transport 注入假捕获（__test.enable）；agent 用脚本引擎（零网络）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Decision } from "@vibe/core";
import { gatePolicyFor } from "@vibe/bridge";
import { createScriptedEngine } from "./scripted-engine";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { ProfileManager } from "../src/profiles/manager";
import { runFanoutJob, runSingleJob, type SchedulerDeps } from "../src/scheduler/fire";
import { TaskOrchestrator } from "../src/agent/orchestrator";
import { ensureZiniaoRunning } from "../src/browser/ziniao";
import * as telemetry from "../src/telemetry/core";
import { TelemetryEvent } from "../src/telemetry/events";
import type { EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";

// gws enable 端点依赖外部 `gws` CLI——mock 掉预检与安装（disable 走真 uninstallSkills 纯 fs）。
vi.mock("../src/workspace/gws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workspace/gws")>();
  return {
    ...actual,
    checkStatus: async () => ({ binary: true, auth: true, auth_reason: null, version: "mock", detail: {} }),
    installSkills: async () => ({ installed: true, count: 3, subskills: ["sheets"] }),
  };
});

const HAPPY_WITH_TOOL: Decision[] = [
  { kind: "call_tool", intent: { name: "vibe_seller_list_stores", arguments: {} } },
  { kind: "respond", content: "完成" },
];

const engines = new Map<string, { decisions: Decision[]; fail?: boolean }>();

const engineFactory: EngineFactory = async ({ taskId }) => {
  if (engines.get(taskId)?.fail) throw new Error("no api key");
  const script = engines.get(taskId) ?? { decisions: [{ kind: "respond", content: "空脚本" as const }] };
  return {
    engine: createScriptedEngine({ decisions: script.decisions, gatedTools: [], toolNames: ["vibe_seller_list_stores"] }),
    tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
    gates: gatePolicyFor([]),
  };
};

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;
let captured: { event: string; properties: Record<string, unknown> }[] = [];

async function waitFor<T>(fn: () => T | undefined | null, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("waitFor timeout");
}

beforeAll(async () => {
  // 事件面要求 send 生效：清掉环境禁用（runner 门控只拦 init()，不拦 __test.enable 注入）。
  delete process.env.VIBE_SELLER_TELEMETRY;
  telemetry.__test.enable(captured, "events-install-id");

  dir = await mkdtemp(join(tmpdir(), "vibe-telemetry-events-"));
  const config: ServerConfig = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "vibe_seller.db"),
    jwtSecretFile: join(dir, "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  const db = openDb(config);
  seed(db, config, hashPassword);
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus(), engineFactory, maxConcurrent: 4 };
  app = createApp(deps);
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  adminCookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  // 在飞 run（fire/唤醒的脚本引擎异步收尾）排水后再关库，避免 "database is not open" 噪声
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = deps.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running','queued','designing')").get() as { n: number };
    if (row.n === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  deps.db.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const patch = (path: string, body?: unknown) =>
  app.request(path, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const del = (path: string) => app.request(path, { method: "DELETE", headers: { cookie: adminCookie } });

const eventsOf = (name: string) => captured.filter((c) => c.event === name);

/** base properties 键面（send 会把它合入每个事件；PRD §6.2 预裁决集）。 */
const BASE_KEYS = ["app_locale", "app_version", "is_docker", "node_version", "os", "os_release"].sort();

async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = (await (await post("/api/tasks", { title, ...extra })).json()) as { id: string };
  return created.id;
}

async function createStore(name: string): Promise<string> {
  const created = (await (await post("/api/stores", { name, browser_backend: "chrome", platforms: ["amazon"], countries: ["US"] })).json()) as { id: string };
  return created.id;
}

/** fire 测试用编排器：真 TaskOrchestrator（脚本引擎，提交后立即终局，零网络）。 */
function fireOrchestrator(): TaskOrchestrator {
  return new TaskOrchestrator({ config: deps.config, db: deps.db, bus: deps.bus, engineFactory, maxConcurrent: 4 });
}

function fireDeps(): SchedulerDeps {
  return { config: deps.config, db: deps.db, bus: deps.bus, orchestrator: fireOrchestrator(), jwtSecret: "test-secret" };
}

// ── 事件面 ──

describe("事件面：store_created / store_deleted", () => {
  it("POST /api/stores commit 后发 store_created（首店 is_first_store=true）", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const id = await createStore("遥测店A");
    const evt = eventsOf(TelemetryEvent.STORE_CREATED).at(-1)!;
    expect(evt).toBeDefined();
    expect(evt.properties).toMatchObject({
      browser_backend: "chrome",
      platform_count: 1,
      country_count: 1,
      is_first_store: true,
    });
    // 第二家：is_first_store=false
    await createStore("遥测店B");
    expect(eventsOf(TelemetryEvent.STORE_CREATED).at(-1)!.properties).toMatchObject({ is_first_store: false });
    void id;
  });

  it("DELETE /api/stores：计数快照在级联删除前；age_bucket 来自 created_at", async () => {
    const storeId = await createStore("遥测店C");
    await createTask("店任务", { store_id: storeId });
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const res = await del(`/api/stores/${storeId}`);
    expect(await res.json()).toEqual({ ok: true });
    const evt = eventsOf(TelemetryEvent.STORE_DELETED).at(-1)!;
    expect(evt.properties).toMatchObject({
      browser_backend: "chrome",
      task_count_at_deletion_bucket: "1-5",
      age_bucket: "<1d",
    });
  });
});

describe("事件面：task_created / task_completed / task_failed / task_resumed", () => {
  it("POST /api/tasks 发 task_created（plan_mode 为推导后实际值；与 SSE 总线同名不同物）", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    await createTask("无店任务", { description: "x".repeat(60) });
    const evt = eventsOf(TelemetryEvent.TASK_CREATED).at(-1)!;
    expect(evt.properties).toMatchObject({
      is_store_task: false,
      plan_mode: true, // 无店任务强制 plan_mode
      has_schedule: false,
      has_parent: false,
      ai_profile_kind: "default",
      description_length_bucket: "50-200",
      created_by_role: "admin",
    });
  });

  it("orchestrator 终局 COMPLETED 发 task_completed（tool_use 统计 + 静默降级）", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const taskId = await createTask("完成流");
    engines.set(taskId, { decisions: HAPPY_WITH_TOOL });
    await post(`/api/tasks/${taskId}/start`);
    await waitFor(() => {
      const row = deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
      return row && ["completed", "failed"].includes(row.status) ? row.status : undefined;
    });
    const evt = eventsOf(TelemetryEvent.TASK_COMPLETED).at(-1)!;
    expect(evt.properties).toMatchObject({
      is_store_task: false,
      was_planned: true,
      is_scheduled: false,
      ai_profile_kind: "default",
      tool_use_count: 1,
      tool_use_count_bucket: "1-5",
      skills_used: [],
    });
    expect(["<30s", "30s-2m"]).toContain(evt.properties["duration_bucket"]);
    expect(typeof evt.properties["duration_seconds"]).toBe("number");
  });

  it("orchestrator 引擎工厂失败 → task_failed phase=pre_running，error_category 优先 DB 字段", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const taskId = await createTask("失败流");
    engines.set(taskId, { decisions: [], fail: true });
    await post(`/api/tasks/${taskId}/start`);
    await waitFor(() => {
      const row = deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
      return row?.status === "failed" ? row.status : undefined;
    });
    const evt = eventsOf(TelemetryEvent.TASK_FAILED).at(-1)!;
    expect(evt.properties).toMatchObject({
      is_store_task: false,
      phase: "pre_running",
      error_category: "engine_factory_failed", // DB 字段优先于兜底 category
      is_scheduled: false,
      ai_profile_kind: "default",
    });
  });

  it("唤醒入口发 task_resumed（原实现硬编码字符串；wait_duration 来自 wait_condition）", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const taskId = await createTask("等待流");
    const waitingSince = new Date(Date.now() - 130_000).toISOString(); // 130s → 2m-10m
    deps.db
      .prepare("UPDATE tasks SET status = 'waiting', wait_condition = ? WHERE id = ?")
      .run(JSON.stringify({ check_strategy: "email_reply", waiting_since: waitingSince, reason: "waiting for response" }), taskId);
    engines.set(taskId, { decisions: [{ kind: "respond", content: "续跑完成" }] });
    await post(`/api/tasks/${taskId}/wake`);
    const evt = eventsOf("task_resumed").at(-1)!;
    expect(evt).toBeDefined();
    expect(evt.properties).toMatchObject({
      is_store_task: false,
      wait_duration_bucket: "2m-10m",
      wake_reason: "email_reply",
      ai_profile_kind: "default",
    });
  });
});

describe("事件面：schedule_fired", () => {
  function insertSchedule(opts: { title: string; scheduleType: string; phaseMode: string | null; staleness?: string | null; planMode?: number; planStatus?: string }): string {
    const id = crypto.randomUUID();
    deps.db
      .prepare(
        `INSERT INTO schedules (id, store_id, created_by, title, description, schedule_type, schedule_time, schedule_day,
                                interval_value, timezone, is_active, is_system, phase_mode, staleness_check, skip_reflection,
                                plan_mode, plan_status, plan_version, created_at, updated_at)
         VALUES (?, NULL, '00000000-0000-0000-0000-000000000001', ?, NULL, ?, '2099-01-01T00:00:00', NULL,
                 NULL, 'UTC', 1, 0, ?, ?, 0, ?, ?, 0, datetime('now'), datetime('now'))`,
      )
      .run(id, opts.title, opts.scheduleType, opts.phaseMode, opts.staleness ?? null, opts.planMode ?? 0, opts.planStatus ?? null);
    return id;
  }

  it("fanout fire 实际建任务前发 schedule_fired（目标数分桶 + is_catalog）；跳过的火不发", async () => {
    await createStore("扇出店1");
    await createStore("扇出店2");
    const schedId = insertSchedule({ title: "扇出", scheduleType: "daily", phaseMode: "fanout", staleness: "catalog" });
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const storeCount = (deps.db.prepare("SELECT COUNT(*) AS n FROM stores").get() as { n: number }).n;
    const result = runFanoutJob(fireDeps(), { scheduleId: schedId, taskTitle: "扇出任务" });
    expect(result).toMatchObject({ created: storeCount });
    const evt = eventsOf(TelemetryEvent.SCHEDULE_FIRED).at(-1)!;
    expect(evt.properties).toMatchObject({
      schedule_type: "daily",
      phase_mode: "fanout",
      fanout_target_count_bucket: "1-5",
      is_catalog: true,
    });

    // plan 未就绪的调度跳过 → 不发
    const notReady = insertSchedule({ title: "未就绪", scheduleType: "daily", phaseMode: "fanout", planMode: 1, planStatus: "planning" });
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    runFanoutJob(fireDeps(), { scheduleId: notReady, taskTitle: "x" });
    expect(eventsOf(TelemetryEvent.SCHEDULE_FIRED)).toHaveLength(0);
  });

  it("single fire 发 schedule_fired（phase_mode='single'、目标数恒 0、is_catalog=false）", async () => {
    const schedId = insertSchedule({ title: "单发", scheduleType: "daily", phaseMode: "single" });
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    runSingleJob(fireDeps(), { scheduleId: schedId, taskTitle: "单发任务" });
    const evt = eventsOf(TelemetryEvent.SCHEDULE_FIRED).at(-1)!;
    expect(evt.properties).toMatchObject({
      schedule_type: "daily",
      phase_mode: "single",
      fanout_target_count_bucket: "0",
      is_catalog: false,
    });
  });
});

describe("事件面：user_pref_changed", () => {
  it("PATCH /api/auth/me/debug-mode 发 user_pref_changed", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const res = await patch("/api/auth/me/debug-mode", { debug_mode: true });
    expect(await res.json()).toEqual({ ok: true, debug_mode: true });
    const evt = eventsOf(TelemetryEvent.USER_PREF_CHANGED).at(-1)!;
    expect(evt.properties).toMatchObject({ key: "debug_mode", to_value: true });
  });

  it("PATCH /api/auth/me/profile：plan_mode_default / sync_profile_to_schedules 变更分支各一条；未变更不发", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    await patch("/api/auth/me/profile", { plan_mode_default: true });
    expect(eventsOf(TelemetryEvent.USER_PREF_CHANGED).map((e) => e.properties)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "plan_mode_default", to_value: true })]),
    );
    // 未变更不发：同值连打（注：TS 侧 PATCH 既有语义是无条件回写全字段——
    // 仅 sync 的 PATCH 会把 plan 重置回 0，故同字段的"未变更"断言须紧邻）
    await patch("/api/auth/me/profile", { plan_mode_default: true });
    expect(eventsOf(TelemetryEvent.USER_PREF_CHANGED).filter((e) => e.properties["key"] === "plan_mode_default")).toHaveLength(1);

    await patch("/api/auth/me/profile", { sync_profile_to_schedules: true });
    expect(eventsOf(TelemetryEvent.USER_PREF_CHANGED).filter((e) => e.properties["key"] === "sync_profile_to_schedules")).toHaveLength(1);
    await patch("/api/auth/me/profile", { sync_profile_to_schedules: true });
    expect(eventsOf(TelemetryEvent.USER_PREF_CHANGED).filter((e) => e.properties["key"] === "sync_profile_to_schedules")).toHaveLength(1);
  });
});

describe("事件面：ai_profile_created / default_set / deleted", () => {
  it("POST /api/profiles → created（provider_kind + is_first_profile + has_global_mcp）；set-default → default_set（不含 schedules_synced）；DELETE → deleted", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const manager = new ProfileManager(ProfileManager.defaultPath(dir));
    expect(manager.listProfiles().length).toBeLessThanOrEqual(1); // 只有 default → is_first_profile=true
    const res = await post("/api/profiles", { id: "telemetry-p1", name: "P1", env: { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" }, load_global_mcp: true });
    expect(res.status).toBe(200);
    expect(eventsOf(TelemetryEvent.AI_PROFILE_CREATED).at(-1)!.properties).toMatchObject({
      provider_kind: "kimi",
      is_first_profile: true,
      has_global_mcp: true,
    });

    await patch("/api/profiles/telemetry-p1/set-default");
    expect(eventsOf(TelemetryEvent.AI_PROFILE_DEFAULT_SET).at(-1)!.properties).toMatchObject({ provider_kind: "kimi" });

    await del("/api/profiles/telemetry-p1");
    expect(eventsOf(TelemetryEvent.AI_PROFILE_DELETED).at(-1)!.properties).toMatchObject({ provider_kind: "kimi" });
  });
});

describe("事件面：email_account_added / removed", () => {
  it("POST /api/email-accounts → added（provider_kind/has_smtp/use_ssl）；DELETE → removed({})", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const res = await post("/api/email-accounts", { email: "telemetry@gmail.com", password: "pw", imap_host: "imap.gmail.com", smtp_host: "smtp.gmail.com", use_ssl: true });
    expect(res.status).toBe(200);
    expect(eventsOf(TelemetryEvent.EMAIL_ACCOUNT_ADDED).at(-1)!.properties).toMatchObject({
      provider_kind: "gmail",
      has_smtp: true,
      use_ssl: true,
    });
    const accountId = (await (await app.request("/api/email-accounts", { headers: { cookie: adminCookie } })).json() as { id: string }[])[0]!.id;
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    await del(`/api/email-accounts/${accountId}`);
    // caller properties 为 {}：合并后只剩 base keys（原 EMAIL_ACCOUNT_REMOVED 语义）
    expect(Object.keys(eventsOf(TelemetryEvent.EMAIL_ACCOUNT_REMOVED).at(-1)!.properties).sort()).toEqual(BASE_KEYS);
  });
});

describe("事件面：ziniao_account_added / removed", () => {
  it("POST /api/ziniao-accounts → added（account_count_after_bucket）；DELETE → removed({})（仅账号存在才发）", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const res = await post("/api/ziniao-accounts", { name: "n", company: "c", username: "u", password: "p" });
    expect(res.status).toBe(200);
    expect(eventsOf(TelemetryEvent.ZINIAO_ACCOUNT_ADDED).at(-1)!.properties).toMatchObject({ account_count_after_bucket: "1-5" });
    const account = (await res.json()) as { id: string };
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    await del(`/api/ziniao-accounts/${account.id}`);
    expect(eventsOf(TelemetryEvent.ZINIAO_ACCOUNT_REMOVED)).toHaveLength(1);
    // 不存在的账号：幂等 ok，但不发事件
    await del("/api/ziniao-accounts/not-exists");
    expect(eventsOf(TelemetryEvent.ZINIAO_ACCOUNT_REMOVED)).toHaveLength(1);
  });
});

describe("事件面：integration_gws_enabled / disabled", () => {
  it("gws enable（技能装完才发）→ {success, skill_count_bucket}；disable → {}", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const enable = await post("/api/settings/google-workspace/enable");
    expect(await enable.json()).toMatchObject({ ok: true });
    expect(eventsOf(TelemetryEvent.INTEGRATION_GWS_ENABLED).at(-1)!.properties).toMatchObject({ success: true, skill_count_bucket: "1-5" });

    await post("/api/settings/google-workspace/disable");
    expect(Object.keys(eventsOf(TelemetryEvent.INTEGRATION_GWS_DISABLED).at(-1)!.properties).sort()).toEqual(BASE_KEYS);
  });
});

describe("事件面：admin_user_created / deleted", () => {
  it("users POST commit 后发 created；DELETE 角色删除前取 → deleted", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    const res = await post("/api/users", { username: "telemetryu", password: "pw", role: "member" });
    const user = (await res.json()) as { id: string };
    expect(eventsOf(TelemetryEvent.ADMIN_USER_CREATED).at(-1)!.properties).toMatchObject({ role: "member" });

    await del(`/api/users/${user.id}`);
    expect(eventsOf(TelemetryEvent.ADMIN_USER_DELETED).at(-1)!.properties).toMatchObject({ role: "member" });
  });
});

describe("事件面：browser_session_attempted / started / failed", () => {
  const userInfo = { company: "c", username: "u", password: "p" };
  const fakeOk = async () => new Response(JSON.stringify({ statusCode: "0" }), { headers: { "content-type": "application/json" } });
  const fakeDown = async () => {
    throw new TypeError("connection refused");
  };

  it("探测连通即成功（statusCode≠0 也算）→ attempted(attempt_number=1) + started(attempts_to_success=1, auto_launched=false)", async () => {
    captured.length = 0; // 就地清空（stub 客户端持有同一数组引用，不可重新赋值）
    await expect(ensureZiniaoRunning(16851, "ziniao", userInfo, fakeOk)).resolves.toBe(true);
    expect(eventsOf(TelemetryEvent.BROWSER_SESSION_ATTEMPTED)).toHaveLength(1);
    expect(eventsOf(TelemetryEvent.BROWSER_SESSION_ATTEMPTED)[0]!.properties).toMatchObject({
      backend: "ziniao",
      os: telemetry.runtimeOs(),
      attempt_number: 1,
    });
    expect(eventsOf(TelemetryEvent.BROWSER_SESSION_STARTED)[0]!.properties).toMatchObject({
      backend: "ziniao",
      os: telemetry.runtimeOs(),
      attempts_to_success: 1,
      auto_launched: false,
    });
  });

  it("拉起失败 → failed（error_category='launch_failed'，attempts_total=1）", async () => {
    // 仅 win32 可确定性触发 launch_failed（找不到 ziniao.exe）；其余平台跳过
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }
    const saved = { ...process.env };
    try {
      const empty = await mkdtemp(join(tmpdir(), "vibe-no-ziniao-"));
      process.env["ProgramFiles"] = empty;
      process.env["ProgramFiles(x86)"] = empty;
      process.env["LOCALAPPDATA"] = empty;
      captured.length = 0; // 就地清空
      await expect(ensureZiniaoRunning(16851, "ziniao-not-installed", userInfo, fakeDown)).rejects.toThrow(/Could not find ziniao\.exe/);
      const evt = eventsOf(TelemetryEvent.BROWSER_SESSION_FAILED)[0]!;
      expect(evt.properties).toMatchObject({
        backend: "ziniao",
        os: "windows",
        attempts_total: 1,
        error_category: "launch_failed",
      });
      await rm(empty, { recursive: true, force: true });
    } finally {
      process.env = saved;
    }
  });
});
