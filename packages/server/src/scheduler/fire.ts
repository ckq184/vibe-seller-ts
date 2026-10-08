// 调度火源（批次 4.4）：把 app/scheduler/cron.py 的 _run_task_job 与 fanout.py 的
// 三种 runner 移植到 TS 编排器。差异点（均为收敛性简化，见 docs/phase4-backend-inventory.md）：
//   - 提交走 TaskOrchestrator（per-store FIFO + 全局并发），原 TaskQueueScheduler 的
//     RUN_IN_NEW_TAB 国家冲突维度属浏览器层（4.6）——浏览器会话恒 idle 时其决策
//     退化为"恒可并发"，这里保守串行 per-store，宁排队不撞浏览器。
//   - two_phase 的 L2 前置不做 catalog staleness 检查（knowledge_sync 属 4.5 workspace）。
// 批次 4.7：schedule_fired 遥测接线（仅 fanout/single——原 cron._run_task_job 不发）。

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_USER_ID } from "../config";
import type { ServerConfig } from "../config";
import { canTransition } from "../task_states";
import * as telemetry from "../telemetry/core";
import { TelemetryEvent } from "../telemetry/events";
import type { TaskOrchestrator } from "../agent/orchestrator";

export interface SchedulerDeps {
  config: ServerConfig;
  db: DatabaseSync;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  orchestrator: TaskOrchestrator;
  /** 批次 4.6：email_sync 需要 Fernet 派生（与 auth 同源 JWT_SECRET）。 */
  jwtSecret?: string;
  /** 测试注入：覆盖 email_sync / idle_browser_sweeper 的本体。 */
  emailSyncFn?: () => void | Promise<void>;
  idleSweepFn?: () => void | Promise<void>;
}

