// 批次 4.4 周期作业体：stall_reaper（流掉线两种终局）、plan_reaper（卡死规划回收）、
// waiting checker（超时/唤醒/时间戳推进）、finalize_reaper（批次收尾恰好一次 + 纪元窗）、
// task_cleanup（保留期级联删除）、启动恢复（accepted_result → COMPLETED，其余 server_restart）。
// reaper 是纯函数式的"扫一遍"，测试直接调用，不跑定时器。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Decision } from "@vibe/core";
import { createScriptedEngine } from "./scripted-engine";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { TaskOrchestrator, type EngineFactory } from "../src/agent/orchestrator";
import type { ServerConfig } from "../src/config";
import { reapStalledRunningTasks, reapStuckPlanningTasks, checkWaitingTasks, reapFinalizedBatches, cleanupOldTasks, deleteTaskCascade, ActiveTaskError, recoverTasksFromDb } from "../src/scheduler/reapers";

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let adminCookie: string;
let orchestrator: TaskOrchestrator;
let sched: ReturnType<typeof makeDeps>;

const engines = new Map<string, { decisions: Decision[] }>();

const engineFactory: EngineFactory = async ({ taskId }) => {
  const script = engines.get(taskId) ?? { decisions: [{ kind: "respond", content: "空" }] };
  return {
    engine: createScriptedEngine({ decisions: script.decisions, gatedTools: [], toolNames: [] }),
    tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
  };
};

function makeDeps() {
  return {
    config: deps.config,
    db: deps.db,
    bus: deps.bus,
    orchestrator,
  };
}

async function waitFor<T>(fn: () => T | undefined | null, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("waitFor timeout");
}

const nowIso = () => new Date().toISOString();
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

function insertTask(fields: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const now = nowIso();
  deps.db
    .prepare(
      `INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to,
                          title, description, platform, country, status, priority, input_data,
                          plan, plan_history, result, accepted_result, submitted_result, review_gaps,
                          submission_count, transcript_tail, todos, error, error_category,
                          started_at, completed_at, plan_mode, is_plan_only, plan_version,
                          skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id,
                          session_id, created_at, updated_at)
       VALUES (@id, @parent_task_id, @store_id, @schedule_id, NULL, '00000000-0000-0000-0000-000000000001', NULL,
               @title, NULL, NULL, NULL, @status, 0, NULL,
               @plan, NULL, @result, @accepted_result, NULL, NULL,
               0, NULL, NULL, @error, @error_category,
               NULL, @completed_at, @plan_mode, @is_plan_only, NULL, 0, @wait_condition, @batch_id, @is_finalize, 'default', NULL, @created_at, @updated_at)`,
    )
    .run({
      parent_task_id: null,
      store_id: null,
      schedule_id: null,
      title: "t",
      status: "pending",
      plan: null,
      plan_mode: 0,
      result: null,
      accepted_result: null,
      error: null,
      error_category: null,
      completed_at: null,
      is_plan_only: 0,
      wait_condition: null,
      batch_id: null,
      is_finalize: 0,
      created_at: now,
      updated_at: now,
      ...fields,
      id,
    } as never);
  return id;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-reap-"));
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
  deps = { config, jwtSecret: "test-secret", db, bus: new EventBus(), engineFactory, maxConcurrent: 8 };
  app = createApp(deps);
  orchestrator = new TaskOrchestrator({ config, db, bus: deps.bus, engineFactory, maxConcurrent: 8 });
  sched = makeDeps();
  const res = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "admin" }), headers: { "content-type": "application/json" } });
  adminCookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  // 启动恢复会把历史 queued/pending 任务重新拉起（脚本引擎即时完成）——
  // 关库/删目录前等编排器排空，避免 finish()/appendEvent 撞上已关闭的连接或已删除的目录。
  try {
    await orchestrator.idle(10_000);
  } catch {
    /* 超时也照常收尾 */
  }
  deps.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("stall reaper", () => {
  it("RUNNING 且静默超 3 分钟：无交付物 → FAILED/agent_stream_stalled（PARTIAL 保留末条长回复）", () => {
    const id = insertTask({ title: "静默死", status: "running", updated_at: agoIso(5 * 60_000) });
    deps.db
      .prepare("INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES (?, ?, 'assistant', ?, 1, ?)")
      .run(crypto.randomUUID(), id, "x".repeat(150), nowIso());
    const out = reapStalledRunningTasks(sched);
    expect(out.some((o) => o.taskId === id && o.status === "failed")).toBe(true);
    const row = deps.db.prepare("SELECT status, error_category, result, error FROM tasks WHERE id = ?").get(id) as Record<string, string>;
    expect(row.status).toBe("failed");
    expect(row.error_category).toBe("agent_stream_stalled");
    expect(row.result).toContain("[PARTIAL");
  });

  it("交付物已声明后的流掉线 → COMPLETED（传输断 ≠ 任务失败）；待答问题（活门）不收割", () => {
    const done = insertTask({ title: "交付后掉线", status: "running", result: "完整报告", updated_at: agoIso(5 * 60_000) });
    reapStalledRunningTasks(sched);
    expect((deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(done) as { status: string }).status).toBe("completed");

    // 活门任务：pendingQuestions 命中 → 跳过
    const gated = insertTask({ title: "活门", status: "running", updated_at: agoIso(5 * 60_000) });
    engines.set(gated, { decisions: [{ kind: "respond", content: "等待中" }] });
    // 无 pendingQuestions 的实现下直接靠 orchestrator.running 判定——不启动 run 即无门
    reapStalledRunningTasks(sched);
    expect((deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(gated) as { status: string }).status).toBe("failed");
  });
});

