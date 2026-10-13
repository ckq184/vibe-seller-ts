// 创建即起飞契约（2026-10-13 实测事故回归钉）：POST /api/tasks 在
// defer_start !== true 时必须把 agent 拉起来。原 TS 移植把这段留成了 TODO
// （routes_tasks.ts 旧注「defer_start / 执行编排（队列→agent）留 4.3：任务停在
// pending」），而 vendor 前端钉死的契约是「无附件时由服务端负责 launch」
// （frontend/src/__tests__/submitCreateTaskAttachments.test.ts：no files →
// launches normally, no defer, no explicit start）。断链的用户可见后果：弹窗
// 按钮写着 Create & Run 实际只 Create 不 Run——任务恒 pending，
// taskStates.ts 的 pending.canSendMessage=false 让 composer 禁用、
// POST /messages 对 pending 400、UI 没有任何开始入口（生产实测：任务创建后
// 25s 内只有一次 review-plan PATCH，无 steps/messages/logs）。
// 脚本引擎 + hold 工具桩控运行时长，零网络。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Decision, ToolPort } from "@vibe/core";
import { createScriptedEngine } from "./scripted-engine";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import type { EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;

/** hold 工具桩：脚本调 "hold" 即挂起，测试 release(taskId) 放行 → 跑到 respond 终局。 */
const holdGates = new Map<string, () => void>();
const release = (taskId: string) => holdGates.get(taskId)?.();
/** 脚本按任务标题选（taskId 要等创建响应才知道，而工厂在响应返回前就被调用）。 */
const scripts = new Map<string, Decision[]>();

const HOLD: Decision[] = [
  { kind: "call_tool", intent: { name: "hold", arguments: {} } },
  { kind: "respond", content: "放行了" },
];
const SAY = (text: string): Decision[] => [{ kind: "respond", content: text }];

const engineFactory: EngineFactory = async ({ taskId }) => {
  const title = (deps.db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | undefined)?.title ?? "";
  const decisions = scripts.get(title) ?? SAY("空脚本");
  const toolPort: ToolPort = {
    execute: async (intent) => {
      if (intent.name === "hold") {
        await new Promise<void>((r) => holdGates.set(taskId, r));
        return { status: "success", result: { held: true } };
      }
      return { status: "success", result: { echo: intent.name } };
    },
  };
  return {
    engine: createScriptedEngine({ decisions, gatedTools: [], toolNames: ["hold"] }, toolPort),
    tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
  };
};

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
  dir = await mkdtemp(join(tmpdir(), "vibe-autolaunch-"));
  const config: ServerConfig = {
    homeDir: dir,
    dataDir: dir,
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

afterEach(() => {
  holdGates.clear();
  scripts.clear();
});

afterAll(async () => {
  deps.db.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const statusOf = (taskId: string): string =>
  (deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status;

/** 该任务的 task_update 状态序列（bus 按全文件累积，按 task_id 过滤）。 */
const updatesOf = (taskId: string): string[] =>
  deps.bus.history.filter((h) => h.type === "task_update" && h.data["task_id"] === taskId).map((h) => String(h.data["status"]));

const messagesOf = (taskId: string): { role: string; content: string }[] =>
  deps.db.prepare("SELECT role, content FROM task_messages WHERE task_id = ? ORDER BY seq").all(taskId) as { role: string; content: string }[];

describe("创建即起飞（defer_start 缺省/false）", () => {
  it("plan 任务（无 store）创建即进 designing 并真跑完；响应体仍是 pending 快照", async () => {
    const created = (await (await post("/api/tasks", { title: "起飞-计划" })).json()) as { id: string; status: string };
    // 响应契约不变：payload 是起飞前的行快照，起飞经 SSE task_update 跟进
    expect(created.status).toBe("pending");
    // 同步转移：task_created 之后紧跟 task_update(designing)（顺序是前端依赖的契约）
    const kinds = deps.bus.history.filter((h) => h.data["task_id"] === created.id).map((h) => h.type);
    expect(kinds.indexOf("task_created")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("task_update")).toBeGreaterThan(kinds.indexOf("task_created"));
    expect(updatesOf(created.id)[0]).toBe("designing");
    // agent 真跑了：设计模式终态是 planned（方案落库等人工确认），脚本 respond 成为方案
    await waitFor(() => (statusOf(created.id) === "planned" ? "planned" : undefined));
    expect((deps.db.prepare("SELECT plan FROM tasks WHERE id = ?").get(created.id) as { plan: string }).plan).toBe("空脚本");
    expect(updatesOf(created.id)).toContain("planned");
  });

  it("店铺任务 plan_mode=false 创建即转 running 并跑完", async () => {
    const store = (await (await post("/api/stores", { name: "起飞店" })).json()) as { id: string };
    const created = (await (await post("/api/tasks", { store_id: store.id, title: "起飞-执行", plan_mode: false })).json()) as { id: string };
    expect(updatesOf(created.id).some((s) => s === "running" || s === "queued")).toBe(true);
    await waitFor(() => (statusOf(created.id) === "completed" ? "completed" : undefined));
    expect(messagesOf(created.id).some((m) => m.role === "result" && m.content === "空脚本")).toBe(true);
  });

  it("店铺泳道：同店第二单在首个挂起期间入队 queued，放行后自动开工", async () => {
    const store = (await (await post("/api/stores", { name: "排队店" })).json()) as { id: string };
    scripts.set("挂起-甲", HOLD);
    const a = (await (await post("/api/tasks", { store_id: store.id, title: "挂起-甲", plan_mode: false })).json()) as { id: string };
    await waitFor(() => (statusOf(a.id) === "running" ? "running" : undefined));
    const b = (await (await post("/api/tasks", { store_id: store.id, title: "跟单-乙", plan_mode: false })).json()) as { id: string };
    expect(statusOf(b.id)).toBe("queued"); // 队头挂着 → 第二单排队，不拒绝不静默
    release(a.id);
    await waitFor(() => (statusOf(b.id) === "completed" ? "completed" : undefined));
    expect(statusOf(a.id)).toBe("completed");
    expect(messagesOf(a.id).some((m) => m.content === "放行了")).toBe(true);
  });
});

describe("手动 /start 的 mode 推导", () => {
  it("先审核任务未出方案 → 进设计阶段等确认，不绕过方案审核", async () => {
    // 2026-10-13 实测：/start 曾把 plan_mode=1、未出方案的任务按 execute 直接
    // 跑完（重启恢复同款推导）。修后：无方案的先审核任务先进 designing。
    const created = (await (await post("/api/tasks", { title: "手动-先审核", defer_start: true })).json()) as { id: string };
    const started = (await (await post(`/api/tasks/${created.id}/start`, {})).json()) as { ok: boolean; status: string };
    expect(started).toMatchObject({ ok: true, status: "designing" });
    await waitFor(() => (statusOf(created.id) === "planned" ? "planned" : undefined));
    expect((deps.db.prepare("SELECT plan, result FROM tasks WHERE id = ?").get(created.id) as { plan: string | null; result: string | null }).plan).toBe("空脚本");
  });

  it("先审核任务带方案 → plan_execute 直接跑完", async () => {
    const created = (await (await post("/api/tasks", { title: "手动-带方案", defer_start: true })).json()) as { id: string };
    deps.db.prepare("UPDATE tasks SET plan = ? WHERE id = ?").run("既定方案", created.id);
    const started = (await (await post(`/api/tasks/${created.id}/start`, {})).json()) as { ok: boolean; status: string };
    expect(started).toMatchObject({ ok: true, status: "running" });
    await waitFor(() => (statusOf(created.id) === "completed" ? "completed" : undefined));
  });
});

describe("不自动起飞的路径（显式 defer / 调度器 / 子任务）", () => {
  it("defer_start=true → 停在 pending，task_created 之后没有 task_update", async () => {
    const created = (await (await post("/api/tasks", { title: "不起飞-附件", defer_start: true })).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 60)); // 给任何误起飞留出窗口
    expect(statusOf(created.id)).toBe("pending");
    expect(updatesOf(created.id)).toEqual([]);
  });

  it("schedule_id 任务不自动起飞（入队由调度器 fanout 决定）", async () => {
    const scheduleId = crypto.randomUUID();
    const now = new Date().toISOString();
    deps.db.prepare(
      `INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan,
                             schedule_type, schedule_time, schedule_day, interval_value, timezone, is_active,
                             is_system, phase_mode, staleness_check, skip_reflection, finalize_description,
                             finalize_enabled_at, plan_mode, ai_profile_id, plan_status, plan_version,
                             current_planning_task_id, plan_error, created_at, updated_at)
       VALUES (?, NULL, ?, '定时源', NULL, NULL, NULL, NULL, 'days', '09:00', NULL, NULL, 'Asia/Shanghai', 1,
               0, NULL, NULL, 0, NULL, NULL, 1, 'default', 'ready', 0, NULL, NULL, ?, ?)`,
    ).run(scheduleId, "00000000-0000-0000-0000-000000000001", now, now);
    const created = (await (await post("/api/tasks", { title: "不起飞-定时", schedule_id: scheduleId })).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 60));
    expect(statusOf(created.id)).toBe("pending");
    expect(updatesOf(created.id)).toEqual([]);
  });

  it("parent_task_id 子任务不自动起飞（何时入队由编排方决定）", async () => {
    const store = (await (await post("/api/stores", { name: "父子店" })).json()) as { id: string };
    const parent = (await (await post("/api/tasks", { store_id: store.id, title: "不起飞-父", defer_start: true })).json()) as { id: string };
    const child = (await (await post("/api/tasks", { store_id: store.id, title: "不起飞-子", parent_task_id: parent.id })).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 60));
    expect(statusOf(parent.id)).toBe("pending");
    expect(statusOf(child.id)).toBe("pending");
    expect(updatesOf(child.id)).toEqual([]);
  });
});
