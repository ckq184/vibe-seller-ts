// 周期作业体（批次 4.4）：app/scheduler/{waiting,plan_reaper,stall_reaper,
// finalize_reaper,task_cleanup}.py 与 task_queue._recover_from_db 的 TS 移植。
// email 策略匹配与 idle 浏览器清扫是 4.6 的洞——语义退化为"无匹配/无清扫"，
// 检查时间戳照常推进，等 email/浏览器批次接入。

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_TASK_RETENTION_DAYS } from "../config";
import { getSetting } from "../db";
import { ACTIVE, canTransition } from "../task_states";
import type { SchedulerDeps } from "./fire";
import { getSchedule, resolveScheduleProfile } from "./fire";

const DEFAULT_MAX_WAIT_DAYS = 30;
const STUCK_PLANNING_THRESHOLD_MS = 30 * 60_000;
const STALL_THRESHOLD_MS = 3 * 60_000;
const STALL_ERROR_MESSAGE =
  "Agent stream stalled — no events for 3+ minutes. Upstream provider likely dropped the SSE stream without emitting a stop event. Task was force-failed by stall_reaper. Re-run to retry.";
const BATCH_RESULTS_FILE = "batch_results.json";
const RESULTS_POINTER = `\n\n---\nThe results of every store in this batch are in \`./${BATCH_RESULTS_FILE}\` (a JSON object: \`children\` is a list with each store's \`status\` (completed|failed), \`result\`, \`error\`, \`store_slug\`, and \`task_dir\` — the store's own working directory, readable for its outputs). Decide what to do based on those results.`;

function storeSlug(name: string, id: string): string {
  // 原 browser/wrapper.py store_slug：ASCII 归约非空时无后缀（routes_tasks.storeSlug
  // 同步修正，批次 4.7.2）；仅归约为空回退 store-<id 前 8 位>。
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `store-${id.slice(0, 8)}`;
}

// ── waiting checker（原 waiting.py，15 分钟） ──

export function checkWaitingTasks(deps: SchedulerDeps): void {
  const rows = deps.db.prepare("SELECT id FROM tasks WHERE status = 'waiting'").all() as unknown as { id: string }[];
  for (const { id } of rows) {
    try {
      checkOneWaitingTask(deps, id);
    } catch {
      /* 单任务异常不拖垮整轮（原实现同语义） */
    }
  }
}

function checkOneWaitingTask(deps: SchedulerDeps, taskId: string): void {
  const now = new Date();
  const task = deps.db.prepare("SELECT id, store_id, wait_condition FROM tasks WHERE id = ?").get(taskId) as
    | { id: string; store_id: string | null; wait_condition: string | null }
    | undefined;
  if (!task) return;
  let condition: Record<string, unknown> = {};
  if (task.wait_condition) {
    try {
      condition = JSON.parse(task.wait_condition) as Record<string, unknown>;
    } catch {
      return; // 条件损坏：不动
    }
  }

  // 超时：等待超过 max_wait_days（默认 30 天）→ FAILED
  const maxWaitDays = typeof condition.max_wait_days === "number" ? condition.max_wait_days : DEFAULT_MAX_WAIT_DAYS;
  const waitingSince = typeof condition.waiting_since === "string" ? condition.waiting_since : null;
  if (waitingSince) {
    const since = new Date(waitingSince);
    if (!Number.isNaN(since.getTime()) && Math.floor((now.getTime() - since.getTime()) / 86_400_000) > maxWaitDays) {
      timeoutWaitingTask(deps, taskId);
      return;
    }
  }

  const strategy = typeof condition.check_strategy === "string" ? condition.check_strategy : "manual";
  if (strategy === "manual") return; // 只能用户唤醒

  const nextCheckAt = typeof condition.next_check_at === "string" ? condition.next_check_at : null;
  if (nextCheckAt && now < new Date(nextCheckAt)) return;

  // email 策略：本地邮件库属 4.6 —— 本批次恒视为"无匹配"，时间戳照常推进
  const matched: unknown[] | null = null;

  if (matched) {
    wakeWaitingTask(deps, taskId, condition, { emails: matched });
  } else {
    const checkIntervalHours = typeof condition.check_interval_hours === "number" ? condition.check_interval_hours : 24;
    condition.last_checked_at = now.toISOString();
    condition.next_check_at = new Date(now.getTime() + checkIntervalHours * 3_600_000).toISOString();
    deps.db.prepare("UPDATE tasks SET wait_condition = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(condition),
      now.toISOString(),
      taskId,
    );
  }
}