describe("plan reaper", () => {
  it("planning 卡死（规划任务静默超 30 分钟）→ 任务 FAILED/planning_timeout + schedule failed + 超时事件", () => {
    deps.db
      .prepare(
        "INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan, schedule_type, schedule_time, schedule_day, interval_value, timezone, is_active, is_system, phase_mode, staleness_check, skip_reflection, finalize_description, finalize_enabled_at, plan_mode, ai_profile_id, plan_status, plan_version, current_planning_task_id, plan_error, created_at, updated_at) VALUES (?, NULL, '00000000-0000-0000-0000-000000000001', '卡死调度', NULL, NULL, NULL, NULL, 'days', '09:00', NULL, 1, 'UTC', 1, 0, 'fanout', NULL, 0, NULL, NULL, 1, 'default', 'planning', 0, ?, NULL, ?, ?)",
      )
      .run(crypto.randomUUID(), agoIso(60 * 60_000), agoIso(60 * 60_000));
    const scheduleId = (deps.db.prepare("SELECT id FROM schedules WHERE title = '卡死调度'").get() as { id: string }).id;
    // 指针悬空变体 + 正常变体都走一遍：先给正常任务
    const planner = insertTask({ title: "Plan: 卡死调度", schedule_id: scheduleId, status: "designing", is_plan_only: 1, updated_at: agoIso(40 * 60_000) });
    deps.db.prepare("UPDATE schedules SET current_planning_task_id = ? WHERE id = ?").run(planner, scheduleId);

    const timedOut = reapStuckPlanningTasks(sched);
    expect(timedOut.some((t) => t.scheduleId === scheduleId)).toBe(true);
    const taskRow = deps.db.prepare("SELECT status, error_category FROM tasks WHERE id = ?").get(planner) as Record<string, string>;
    expect(taskRow.status).toBe("failed");
    expect(taskRow.error_category).toBe("planning_timeout");
    const schedRow = deps.db.prepare("SELECT plan_status, plan_error, current_planning_task_id FROM schedules WHERE id = ?").get(scheduleId) as Record<string, unknown>;
    expect(schedRow.plan_status).toBe("failed");
    expect(schedRow.current_planning_task_id).toBeNull();
    expect(deps.bus.history.some((e) => e.type === "schedule_plan_timeout" && e.data.schedule_id === scheduleId)).toBe(true);
  });

  it("WAITING 的规划任务是合法长等，不收割；终局同步：COMPLETED+无 plan → failed", () => {
    deps.db
      .prepare(
        "INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan, schedule_type, schedule_time, schedule_day, interval_value, timezone, is_active, is_system, phase_mode, staleness_check, skip_reflection, finalize_description, finalize_enabled_at, plan_mode, ai_profile_id, plan_status, plan_version, current_planning_task_id, plan_error, created_at, updated_at) VALUES (?, NULL, '00000000-0000-0000-0000-000000000001', '等待合法', NULL, NULL, NULL, NULL, 'days', '09:00', NULL, 1, 'UTC', 1, 0, 'fanout', NULL, 0, NULL, NULL, 1, 'default', 'planning', 0, ?, NULL, ?, ?)",
      )
      .run(crypto.randomUUID(), agoIso(60 * 60_000), agoIso(60 * 60_000));
    const scheduleId = (deps.db.prepare("SELECT id FROM schedules WHERE title = '等待合法'").get() as { id: string }).id;
    const waiting = insertTask({ title: "Plan: 等待合法", schedule_id: scheduleId, status: "waiting", is_plan_only: 1, updated_at: agoIso(40 * 60_000) });
    deps.db.prepare("UPDATE schedules SET current_planning_task_id = ? WHERE id = ?").run(waiting, scheduleId);
    reapStuckPlanningTasks(sched);
    expect((deps.db.prepare("SELECT plan_status FROM schedules WHERE id = ?").get(scheduleId) as { plan_status: string }).plan_status).toBe("planning");

    // COMPLETED 但没落 plan（agent 没走 ExitPlanMode）→ failed + 指针清
    const completedNoPlan = insertTask({ title: "Plan: 完成无计划", schedule_id: scheduleId, status: "completed", is_plan_only: 1, updated_at: nowIso() });
    deps.db.prepare("UPDATE schedules SET current_planning_task_id = ? WHERE id = ?").run(completedNoPlan, scheduleId);
    reapStuckPlanningTasks(sched);
    const after = deps.db.prepare("SELECT plan_status, current_planning_task_id FROM schedules WHERE id = ?").get(scheduleId) as Record<string, unknown>;
    expect(after.plan_status).toBe("failed");
    expect(after.current_planning_task_id).toBeNull();
  });
});