export interface ScheduleRow {
  id: string;
  store_id: string | null;
  title: string;
  description: string | null;
  platform: string | null;
  country: string | null;
  plan: string | null;
  plan_version: number | null;
  schedule_type: string;
  schedule_time: string;
  schedule_day: number | null;
  interval_value: number | null;
  timezone: string;
  is_active: number | null;
  is_system: number | null;
  phase_mode: string | null;
  staleness_check: string | null;
  skip_reflection: number | null;
  finalize_description: string | null;
  finalize_enabled_at: string | null;
  plan_mode: number | null;
  ai_profile_id: string | null;
  plan_status: string | null;
  plan_error: string | null;
  current_planning_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getSchedule(db: DatabaseSync, id: string): ScheduleRow | undefined {
  return db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
}

/** 对齐 cron._schedule_can_fire：system / 非 plan_mode 恒可发；plan_mode 需 READY。 */
export function scheduleCanFire(sched: ScheduleRow): boolean {
  if (sched.is_system) return true;
  if (!sched.plan_mode) return true;
  return sched.plan_status === "ready";
}

/** 对齐 profiles.resolve_schedule_profile：pin（非 'default'）优先；否则随属主当前默认档位活解析。 */
export function resolveScheduleProfile(db: DatabaseSync, sched: ScheduleRow | null): string {
  if (sched && sched.ai_profile_id && sched.ai_profile_id !== "default") return sched.ai_profile_id;
  if (sched?.created_by) {
    const owner = db.prepare("SELECT default_profile_id FROM users WHERE id = ?").get(sched.created_by) as
      | { default_profile_id: string | null }
      | undefined;
    return owner?.default_profile_id || "default";
  }
  return "default";
}

/**
 * 对齐 fanout._cancel_prior_waiting：同 (schedule, store) 的上一发还卡在 WAITING
 * 就取消（FAILED/superseded_by_next_fire）并发响亮 SSE——一次被遗忘的提问不该
 * 把每日调度堵满 30 天等待超时。
 */
export function cancelPriorWaiting(deps: SchedulerDeps, scheduleId: string, storeId: string | null): string[] {
  const rows = (
    storeId === null
      ? deps.db.prepare("SELECT id, status FROM tasks WHERE schedule_id = ? AND status = 'waiting' AND store_id IS NULL").all(scheduleId)
      : deps.db.prepare("SELECT id, status FROM tasks WHERE schedule_id = ? AND status = 'waiting' AND store_id = ?").all(scheduleId, storeId)
  ) as unknown as { id: string; status: string }[];
  if (rows.length === 0) return [];
  const now = new Date().toISOString();
  const cancelled: string[] = [];
  for (const t of rows) {
    if (!canTransition(t.status, "failed")) continue;
    deps.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, error_category = 'superseded_by_next_fire', updated_at = ? WHERE id = ?")
      .run(
        "Cancelled by next schedule fire (prior run was WAITING on user input; cancelling so the daily schedule stays live).",
        now,
        t.id,
      );
    cancelled.push(t.id);
  }
  // SSE 在 DB 落定后发——避免客户端抢着 refetch 一个还 WAITING 的任务
  for (const tid of cancelled) {
    deps.bus.emit("schedule_waiting_cancelled", { schedule_id: scheduleId, task_id: tid, store_id: storeId });
  }
  return cancelled;
}

function insertFireTask(
  deps: SchedulerDeps,
  opts: {
    storeId: string | null;
    scheduleId: string | null;
    title: string;
    description: string;
    planMode: boolean;
    skipReflection: boolean;
    profileId: string;
    savedPlan: string | null;
    savedPlanVersion: number | null;
    batchId?: string | null;
    createdBy?: string;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const planned = Boolean(opts.savedPlan);
  deps.db
    .prepare(
      `INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to,
                          title, description, platform, country, status, priority, input_data,
                          plan, plan_history, result, accepted_result, submitted_result, review_gaps,
                          submission_count, transcript_tail, todos, error, error_category,
                          started_at, completed_at, plan_mode, is_plan_only, plan_version,
                          skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id,
                          session_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, ?, 0, NULL,
               ?, NULL, NULL, NULL, NULL, NULL,
               0, NULL, NULL, NULL, NULL,
               NULL, NULL, ?, 0, ?, ?, NULL, ?, 0, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      opts.storeId,
      opts.scheduleId,
      opts.createdBy ?? DEFAULT_USER_ID,
      opts.title,
      opts.description,
      planned ? "planned" : "pending",
      opts.savedPlan,
      opts.planMode ? 1 : 0,
      opts.savedPlan ? (opts.savedPlanVersion ?? 0) : null,
      opts.skipReflection ? 1 : 0,
      opts.batchId ?? null,
      opts.profileId,
      now,
      now,
    );
  return id;
}

function historyFor(deps: SchedulerDeps, taskId: string): { role: string; content: string }[] {
  return (
    deps.db
      .prepare("SELECT role, content FROM task_messages WHERE task_id = ? AND role IN ('user','assistant','result') ORDER BY seq")
      .all(taskId) as unknown as { role: string; content: string }[]
  ).slice(-10);
}

/** 火源提交：PLANNED → plan_execute（跳过设计），否则 execute；背景排队不拒绝。 */
function submitFire(deps: SchedulerDeps, taskId: string, savedPlan: string | null): void {
  const storeId = (deps.db.prepare("SELECT store_id FROM tasks WHERE id = ?").get(taskId) as { store_id: string | null } | undefined)?.store_id ?? null;
  const store = storeId
    ? (deps.db.prepare("SELECT id, name FROM stores WHERE id = ?").get(storeId) as { id: string; name: string } | undefined) ?? null
    : null;
  deps.orchestrator.enqueueOrLaunch(taskId, {
    mode: savedPlan ? "plan_execute" : "execute",
    store,
    history: historyFor(deps, taskId),
    queueWhenSaturated: true,
  });
}

function skipNotReady(deps: SchedulerDeps, scheduleId: string, planStatus: string | null): void {
  deps.bus.emit("schedule_skipped", { schedule_id: scheduleId, reason: "plan_not_ready", plan_status: planStatus });
}

/** 店铺绑定调度的一次火（cron._run_task_job）。scheduleId 为 null = 裸 cron 表达式作业。 */
export function runTaskJob(
  deps: SchedulerDeps,
  opts: { taskTitle: string; storeId?: string | null; scheduleId?: string | null; description?: string | null; planMode?: boolean; aiProfileId?: string | null },
): { taskId: string } | { skipped: true } {
  let savedPlan: string | null = null;
  let savedPlanVersion: number | null = null;
  let platform: string | null = null;
  let country: string | null = null;
  let profileId = opts.aiProfileId || "default";
  if (opts.scheduleId) {
    const sched = getSchedule(deps.db, opts.scheduleId);
    if (!sched) return { skipped: true };
    if (!scheduleCanFire(sched)) {
      skipNotReady(deps, sched.id, sched.plan_status);
      return { skipped: true };
    }
    savedPlan = sched.plan;
    savedPlanVersion = sched.plan_version;
    platform = sched.platform;
    country = sched.country;
    profileId = resolveScheduleProfile(deps.db, sched);
  }
  if (opts.scheduleId) cancelPriorWaiting(deps, opts.scheduleId, opts.storeId ?? null);
  const taskId = insertFireTask(deps, {
    storeId: opts.storeId ?? null,
    scheduleId: opts.scheduleId ?? null,
    title: opts.taskTitle,
    description: opts.description || opts.taskTitle,
    planMode: Boolean(opts.planMode),
    skipReflection: false,
    profileId,
    savedPlan,
    savedPlanVersion,
  });
  deps.bus.emit("schedule_triggered", { schedule_id: opts.scheduleId ?? "", task_id: taskId, title: opts.taskTitle });
  if (opts.storeId) submitFire(deps, taskId, savedPlan);
  return { taskId };
}

/** 全店 fanout：每活动店一个任务，共享 batch_id（fanout.run_fanout_job）。 */
export function runFanoutJob(
  deps: SchedulerDeps,
  opts: { scheduleId: string; taskTitle: string; description?: string | null; planMode?: boolean; aiProfileId?: string | null },
): { batchId: string; created: number } | { skipped: true } {
  const sched = getSchedule(deps.db, opts.scheduleId);
  if (!sched) return { skipped: true };
  if (!scheduleCanFire(sched)) {
    skipNotReady(deps, sched.id, sched.plan_status);
    return { skipped: true };
  }
  const twoPhase = sched.phase_mode === "two_phase";
  const stores = deps.db.prepare("SELECT id, name FROM stores ORDER BY created_at").all() as unknown as { id: string; name: string }[];
  // 原 fanout.py:183：店铺清单装载后、建任务前发（空店铺也发——先记录"这把火点了"再警告跳过）
  telemetry.send(TelemetryEvent.SCHEDULE_FIRED, {
    schedule_type: sched.schedule_type,
    phase_mode: sched.phase_mode,
    fanout_target_count_bucket: telemetry.countBucket(stores.length),
    is_catalog: sched.staleness_check === "catalog",
  });
  if (stores.length === 0) return { skipped: true };

  const batchId = randomUUID();
  // Phase 1（two_phase）：无店铺前置任务，等它终局再铺开（catalog staleness 检查属 4.5）
  if (twoPhase) {
    const profileId = resolveScheduleProfile(deps.db, sched);
    const l2Id = insertFireTask(deps, {
      storeId: null,
      scheduleId: sched.id,
      title: opts.taskTitle,
      description: opts.description || opts.taskTitle,
      planMode: Boolean(opts.planMode),
      skipReflection: Boolean(sched.skip_reflection),
      profileId,
      savedPlan: sched.plan,
      savedPlanVersion: sched.plan_version,
      batchId,
    });
    deps.bus.emit("schedule_triggered", { schedule_id: sched.id, task_id: l2Id, title: opts.taskTitle });
    submitFire(deps, l2Id, sched.plan);
    void awaitTerminal(deps, l2Id).then((ok) => {
      if (!ok) return;
      fanoutChildren(deps, sched, opts, batchId, stores);
    });
    return { batchId, created: 0 };
  }
  fanoutChildren(deps, sched, opts, batchId, stores);
  return { batchId, created: stores.length };
}

function fanoutChildren(
  deps: SchedulerDeps,
  sched: ScheduleRow,
  opts: { scheduleId: string; taskTitle: string; description?: string | null; planMode?: boolean; aiProfileId?: string | null },
  batchId: string,
  stores: { id: string; name: string }[],
): number {
  const profileId = resolveScheduleProfile(deps.db, sched);
  let created = 0;
  for (const store of stores) {
    try {
      cancelPriorWaiting(deps, sched.id, store.id);
      const taskId = insertFireTask(deps, {
        storeId: store.id,
        scheduleId: sched.id,
        title: opts.taskTitle,
        description: opts.description || opts.taskTitle,
        planMode: Boolean(opts.planMode),
        skipReflection: Boolean(sched.skip_reflection),
        profileId,
        savedPlan: sched.plan,
        savedPlanVersion: sched.plan_version,
        batchId,
      });
      submitFire(deps, taskId, sched.plan);
      created += 1;
    } catch {
      // 单店失败不拖垮整批（原实现逐店 try/except 同语义）
    }
  }
  deps.bus.emit("fanout_triggered", { schedule_id: sched.id, batch_id: batchId, store_count: created, title: opts.taskTitle });
  return created;
}

/** single：每 tick 一个无店铺任务（fanout.run_single_job）。 */
export function runSingleJob(
  deps: SchedulerDeps,
  opts: { scheduleId: string; taskTitle: string; description?: string | null; planMode?: boolean; aiProfileId?: string | null },
): { taskId: string } | { skipped: true } {
  const sched = getSchedule(deps.db, opts.scheduleId);
  if (!sched) return { skipped: true };
  if (!scheduleCanFire(sched)) {
    skipNotReady(deps, sched.id, sched.plan_status);
    return { skipped: true };
  }
  cancelPriorWaiting(deps, sched.id, null);
  const profileId = resolveScheduleProfile(deps.db, sched);
  // 原 fanout.py:339：single 的目标数恒 0、is_catalog 恒 false、phase_mode 硬编码 'single'
  telemetry.send(TelemetryEvent.SCHEDULE_FIRED, {
    schedule_type: sched.schedule_type,
    phase_mode: "single",
    fanout_target_count_bucket: telemetry.countBucket(0),
    is_catalog: false,
  });
  const taskId = insertFireTask(deps, {
    storeId: null,
    scheduleId: sched.id,
    title: opts.taskTitle,
    description: opts.description || opts.taskTitle,
    planMode: Boolean(opts.planMode),
    skipReflection: Boolean(sched.skip_reflection),
    profileId,
    savedPlan: sched.plan,
    savedPlanVersion: sched.plan_version,
  });
  deps.bus.emit("schedule_triggered", { schedule_id: sched.id, task_id: taskId, title: opts.taskTitle });
  submitFire(deps, taskId, sched.plan);
  return { taskId };
}

function awaitTerminal(deps: SchedulerDeps, taskId: string, timeoutMs = 600_000): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      const row = deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
      if (row && (row.status === "completed" || row.status === "failed")) {
        resolve(row.status === "completed");
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 1000);
    };
    poll();
  });
}