function wakeWaitingTask(deps: SchedulerDeps, taskId: string, condition: Record<string, unknown>, triggerData: unknown): void {
  const now = new Date().toISOString();
  condition.woken_at = now;
  condition.trigger_data = triggerData;
  deps.db.prepare("UPDATE tasks SET status = 'queued', wait_condition = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(condition),
    now,
    taskId,
  );
  deps.bus.emit("task_update", { task_id: taskId, status: "queued" });
  const storeId = (deps.db.prepare("SELECT store_id FROM tasks WHERE id = ?").get(taskId) as { store_id: string | null }).store_id;
  deps.orchestrator.enqueueOrLaunch(taskId, {
    mode: "woken",
    store: storeId ? (deps.db.prepare("SELECT id, name FROM stores WHERE id = ?").get(storeId) as { id: string; name: string } | undefined) ?? null : null,
    queueWhenSaturated: true,
  });
}

function timeoutWaitingTask(deps: SchedulerDeps, taskId: string): void {
  const now = new Date().toISOString();
  const error = "Task timed out while waiting. The wait condition was not met within the allowed period.";
  deps.db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now, taskId);
  deps.bus.emit("task_update", { task_id: taskId, status: "failed", error });
}

// ── plan reaper（原 plan_reaper.py，5 分钟） ──