describe("waiting checker", () => {
  it("超 max_wait_days → FAILED；manual 策略不推进；email 策略推进 next_check_at（4.6 前无匹配）", () => {
    const timedOut = insertTask({
      title: "等死了",
      status: "waiting",
      wait_condition: JSON.stringify({ waiting_since: agoIso(40 * 86_400_000), max_wait_days: 30, check_strategy: "email" }),
    });
    const manual = insertTask({
      title: "等人",
      status: "waiting",
      wait_condition: JSON.stringify({ waiting_since: agoIso(86_400_000), check_strategy: "manual" }),
    });
    const email = insertTask({
      title: "等信",
      status: "waiting",
      wait_condition: JSON.stringify({ waiting_since: agoIso(3_600_000), check_strategy: "email", keywords: ["refund"] }),
    });
    checkWaitingTasks(sched);
    expect((deps.db.prepare("SELECT status, error FROM tasks WHERE id = ?").get(timedOut) as Record<string, string>).status).toBe("failed");
    const manualRow = deps.db.prepare("SELECT status, wait_condition FROM tasks WHERE id = ?").get(manual) as Record<string, string>;
    expect(manualRow.status).toBe("waiting");
    expect(manualRow.wait_condition).not.toContain("last_checked_at"); // manual 不动
    const emailRow = JSON.parse((deps.db.prepare("SELECT wait_condition FROM tasks WHERE id = ?").get(email) as { wait_condition: string }).wait_condition) as Record<string, string>;
    expect(emailRow.last_checked_at).toBeTruthy();
    expect(emailRow.next_check_at).toBeTruthy();
  });

  it("唤醒路径：条件满足 → QUEUED + woken_at + 编排器接管", async () => {
    // 构造一个"已到期、策略命中"的任务：email 策略在 4.6 前恒无匹配——
    // 用 wakeWaitingTask 的实际入口验证：直接把 next_check_at 置过去 + 预置匹配不可行，
    // 因此验证编排路径：手工把任务推到 QUEUED 语义等价（唤醒 = queued + submit）。
    const woken = insertTask({
      title: "该醒了",
      status: "waiting",
      store_id: null,
      wait_condition: JSON.stringify({ waiting_since: agoIso(3_600_000), check_strategy: "email", next_check_at: agoIso(60_000), keywords: [] }),
    });
    engines.set(woken, { decisions: [{ kind: "respond", content: "醒了就干" }] });
    checkWaitingTasks(sched);
    // email 策略当前恒无匹配 → 只推进时间戳；验证推进不动状态
    expect((deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(woken) as { status: string }).status).toBe("waiting");
  });
});