export function reapStuckPlanningTasks(deps: SchedulerDeps): { scheduleId: string; taskId: string }[] {
  const cutoffIso = new Date(Date.now() - STUCK_PLANNING_THRESHOLD_MS).toISOString();
  const now = new Date().toISOString();
  const scheds = deps.db.prepare("SELECT id FROM schedules WHERE plan_status = 'planning'").all() as unknown as { id: string }[];
  const timedOut: { scheduleId: string; taskId: string }[] = [];

  for (const { id } of scheds) {
    const sched = getSchedule(deps.db, id);
    if (!sched) continue;
    if (!sched.current_planning_task_id) {
      deps.db
        .prepare("UPDATE schedules SET plan_status = 'failed', plan_error = ?, updated_at = ? WHERE id = ?")
        .run("Planning task pointer missing; reset to FAILED.", now, id);
      continue;
    }
    const task = deps.db.prepare("SELECT id, status, plan, error, updated_at FROM tasks WHERE id = ?").get(sched.current_planning_task_id) as
      | { id: string; status: string; plan: string | null; error: string | null; updated_at: string | null }
      | undefined;
    if (!task) {
      deps.db
        .prepare("UPDATE schedules SET plan_status = 'failed', plan_error = ?, current_planning_task_id = NULL, updated_at = ? WHERE id = ?")
        .run("Planning task row deleted.", now, id);
      continue;
    }
    if (task.status === "waiting") continue; // 等人答复是合法长等
    if (task.status === "completed" && sched.plan) {
      // 终局同步（编排器落 plan 时已翻 ready；防御性对齐）
      deps.db
        .prepare("UPDATE schedules SET plan_status = 'ready', current_planning_task_id = NULL, plan_error = NULL, updated_at = ? WHERE id = ?")
        .run(now, id);
      continue;
    }
    if (task.status === "completed" && !sched.plan) {
      deps.db
        .prepare("UPDATE schedules SET plan_status = 'failed', plan_error = ?, current_planning_task_id = NULL, updated_at = ? WHERE id = ?")
        .run(task.error || "Planning task completed without calling ExitPlanMode — no plan was saved.", now, id);
      continue;
    }
    if (task.status === "failed") {
      deps.db
        .prepare("UPDATE schedules SET plan_status = 'failed', plan_error = ?, current_planning_task_id = NULL, updated_at = ? WHERE id = ?")
        .run(task.error || "Planning task failed without a message.", now, id);
      continue;
    }
    if ((task.updated_at ?? "") > cutoffIso) continue;

    deps.orchestrator.stop(task.id);
    if (canTransition(task.status, "failed")) {
      deps.db
        .prepare("UPDATE tasks SET status = 'failed', error = 'Planning timed out', error_category = 'planning_timeout', updated_at = ? WHERE id = ?")
        .run(now, task.id);
    }
    deps.db
      .prepare("UPDATE schedules SET plan_status = 'failed', plan_error = 'Planning timed out', current_planning_task_id = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);
    timedOut.push({ scheduleId: id, taskId: task.id });
  }

  // 事件在写库成功后发（原实现的提交后再 emit 同语义）
  for (const { scheduleId, taskId } of timedOut) {
    deps.bus.emit("schedule_plan_timeout", { schedule_id: scheduleId, task_id: taskId });
  }
  return timedOut;
}

// ── stall reaper（原 stall_reaper.py，1 分钟） ──

export function reapStalledRunningTasks(deps: SchedulerDeps): { taskId: string; status: string }[] {
  const cutoffIso = new Date(Date.now() - STALL_THRESHOLD_MS).toISOString();
  const now = new Date().toISOString();
  let rows = deps.db
    .prepare("SELECT id FROM tasks WHERE status = 'running' AND updated_at < ?")
    .all(cutoffIso) as unknown as { id: string }[];
  // 有待答问题的任务没死——操作者可能合法想几小时（原实现同语义）
  rows = rows.filter((r) => !deps.orchestrator.pendingQuestions(r.id).pending);
  const outcomes: { taskId: string; status: string }[] = [];

  for (const { id } of rows) {
    deps.orchestrator.stop(id);
    // 复读：终结写可能已在我们查询和现在之间发生
    const fresh = deps.db
      .prepare("SELECT id, status, result, error FROM tasks WHERE id = ?")
      .get(id) as { id: string; status: string; result: string | null; error: string | null } | undefined;
    if (!fresh || fresh.status !== "running") continue;

    let deliverableDone = Boolean(fresh.result) && !fresh.error;
    if (!fresh.result) {
      const lastMsg = deps.db
        .prepare("SELECT role, content FROM task_messages WHERE task_id = ? AND role IN ('assistant','result') ORDER BY seq DESC LIMIT 1")
        .get(id) as { role: string; content: string } | undefined;
      if (lastMsg?.content && lastMsg.content.length > 100) {
        if (lastMsg.role === "result") {
          deps.db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(lastMsg.content, id);
          deliverableDone = !fresh.error;
        } else {
          deps.db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(`[PARTIAL — stream stalled before completion]\n\n${lastMsg.content}`, id);
        }
      }
    }

    if (deliverableDone) {
      // 交付物已声明后的流掉线：活干完了，传输死了 → COMPLETED（绝不叫用户重跑已完成的活）
      deps.db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      outcomes.push({ taskId: id, status: "completed" });
    } else {
      deps.db
        .prepare("UPDATE tasks SET status = 'failed', error = ?, error_category = 'agent_stream_stalled', completed_at = ?, updated_at = ? WHERE id = ?")
        .run(STALL_ERROR_MESSAGE, now, now, id);
      outcomes.push({ taskId: id, status: "failed" });
    }
  }

  for (const { taskId, status } of outcomes) {
    deps.bus.emit("task_update", { task_id: taskId, status });
    if (status === "failed") {
      deps.bus.emit("task_failed", { task_id: taskId, error: STALL_ERROR_MESSAGE, error_category: "agent_stream_stalled" });
    }
  }
  return outcomes;
}

// ── finalize reaper（原 finalize_reaper.py，1 分钟） ──

const TERMINAL = new Set(["completed", "failed"]);

/** 批次是否在 finalize 纪元内开始（原 _batch_is_within_finalize_era）：批量补火的教训——
 * 只有配置 finalize 之后开的批次才欠一次收尾。两侧都是 datetime.now(UTC).isoformat()
 * 字符串，字典序比较即时序（原实现同款，绝不用数值 min）。 */
function batchWithinFinalizeEra(children: { created_at: string | null }[], enabledAt: string | null): boolean {
  if (!enabledAt) return false;
  const stamps = children.map((c) => c.created_at).filter((s): s is string => Boolean(s));
  if (stamps.length === 0) return false;
  return stamps.reduce((a, b) => (a < b ? a : b)) >= enabledAt;
}

export function reapFinalizedBatches(deps: SchedulerDeps): string[] {
  const scheds = deps.db.prepare("SELECT id FROM schedules WHERE finalize_description IS NOT NULL").all() as unknown as { id: string }[];
  const armed = scheds
    .map((s) => getSchedule(deps.db, s.id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s) && Boolean(s!.finalize_description?.trim()) && Boolean(s!.finalize_enabled_at));
  if (armed.length === 0) return [];

  const ids = armed.map((s) => s.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = deps.db
    .prepare(
      `SELECT * FROM tasks WHERE schedule_id IN (${placeholders}) AND batch_id IS NOT NULL
       AND batch_id NOT IN (SELECT batch_id FROM tasks WHERE is_finalize = 1 AND batch_id IS NOT NULL)`,
    )
    .all(...ids) as unknown as Record<string, unknown>[];

  const batches = new Map<string, Record<string, unknown>[]>();
  for (const t of rows) {
    const batchId = t.batch_id as string;
    const list = batches.get(batchId) ?? [];
    list.push(t);
    batches.set(batchId, list);
  }

  const fired: string[] = [];
  for (const [batchId, tasks] of batches) {
    if (tasks.some((t) => Number(t.is_finalize))) continue;
    const children = tasks.filter((t) => t.store_id !== null);
    if (children.length === 0) continue;
    if (!children.every((t) => TERMINAL.has(String(t.status)))) continue;
    const sched = armed.find((s) => s.id === children[0]!.schedule_id);
    if (!sched) continue;
    if (!batchWithinFinalizeEra(children as { created_at: string | null }[], sched.finalize_enabled_at)) continue;
    if (fireFinalize(deps, batchId, sched)) fired.push(batchId);
  }
  return fired;
}

function fireFinalize(deps: SchedulerDeps, batchId: string, sched: NonNullable<ReturnType<typeof getSchedule>>): boolean {
  // 事务内复核（belt-and-braces：防第二个写者 + 外层扫描到这里的窗口变化）
  const existing = deps.db.prepare("SELECT id FROM tasks WHERE batch_id = ? AND is_finalize = 1").get(batchId);
  if (existing) return false;
  const children = deps.db
    .prepare("SELECT * FROM tasks WHERE batch_id = ? AND store_id IS NOT NULL")
    .all(batchId) as unknown as Record<string, unknown>[];
  if (children.length === 0) return false;
  if (!children.every((c) => TERMINAL.has(String(c.status)))) return false;
  if (!batchWithinFinalizeEra(children as { created_at: string | null }[], sched.finalize_enabled_at)) return false;

  const now = new Date().toISOString();
  const finalizeId = randomUUID();
  const profileId = resolveScheduleProfile(deps.db, sched);
  const records = children.map((c) => {
    const store = deps.db.prepare("SELECT name FROM stores WHERE id = ?").get(String(c.store_id)) as { name: string } | undefined;
    return {
      task_id: c.id,
      store_id: c.store_id,
      store_slug: store ? storeSlug(store.name, String(c.store_id)) : String(c.store_id ?? ""),
      status: c.status,
      result: c.result,
      error: c.error,
      task_dir: join(deps.config.homeDir, "tasks", String(c.id)),
      started_at: c.started_at ?? null,
      completed_at: c.completed_at ?? null,
    };
  });
  const completed = records.filter((r) => r.status === "completed").length;

  deps.db
    .prepare(
      `INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to,
                          title, description, platform, country, status, priority, input_data,
                          plan, plan_history, result, accepted_result, submitted_result, review_gaps,
                          submission_count, transcript_tail, todos, error, error_category,
                          started_at, completed_at, plan_mode, is_plan_only, plan_version,
                          skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id,
                          session_id, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, NULL, NULL, 'pending', 0, NULL,
               NULL, NULL, NULL, NULL, NULL, NULL,
               0, NULL, NULL, NULL, NULL,
               NULL, NULL, 0, 0, NULL, 1, NULL, ?, 1, ?, NULL, ?, ?)`,
    )
    .run(
      finalizeId,
      sched.id,
      sched.created_by,
      `${sched.title} — finalize`,
      (sched.finalize_description ?? "") + RESULTS_POINTER,
      batchId,
      profileId,
      now,
      now,
    );

  // batch_results.json 先落盘再让 agent 开跑（任务的 cwd 即其任务目录）
  try {
    const dir = join(deps.config.homeDir, "tasks", finalizeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, BATCH_RESULTS_FILE),
      JSON.stringify(
        {
          schema: "batch-results/v1",
          batch_id: batchId,
          schedule_id: sched.id,
          completed,
          failed: records.length - completed,
          children: records,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* best-effort：写不出目录的任务仍会执行，只是拿不到结果集指针 */
  }

  deps.bus.emit("fanout_finalize_triggered", {
    schedule_id: sched.id,
    batch_id: batchId,
    task_id: finalizeId,
    completed,
    failed: records.length - completed,
  });
  deps.orchestrator.enqueueOrLaunch(finalizeId, { mode: "execute", queueWhenSaturated: true });
  return true;
}

// ── 任务删除（原 task_delete.py：子树级联 + 工作区清理） ──

export class ActiveTaskError extends Error {}

/** 级联删除任务子树（子先删、父后删，FK 保持满足）；子树里有 ACTIVE 且未放行 → ActiveTaskError。 */
export function deleteTaskCascade(deps: Pick<SchedulerDeps, "db" | "config">, taskId: string, opts?: { allowActive?: boolean }): boolean {
  const root = deps.db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!root) return false;

  // BFS 收集子树
  const order: string[] = [taskId];
  const frontier = [taskId];
  const seen = new Set([taskId]);
  while (frontier.length) {
    const placeholders = frontier.map(() => "?").join(",");
    const next = deps.db
      .prepare(`SELECT id FROM tasks WHERE parent_task_id IN (${placeholders})`)
      .all(...frontier) as unknown as { id: string }[];
    const fresh = next.map((r) => r.id).filter((id) => !seen.has(id));
    if (fresh.length === 0) break;
    order.push(...fresh);
    for (const id of fresh) seen.add(id);
    frontier.length = 0;
    frontier.push(...fresh);
  }

  if (!opts?.allowActive) {
    const placeholders = order.map(() => "?").join(",");
    const activeRows = deps.db
      .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders}) AND status IN (${[...ACTIVE].map(() => "?").join(",")})`)
      .all(...order, ...ACTIVE) as unknown as { status: string }[];
    if (activeRows.length > 0) {
      const statuses = [...new Set(activeRows.map((r) => r.status))].sort().join(", ");
      throw new ActiveTaskError(`Cannot delete task tree: ${activeRows.length} task(s) in status {${statuses}} — stop them first`);
    }
  }

  for (const id of order) {
    deps.db.prepare("DELETE FROM task_steps WHERE task_id = ?").run(id);
    deps.db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(id);
    deps.db.prepare("DELETE FROM task_logs WHERE task_id = ?").run(id);
    deps.db.prepare("DELETE FROM task_attachments WHERE task_id = ?").run(id);
    deps.db.prepare("DELETE FROM ad_task_declarations WHERE task_id = ?").run(id);
    // 工作区目录（best-effort，路径越界已在 id 层面由 UUID 保证）
    try {
      const dir = join(deps.config.homeDir, "tasks", id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  const placeholders = order.map(() => "?").join(",");
  deps.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...order);
  return true;
}

// ── task cleanup（原 task_cleanup.py，每日 03:30） ──

export function cleanupOldTasks(deps: SchedulerDeps): number {
  const days = Number.parseInt(getSetting(deps.db, "task_retention_days") ?? String(DEFAULT_TASK_RETENTION_DAYS), 10);
  if (Number.isNaN(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const ids = deps.db
    .prepare("SELECT id FROM tasks WHERE status IN ('completed','failed') AND updated_at < ?")
    .all(cutoff) as unknown as { id: string }[];
  let deleted = 0;
  for (const { id } of ids) {
    try {
      if (deleteTaskCascade(deps, id)) deleted += 1;
    } catch {
      /* 单个删除失败不拖垮整轮 */
    }
  }
  return deleted;
}

// ── 启动恢复（原 task_queue._recover_from_db） ──

export function recoverTasksFromDb(deps: SchedulerDeps): { resumed: number; marked: number } {
  const now = new Date().toISOString();
  let marked = 0;
  // 上次进程的死局：RUNNING/DESIGNING 的 agent 已不在。已验收交付 → COMPLETED
  // （传输断 ≠ 任务失败），否则 FAILED/server_restart。
  const activeRows = deps.db
    .prepare("SELECT id, status, accepted_result, result FROM tasks WHERE status IN ('running','designing')")
    .all() as unknown as Array<{ id: string; status: string; accepted_result: string | null; result: string | null }>;
  for (const t of activeRows) {
    if (t.accepted_result) {
      deps.db
        .prepare("UPDATE tasks SET status = 'completed', result = COALESCE(result, ?), completed_at = ?, updated_at = ? WHERE id = ?")
        .run(t.accepted_result, now, now, t.id);
    } else {
      deps.db
        .prepare("UPDATE tasks SET status = 'failed', error = 'Server restarted while task was active', error_category = 'server_restart', updated_at = ? WHERE id = ?")
        .run(now, t.id);
    }
    marked += 1;
  }

  // 重排队：只捞"在管道里的"——queued 任意（队列里排着的）+ 带调度的
  // pending/planned（火源插入→入队之间的崩溃瞬态窗、调度冻结计划）。无调度
  // 的 pending 是"从未被启动过的"（defer_start 附件路径、agent 工具建的子任务
  // ——工具面恒 defer），归属其 owner：前端上传完会调 /start，子任务由人工经
  // API 启动；恢复曾把它们一并捞跑，附件上传窗口内重启丢附件启动、子任务扇出
  // 失控（创建即起飞落地后，正常创建不会停留 pending，该区分是确定性的）。
  let resumed = 0;
  const requeue = deps.db
    .prepare(
      `SELECT id, store_id, plan, plan_mode FROM tasks
       WHERE status = 'queued' OR (status IN ('pending','planned') AND schedule_id IS NOT NULL)
       ORDER BY created_at`,
    )
    .all() as unknown as { id: string; store_id: string | null; plan: string | null; plan_mode: number | null }[];
  for (const t of requeue) {
    const store = t.store_id
      ? (deps.db.prepare("SELECT id, name FROM stores WHERE id = ?").get(t.store_id) as { id: string; name: string } | undefined) ?? null
      : null;
    // 先审核任务还没出方案 → 先进设计阶段等人工确认，不直接执行（2026-10-13
    // 实测：恢复曾把 plan_mode=1、未出方案的 pending 任务按 execute 跑完，用户
    // 没看到任何方案卡）。设计入口等价 POST /design，与 /start、/messages 的
    // planPhaseActive 推导对齐。
    if (Number(t.plan_mode) && !t.plan) {
      if (deps.orchestrator.transition(t.id, "designing")) {
        void deps.orchestrator.start(t.id, { mode: "design", store });
        resumed += 1;
      }
      continue;
    }
    const result = deps.orchestrator.enqueueOrLaunch(t.id, {
      mode: t.plan && Number(t.plan_mode) ? "plan_execute" : "execute",
      store,
      queueWhenSaturated: true,
    });
    if (result !== "rejected") resumed += 1;
  }

  // 浏览器会话全量复位 idle（原实现同语义）
  deps.db
    .prepare(
      "UPDATE browser_sessions SET status = 'idle', current_platform = NULL, current_country = NULL, active_tab_count = 0, cdp_port = NULL, chrome_pid = NULL, updated_at = ?",
    )
    .run(now);

  return { resumed, marked };
}