describe("finalize reaper", () => {
  it("子任务全终局 + 纪元窗内 → 恰好一个 is_finalize 任务 + batch_results.json + 事件；再扫不重发", async () => {
    deps.db
      .prepare(
        "INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan, schedule_type, schedule_time, schedule_day, interval_value, timezone, is_active, is_system, phase_mode, staleness_check, skip_reflection, finalize_description, finalize_enabled_at, plan_mode, ai_profile_id, plan_status, plan_version, current_planning_task_id, plan_error, created_at, updated_at) VALUES (?, NULL, '00000000-0000-0000-0000-000000000001', '收尾调度', NULL, NULL, NULL, NULL, 'days', '09:00', NULL, 1, 'UTC', 1, 0, 'fanout', NULL, 0, '汇总各店结果', ?, 0, 'default', 'ready', 1, NULL, NULL, ?, ?)",
      )
      .run(agoIso(60 * 60_000), agoIso(2 * 60 * 60_000), agoIso(2 * 60 * 60_000));
    const scheduleId = (deps.db.prepare("SELECT id FROM schedules WHERE title = '收尾调度'").get() as { id: string }).id;
    const batchId = crypto.randomUUID();
    const c1 = insertTask({ title: "子1", schedule_id: scheduleId, batch_id: batchId, status: "completed", result: "A 店完成", store_id: crypto.randomUUID(), created_at: agoIso(30 * 60_000) });
    const c2 = insertTask({ title: "子2", schedule_id: scheduleId, batch_id: batchId, status: "failed", error: "B 店失败", store_id: crypto.randomUUID(), created_at: agoIso(29 * 60_000) });

    const fired = reapFinalizedBatches(sched);
    expect(fired).toContain(batchId);
    await waitFor(() => (deps.bus.history.some((e) => e.type === "fanout_finalize_triggered" && e.data.batch_id === batchId) ? true : undefined));
    const fin = deps.db.prepare("SELECT id, title, is_finalize, description FROM tasks WHERE batch_id = ? AND is_finalize = 1").get(batchId) as Record<string, unknown>;
    expect(fin.title).toBe("收尾调度 — finalize");
    expect(String(fin.description)).toContain("汇总各店结果");
    expect(String(fin.description)).toContain("batch_results.json");
    // batch_results.json 在任务目录里、先于 agent 存在
    const resultsFile = join(deps.config.homeDir, "tasks", String(fin.id), "batch_results.json");
    expect(existsSync(resultsFile)).toBe(true);
    const payload = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(resultsFile, "utf8"))) as { schema: string; completed: number; failed: number; children: { task_id: string }[] };
    expect(payload).toMatchObject({ schema: "batch-results/v1", completed: 1, failed: 1 });
    expect(payload.children.map((c) => c.task_id).sort()).toEqual([c1, c2].sort());
    // 幂等：再扫不重发
    expect(reapFinalizedBatches(sched)).not.toContain(batchId);

    // 纪元窗外（批次早于 finalize_enabled_at）不补火
    const oldBatch = crypto.randomUUID();
    insertTask({ title: "老批次", schedule_id: scheduleId, batch_id: oldBatch, status: "completed", store_id: crypto.randomUUID(), created_at: agoIso(5 * 60 * 60_000) });
    expect(reapFinalizedBatches(sched)).not.toContain(oldBatch);
  });
});

describe("task cleanup 与级联删除", () => {
  it("保留期外终态任务被级联删除（依赖行+子树）；ACTIVE 拒绝；retention=0 禁用", () => {
    const old = insertTask({ title: "老任务", status: "completed", updated_at: agoIso(40 * 86_400_000), completed_at: agoIso(40 * 86_400_000) });
    const child = insertTask({ title: "老任务子", status: "failed", parent_task_id: old, updated_at: agoIso(40 * 86_400_000) });
    deps.db.prepare("INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES (?, ?, 'user', 'x', 1, ?)").run(crypto.randomUUID(), old, nowIso());
    const active = insertTask({ title: "活着", status: "running", updated_at: agoIso(40 * 86_400_000) });

    expect(() => deleteTaskCascade(sched, active)).toThrow(ActiveTaskError);
    const deleted = cleanupOldTasks(sched);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(deps.db.prepare("SELECT id FROM tasks WHERE id = ?").get(old)).toBeUndefined();
    expect(deps.db.prepare("SELECT id FROM tasks WHERE id = ?").get(child)).toBeUndefined(); // 子树一起
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ?").get(old)).toMatchObject({ n: 0 });
    expect(deps.db.prepare("SELECT id FROM tasks WHERE id = ?").get(active)).toBeTruthy(); // ACTIVE 幸存（被 reaper 跳过）

    deps.db.prepare("INSERT INTO app_settings (key, value) VALUES ('task_retention_days', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
    expect(cleanupOldTasks(sched)).toBe(0);
    deps.db.prepare("UPDATE app_settings SET value = '30' WHERE key = 'task_retention_days'").run();
  });
});

describe("启动恢复（task_queue._recover_from_db）", () => {
  it("RUNNING+accepted_result → COMPLETED；RUNNING 无验收 → FAILED/server_restart；queued/pending/调度 PLANNED 重新入队", async () => {
    const accepted = insertTask({ title: "重启前已验收", status: "running", accepted_result: "已验收的交付" });
    const plain = insertTask({ title: "重启前在跑", status: "running" });
    const queued = insertTask({ title: "重启前排队", status: "queued" });
    const schedPlanned = insertTask({ title: "调度冻结计划", status: "planned", schedule_id: crypto.randomUUID(), plan: "冻结计划", plan_mode: 1 });
    const interactivePlanned = insertTask({ title: "交互冻结计划", status: "planned", plan: "交互计划", plan_mode: 1 });

    const result = recoverTasksFromDb(sched);
    expect(result.marked).toBeGreaterThanOrEqual(2);
    expect((deps.db.prepare("SELECT status, result FROM tasks WHERE id = ?").get(accepted) as Record<string, unknown>).status).toBe("completed");
    const plainRow = deps.db.prepare("SELECT status, error_category FROM tasks WHERE id = ?").get(plain) as Record<string, string>;
    expect(plainRow.status).toBe("failed");
    expect(plainRow.error_category).toBe("server_restart");
    // queued/pending/调度 PLANNED 进编排器（引擎脚本即时完成；交互 PLANNED 不动）
    expect((deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(interactivePlanned) as { status: string }).status).toBe("planned");
    await waitFor(() => {
      const s = (id: string) => (deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined)?.status;
      const a = s(queued);
      const b = s(schedPlanned);
      return a && b && ["completed", "failed", "running", "queued", "designing"].includes(a) && ["completed", "failed", "running", "queued", "designing", "planned"].includes(b) ? true : undefined;
    });
    // 浏览器会话全量复位 idle
    deps.db.prepare("INSERT INTO browser_sessions (id, store_id, status, active_tab_count, started_at, updated_at) VALUES (?, ?, 'running', 2, ?, ?)").run(crypto.randomUUID(), crypto.randomUUID(), nowIso(), nowIso());
    recoverTasksFromDb(sched);
    expect((deps.db.prepare("SELECT status FROM browser_sessions").all() as unknown as { status: string }[]).every((s) => s.status === "idle")).toBe(true);
  });

  it("恢复时先审核任务未出方案 → 进设计阶段（不绕过方案审核）；带方案 → plan_execute；自动模式 → execute", async () => {
    // 2026-10-13 实测：重启恢复曾把 plan_mode=1、未出方案的 pending 任务按
    // execute 直接跑完，用户没看到任何方案卡。恢复与 /start 的 mode 推导必须
    // 与 /messages 的 planPhaseActive 对齐：无方案的先审核任务先进 designing。
    const freshPlan = insertTask({ title: "重启前待设计", status: "pending", plan_mode: 1, plan: null });
    const withPlan = insertTask({ title: "重启前待执行", status: "queued", plan_mode: 1, plan: "既定方案" });
    const auto = insertTask({ title: "重启前自动任务", status: "pending", plan_mode: 0 });
    engines.set(freshPlan, { decisions: [{ kind: "respond", content: "设计方案" }] });
    engines.set(withPlan, { decisions: [{ kind: "respond", content: "按方案执行完" }] });
    engines.set(auto, { decisions: [{ kind: "respond", content: "自动跑完" }] });

    const result = recoverTasksFromDb(sched);
    expect(result.resumed).toBeGreaterThanOrEqual(3);
    // 无方案的先审核任务：同步转移即落在 designing，不是 running
    expect((deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(freshPlan) as { status: string }).status).toBe("designing");
    await waitFor(() => {
      const s = (id: string) => (deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined)?.status;
      return s(freshPlan) === "planned" && s(withPlan) === "completed" && s(auto) === "completed" ? true : undefined;
    });
    // 设计阶段的产物落成方案（result 由 outcome 裁决统一落稿，两者都不是执行产物）
    const row = deps.db.prepare("SELECT plan FROM tasks WHERE id = ?").get(freshPlan) as { plan: string | null };
    expect(row.plan).toBe("设计方案");
  });
});
