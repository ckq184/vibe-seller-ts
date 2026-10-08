// 批次 4.4 路由：schedules（11）+ cron（5）+ 规划任务生命周期 + 计划态 MCP 入口
// （register-finalize / schedule-state）+ 广告任务声明。契约对齐
// app/routers/{schedules,cron,schedule_planning,tasks_schedule_state,tasks_ad_declaration}.py。

import { Hono, type Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./types";
import { getCurrentUser, type AuthContext } from "./auth";
import { getSetting } from "./db";
import { validateTimezone } from "./schedule/tz";
import { parseCronExpression } from "./schedule/triggers";
import { getServerTimezone } from "./scheduler/util";
import { addCronJob, addScheduleJobFor, removeScheduleJob, type VibeScheduler } from "./scheduler/scheduler";
import { cancelPriorWaiting, getSchedule, resolveScheduleProfile, runFanoutJob, runSingleJob, type ScheduleRow, type SchedulerDeps } from "./scheduler/fire";
import { AD_TASK_KINDS, normaliseScope, supersedes, writeDeclarationFile, type AdScope } from "./agent/ad_declaration";
import { canTransition as canTransitionTask } from "./task_states";
import { creatorNames, taskResponse, type TaskRow } from "./routes_tasks";
import { EmailStore } from "./email/db";

export interface ScheduleRouteDeps extends SchedulerDeps {
  auth: AuthContext;
  scheduler: VibeScheduler;
}

const VALID_SCHEDULE_TYPES = new Set(["minutes", "hours", "days", "weekly", "monthly"]);
const USER_SELECTABLE_PHASE_MODES = new Set(["fanout", "single"]);
const SCHEDULE_STATE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const EPOCH_SECONDS_RE = /^[0-9]{1,15}$/;
const EPOCH_PAST_WINDOW_DAYS = 90;
const EPOCH_FUTURE_WINDOW_HOURS = 1;

function normalizePrompt(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function scheduleNeedsPlan(sched: ScheduleRow): boolean {
  return Boolean(sched.plan_mode) && !sched.is_system;
}

function validateScheduleType(type: string): void {
  if (!VALID_SCHEDULE_TYPES.has(type)) {
    throw new HttpError(400, `Invalid schedule_type: ${type}. Must be one of minutes,hours,days,weekly,monthly`);
  }
}

function validateScheduleTime(time: string): void {
  const parts = time.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    throw new HttpError(400, "Invalid schedule_time format. Expected HH:MM or HH:MM:SS");
  }
  const h = Number.parseInt(parts[0]!, 10);
  const m = Number.parseInt(parts[1]!, 10);
  if (Number.isNaN(h) || Number.isNaN(m) || !(h >= 0 && h <= 23 && m >= 0 && m <= 59)) {
    throw new HttpError(400, "Invalid schedule_time values");
  }
  if (parts.length === 3) {
    const s = Number.parseInt(parts[2]!, 10);
    if (Number.isNaN(s) || s < 0 || s > 59) throw new HttpError(400, "Invalid schedule_time values");
  }
}

function validateTimezoneOr400(tz: string): void {
  if (!validateTimezone(tz)) throw new HttpError(400, `Invalid timezone: ${tz}`);
}

/** finalize 只在 all-stores fanout 上合法：其它形态没有批次可归约，注册了也永不触发。 */
function validateFinalizeDescription(finalizeDescription: string | null | undefined, storeId: string | null, phaseMode: string): void {
  if (finalizeDescription && (storeId !== null || phaseMode !== "fanout")) {
    throw new HttpError(400, "finalize_description is only valid for all-stores fanout schedules (store_id null + phase_mode=fanout).");
  }
}

function enrichResponse(deps: ScheduleRouteDeps, sched: ScheduleRow): Record<string, unknown> {
  const { db, scheduler } = deps;
  const child = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE schedule_id = ? AND (is_plan_only = 0 OR is_plan_only IS NULL)").get(sched.id) as { n: number };
  const latest = db
    .prepare("SELECT status FROM tasks WHERE schedule_id = ? AND (is_plan_only = 0 OR is_plan_only IS NULL) ORDER BY created_at DESC LIMIT 1")
    .get(sched.id) as { status: string } | undefined;
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE schedule_id = ? AND status = 'waiting'").get(sched.id) as { n: number };
  return {
    id: sched.id,
    store_id: sched.store_id,
    title: sched.title,
    description: sched.description,
    platform: sched.platform,
    country: sched.country,
    plan: sched.plan,
    schedule_type: sched.schedule_type,
    schedule_time: sched.schedule_time,
    schedule_day: sched.schedule_day,
    interval_value: sched.interval_value ?? 1,
    timezone: sched.timezone,
    is_active: Boolean(sched.is_active),
    is_system: Boolean(sched.is_system),
    phase_mode: sched.phase_mode ?? "fanout",
    staleness_check: sched.staleness_check,
    skip_reflection: Boolean(sched.skip_reflection),
    finalize_description: sched.finalize_description,
    plan_mode: Boolean(sched.plan_mode),
    ai_profile_id: sched.ai_profile_id,
    created_by: sched.created_by,
    created_at: sched.created_at,
    updated_at: sched.updated_at,
    plan_status: sched.plan_status ?? "none",
    plan_version: sched.plan_version ?? 0,
    plan_error: sched.plan_error,
    current_planning_task_id: sched.current_planning_task_id,
    next_run: scheduler.nextRun(`schedule_${sched.id}`),
    child_task_count: child.n,
    last_run_status: latest?.status ?? null,
    pending_questions_count: waiting.n,
  };
}

// ── 规划任务生命周期（schedule_planning.py） ──

/** 起 plan-only 设计任务：走正常 auto-run 管道的 DESIGNING 段，编排器落 plan 时提交 Schedule。 */
function spawnPlanningTask(deps: ScheduleRouteDeps, sched: ScheduleRow, userId: string): string {
  const { db, orchestrator } = deps;
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
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
             NULL, NULL, 1, 1, NULL, 0, NULL, NULL, 0, ?, NULL, ?, ?)`,
  ).run(taskId, sched.id, userId, `Plan: ${sched.title}`, sched.description || sched.title, resolveScheduleProfile(db, sched), now, now);
  db.prepare("UPDATE schedules SET current_planning_task_id = ?, plan_status = 'planning', plan_error = NULL, updated_at = ? WHERE id = ?").run(
    taskId,
    now,
    sched.id,
  );
  // 规划任务无店铺 → 直启（原 schedule_or_run(task.id, None)）
  orchestrator.transition(taskId, "designing");
  void orchestrator.start(taskId, { mode: "design" });
  return taskId;
}

/** 终止在飞规划任务（编辑提示词/replan 换代）：停 agent + 任务 FAILED/superseded_by_edit。 */
function abortCurrentPlanningTask(deps: ScheduleRouteDeps, sched: ScheduleRow, reason: string): void {
  if (!sched.current_planning_task_id) return;
  const planningTaskId = sched.current_planning_task_id;
  deps.db.prepare("UPDATE schedules SET current_planning_task_id = NULL WHERE id = ?").run(sched.id);
  deps.orchestrator.stop(planningTaskId);
  const task = deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(planningTaskId) as { status: string } | undefined;
  if (task && canTransitionTask(task.status, "failed")) {
    const now = new Date().toISOString();
    deps.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, error_category = 'superseded_by_edit', updated_at = ? WHERE id = ?")
      .run(reason, now, planningTaskId);
  }
}

export function registerScheduleRoutes(app: Hono, deps: ScheduleRouteDeps): void {
  const { db, auth, bus, scheduler, config } = deps;
  const nowIso = () => new Date().toISOString();

  // ── schedules ──
  app.get("/api/schedules", (c: Context) => {
    getCurrentUser(c, auth);
    const storeId = c.req.query("store_id") || null;
    const rows = (
      storeId
        ? db.prepare("SELECT * FROM schedules WHERE store_id = ? ORDER BY created_at DESC").all(storeId)
        : db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all()
    ) as unknown as ScheduleRow[];
    return c.json(rows.map((s) => enrichResponse(deps, s)));
  });

  app.post("/api/schedules", async (c: Context) => {
    const user = getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      description?: string | null;
      store_id?: string | null;
      schedule_type?: string;
      schedule_time?: string;
      schedule_day?: number | null;
      interval_value?: number;
      timezone?: string | null;
      plan_mode?: boolean;
      ai_profile_id?: string | null;
      phase_mode?: string | null;
      finalize_description?: string | null;
    };
    if (!body.title) throw new HttpError(422, "title required");
    const scheduleType = body.schedule_type ?? "";
    validateScheduleType(scheduleType);
    const scheduleTime = body.schedule_time ?? "09:00";
    validateScheduleTime(scheduleTime);

    // 时区解析：显式 → AppSettings 默认 → 服务器本地
    let timezone = body.timezone ?? null;
    if (timezone === null) {
      timezone = getSetting(db, "default_schedule_timezone") || getServerTimezone(deps);
    }
    validateTimezoneOr400(timezone);

    if (body.store_id) {
      const store = db.prepare("SELECT id FROM stores WHERE id = ?").get(body.store_id);
      if (!store) throw new HttpError(404, "Store not found");
    }

    // phase_mode 解析：店绑定恒 single；客户端只许 fanout/single；否则全局默认 → fanout
    let phaseMode: string;
    if (body.store_id !== null && body.store_id !== undefined) {
      phaseMode = "single";
    } else if (body.phase_mode != null) {
      if (!USER_SELECTABLE_PHASE_MODES.has(body.phase_mode)) {
        throw new HttpError(400, `Invalid phase_mode: ${body.phase_mode}. Must be one of ${[...USER_SELECTABLE_PHASE_MODES].sort().join(",")}`);
      }
      phaseMode = body.phase_mode;
    } else {
      const setting = getSetting(db, "default_schedule_phase_mode");
      phaseMode = setting && USER_SELECTABLE_PHASE_MODES.has(setting) ? setting : "fanout";
    }

    validateFinalizeDescription(body.finalize_description, body.store_id ?? null, phaseMode);

    // 用户创建的调度一律 plan-at-creation（系统种子除外——本层不播种）
    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO schedules (id, store_id, created_by, title, description, platform, country, plan,
                              schedule_type, schedule_time, schedule_day, interval_value, timezone,
                              is_active, is_system, phase_mode, staleness_check, skip_reflection,
                              finalize_description, finalize_enabled_at, plan_mode, ai_profile_id,
                              plan_status, plan_version, current_planning_task_id, plan_error,
                              created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1, 0, ?, NULL, 0, ?, ?, 1, ?, 'planning', 0, NULL, NULL, ?, ?)`,
    ).run(
      id,
      body.store_id ?? null,
      user.id,
      body.title,
      body.description ?? null,
      scheduleType,
      scheduleTime,
      body.schedule_day ?? null,
      body.interval_value ?? 1,
      timezone,
      phaseMode,
      body.finalize_description ?? null,
      body.finalize_description?.trim() ? now : null,
      body.ai_profile_id ?? "default",
      now,
      now,
    );

    const sched = getSchedule(db, id)!;
    try {
      addScheduleJobFor(scheduler, deps, sched);
    } catch (err: unknown) {
      throw new HttpError(500, `Schedule created but job failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (scheduleNeedsPlan(getSchedule(db, id)!)) {
      try {
        spawnPlanningTask(deps, getSchedule(db, id)!, user.id);
      } catch (err: unknown) {
        // 半途孤儿清理：指针清空 + 规划任务 FAILED，plan 落 failed（/replan 可重试）
        const message = err instanceof Error ? err.message : String(err);
        const cur = getSchedule(db, id)!;
        if (cur.current_planning_task_id) {
          const orphan = db.prepare("SELECT status FROM tasks WHERE id = ?").get(cur.current_planning_task_id) as { status: string } | undefined;
          if (orphan && canTransitionTask(orphan.status, "failed")) {
            db.prepare("UPDATE tasks SET status = 'failed', error = ?, error_category = 'planning_launch_failed', updated_at = ? WHERE id = ?").run(
              `Planning task launch failed: ${message}`,
              nowIso(),
              cur.current_planning_task_id,
            );
          }
          db.prepare("UPDATE schedules SET current_planning_task_id = NULL, plan_status = 'failed', plan_error = ?, updated_at = ? WHERE id = ?").run(
            `Failed to spawn planning task: ${message}`,
            nowIso(),
            id,
          );
        }
      }
    }
    return c.json(enrichResponse(deps, getSchedule(db, id)!), 201);
  });

  app.get("/api/schedules/:schedule_id", (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    return c.json(enrichResponse(deps, sched));
  });

  app.put("/api/schedules/:schedule_id", async (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const keys = new Set(Object.keys(body));

    // 乐观锁：客户端带上次见到的 plan_version（If-Match 语义）
    if (body.plan_version !== undefined && body.plan_version !== null && Number(body.plan_version) !== (sched.plan_version ?? 0)) {
      throw new HttpError(412, `Stale plan_version: client=${Number(body.plan_version)} server=${sched.plan_version ?? 0}`);
    }
    if (keys.has("plan_mode") && body.plan_mode !== null && Boolean(body.plan_mode) !== Boolean(sched.plan_mode)) {
      throw new HttpError(400, "plan_mode is immutable after schedule creation; delete and recreate the schedule to change it");
    }
    if (keys.has("schedule_type")) validateScheduleType(String(body.schedule_type));
    if (keys.has("schedule_time")) validateScheduleTime(String(body.schedule_time));
    if (keys.has("timezone")) validateTimezoneOr400(String(body.timezone));
    const finalizeDesc = keys.has("finalize_description") ? (body.finalize_description as string | null | undefined) : undefined;
    validateFinalizeDescription(finalizeDesc === undefined ? sched.finalize_description : finalizeDesc, sched.store_id, sched.phase_mode ?? "fanout");

    // 提示词变更（规范化比较，纯排版编辑不作废）→ plan 作废：stale + 旧文保留供 diff
    let promptChanged = false;
    if (keys.has("description")) {
      promptChanged = normalizePrompt(body.description as string | null) !== normalizePrompt(sched.description);
    }

    if (promptChanged && scheduleNeedsPlan(sched)) {
      abortCurrentPlanningTask(deps, sched, "Schedule prompt edited; plan invalidated.");
      db.prepare("UPDATE schedules SET plan_status = 'stale', plan_error = NULL WHERE id = ?").run(sched.id);
    }

    // finalize 只在 空↔非空 翻转时动时间戳：编辑已有 finalize 的文案不得重新武装
    if (keys.has("finalize_description")) {
      const wasOn = Boolean(sched.finalize_description?.trim());
      const nowOn = Boolean(String(body.finalize_description ?? "").trim());
      if (nowOn && !wasOn) db.prepare("UPDATE schedules SET finalize_enabled_at = ? WHERE id = ?").run(nowIso(), sched.id);
      else if (wasOn && !nowOn) db.prepare("UPDATE schedules SET finalize_enabled_at = NULL WHERE id = ?").run(sched.id);
    }

    const fieldMap: [string, (v: unknown) => string | number | null][] = [
      ["title", (v) => String(v)],
      ["description", (v) => (v === null ? null : String(v))],
      ["schedule_type", (v) => String(v)],
      ["schedule_time", (v) => String(v)],
      ["schedule_day", (v) => (v === null ? null : Number(v))],
      ["interval_value", (v) => Number(v)],
      ["timezone", (v) => String(v)],
      ["ai_profile_id", (v) => (v === null ? null : String(v))],
      ["finalize_description", (v) => (v === null ? null : String(v))],
    ];
    for (const [key, cast] of fieldMap) {
      if (!keys.has(key)) continue;
      db.prepare(`UPDATE schedules SET ${key} = ? WHERE id = ?`).run(cast(body[key]), sched.id);
    }
    db.prepare("UPDATE schedules SET updated_at = ? WHERE id = ?").run(nowIso(), sched.id);

    const updated = getSchedule(db, sched.id)!;
    if (promptChanged && updated.plan_status === "stale") {
      bus.emit("schedule_plan_stale", { schedule_id: sched.id });
    }

    // 作业按新参数重建
    removeScheduleJob(scheduler, sched.id);
    if (updated.is_active) {
      try {
        addScheduleJobFor(scheduler, deps, updated);
      } catch (err: unknown) {
        throw new HttpError(500, `Schedule updated but job failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return c.json(enrichResponse(deps, getSchedule(db, sched.id)!));
  });

  app.delete("/api/schedules/:schedule_id", (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    removeScheduleJob(scheduler, sched.id);
    db.prepare("DELETE FROM schedules WHERE id = ?").run(sched.id);
    return c.json({ ok: true });
  });

  app.post("/api/schedules/:schedule_id/pause", (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    db.prepare("UPDATE schedules SET is_active = 0, updated_at = ? WHERE id = ?").run(nowIso(), sched.id);
    scheduler.pauseJob(`schedule_${sched.id}`);
    return c.json(enrichResponse(deps, getSchedule(db, sched.id)!));
  });

  app.post("/api/schedules/:schedule_id/resume", (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    // 发闸：plan 没就绪就 resume，作业会点火后被闸拒掉——用户只看到困惑
    if (scheduleNeedsPlan(sched) && sched.plan_status !== "ready") {
      throw new HttpError(409, `Cannot resume schedule with plan_status='${sched.plan_status}'. Call /replan first.`);
    }
    db.prepare("UPDATE schedules SET is_active = 1, updated_at = ? WHERE id = ?").run(nowIso(), sched.id);
    removeScheduleJob(scheduler, sched.id);
    try {
      addScheduleJobFor(scheduler, deps, getSchedule(db, sched.id)!);
    } catch (err: unknown) {
      throw new HttpError(500, `Schedule resumed but job failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return c.json(enrichResponse(deps, getSchedule(db, sched.id)!));
  });

  app.get("/api/schedules/:schedule_id/tasks", (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    const rows = db
      .prepare("SELECT * FROM tasks WHERE schedule_id = ? AND (is_plan_only = 0 OR is_plan_only IS NULL) ORDER BY created_at DESC")
      .all(sched.id) as unknown as TaskRow[];
    const names = creatorNames(db, rows);
    return c.json(rows.map((t) => taskResponse(t, names)));
  });

  app.get("/api/schedules/:schedule_id/plan", (c: Context) => {
    getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    const history = db
      .prepare("SELECT id, status, created_at, completed_at, error FROM tasks WHERE schedule_id = ? AND is_plan_only = 1 ORDER BY created_at DESC LIMIT 10")
      .all(sched.id) as unknown as Record<string, unknown>[];
    return c.json({
      plan_status: sched.plan_status ?? "none",
      plan_version: sched.plan_version ?? 0,
      plan_text: sched.plan,
      plan_error: sched.plan_error,
      current_planning_task_id: sched.current_planning_task_id,
      planning_task_history: history,
      finalize_description: sched.finalize_description,
    });
  });

  app.post("/api/schedules/:schedule_id/trigger", (c: Context) => {
    const user = getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    if (scheduleNeedsPlan(sched) && sched.plan_status !== "ready") {
      throw new HttpError(409, `Schedule cannot fire with plan_status='${sched.plan_status}'. Call /replan first.`);
    }

    // 全店调度按 phase_mode 路由（对齐 cron.py）
    if (sched.store_id === null) {
      if (sched.phase_mode === "single") {
        runSingleJob(deps, {
          scheduleId: sched.id,
          taskTitle: sched.title,
          description: sched.description,
          planMode: Boolean(sched.plan_mode),
          aiProfileId: sched.ai_profile_id,
        });
        return c.json({ ok: true, mode: "single" });
      }
      runFanoutJob(deps, {
        scheduleId: sched.id,
        taskTitle: sched.title,
        description: sched.description,
        planMode: Boolean(sched.plan_mode),
        aiProfileId: sched.ai_profile_id,
      });
      return c.json({ ok: true, mode: "fanout" });
    }

    // 店铺绑定：直接建子任务并提交队列（同 _run_task_job）
    cancelPriorWaiting(deps, sched.id, sched.store_id);
    const taskId = crypto.randomUUID();
    const now = nowIso();
    const planned = Boolean(sched.plan);
    db.prepare(
      `INSERT INTO tasks (id, parent_task_id, store_id, schedule_id, template_id, created_by, assigned_to,
                          title, description, platform, country, status, priority, input_data,
                          plan, plan_history, result, accepted_result, submitted_result, review_gaps,
                          submission_count, transcript_tail, todos, error, error_category,
                          started_at, completed_at, plan_mode, is_plan_only, plan_version,
                          skip_reflection, wait_condition, batch_id, is_finalize, ai_profile_id,
                          session_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 0, NULL,
               ?, NULL, NULL, NULL, NULL, NULL,
               0, NULL, NULL, NULL, NULL,
               NULL, NULL, ?, 0, ?, 0, NULL, NULL, 0, ?, NULL, ?, ?)`,
    ).run(
      taskId,
      sched.store_id,
      sched.id,
      user.id,
      sched.title,
      sched.description || sched.title,
      sched.platform,
      sched.country,
      planned ? "planned" : "pending",
      sched.plan,
      sched.plan_mode ? 1 : 0,
      planned ? (sched.plan_version ?? 0) : null,
      resolveScheduleProfile(db, sched),
      now,
      now,
    );
    bus.emit("schedule_triggered", { schedule_id: sched.id, task_id: taskId, title: sched.title });
    const store = db.prepare("SELECT id, name FROM stores WHERE id = ?").get(sched.store_id) as { id: string; name: string } | undefined;
    deps.orchestrator.enqueueOrLaunch(taskId, {
      mode: planned ? "plan_execute" : "execute",
      store: store ?? null,
      queueWhenSaturated: true,
    });
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    return c.json({ ok: true, task_id: taskId, status: row.status });
  });

  app.post("/api/schedules/:schedule_id/replan", (c: Context) => {
    const user = getCurrentUser(c, auth);
    const sched = getSchedule(db, c.req.param("schedule_id") ?? "");
    if (!sched) throw new HttpError(404, "Schedule not found");
    if (!scheduleNeedsPlan(sched)) {
      throw new HttpError(400, "Schedule does not use plan mode; nothing to plan. Only non-system plan_mode schedules have plans.");
    }
    // 幂等：非终局规划任务在飞就直接返回（不重复起）
    if (sched.current_planning_task_id) {
      const existing = db.prepare("SELECT status FROM tasks WHERE id = ?").get(sched.current_planning_task_id) as { status: string } | undefined;
      if (existing && existing.status !== "completed" && existing.status !== "failed") {
        return c.json(enrichResponse(deps, getSchedule(db, sched.id)!));
      }
    }
    abortCurrentPlanningTask(deps, sched, "Superseded by /replan request.");
    spawnPlanningTask(deps, getSchedule(db, sched.id)!, user.id);
    return c.json(enrichResponse(deps, getSchedule(db, sched.id)!));
  });

  // ── cron 表达式作业 ──
  app.get("/api/cron/jobs", (c: Context) => {
    getCurrentUser(c, auth);
    return c.json(scheduler.listJobs());
  });

  app.post("/api/cron/jobs", async (c: Context) => {
    getCurrentUser(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { job_id?: string; task_title?: string; cron_expression?: string; store_id?: string | null };
    if (!body.job_id || !body.task_title || !body.cron_expression) throw new HttpError(422, "job_id, task_title and cron_expression required");
    try {
      parseCronExpression(body.cron_expression);
    } catch (err: unknown) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    addCronJob(scheduler, deps, { jobId: body.job_id, taskTitle: body.task_title, cronExpression: body.cron_expression, storeId: body.store_id ?? null });
    return c.json({ job_id: body.job_id, cron: body.cron_expression, task_title: body.task_title });
  });

  app.delete("/api/cron/jobs/:job_id", (c: Context) => {
    getCurrentUser(c, auth);
    if (scheduler.removeJob(c.req.param("job_id") ?? "")) return c.json({ ok: true });
    throw new HttpError(404, "Job not found");
  });

  app.post("/api/cron/jobs/:job_id/pause", (c: Context) => {
    getCurrentUser(c, auth);
    if (scheduler.pauseJob(c.req.param("job_id") ?? "")) return c.json({ ok: true });
    throw new HttpError(404, "Job not found");
  });

  app.post("/api/cron/jobs/:job_id/resume", (c: Context) => {
    getCurrentUser(c, auth);
    if (scheduler.resumeJob(c.req.param("job_id") ?? "")) return c.json({ ok: true });
    throw new HttpError(404, "Job not found");
  });

  // ── 计划态 MCP 入口（vibe_seller_register_finalize / get·set_schedule_state） ──

  const loadScheduledTask = (taskId: string): Record<string, unknown> => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!task) throw new HttpError(404, "Task not found");
    if (!task.schedule_id) {
      throw new HttpError(400, "This task has no schedule_id; schedule-state tools are only available to scheduled tasks.");
    }
    return task;
  };

  app.post("/api/tasks/:task_id/register-finalize", async (c: Context) => {
    getCurrentUser(c, auth);
    const task = loadScheduledTask(c.req.param("task_id") ?? "");
    const body = (await c.req.json().catch(() => ({}))) as { description?: string };
    if (!body.description?.trim()) throw new HttpError(422, "description required");
    const sched = getSchedule(db, String(task.schedule_id));
    if (!sched) throw new HttpError(404, "Schedule not found");
    if (sched.store_id !== null || sched.phase_mode !== "fanout") {
      throw new HttpError(
        400,
        `register-finalize only applies to all-stores fanout schedules (the finalize step reduces a per-store batch). This schedule is store_id=${JSON.stringify(sched.store_id)}, phase_mode=${JSON.stringify(sched.phase_mode)}.`,
      );
    }
    db.prepare("UPDATE schedules SET finalize_description = ?, updated_at = ? WHERE id = ?").run(body.description, nowIso(), sched.id);
    return c.json({ ok: true, finalize_description: body.description });
  });

  const validateStateKey = (key: string): void => {
    if (!SCHEDULE_STATE_KEY_RE.test(key)) {
      throw new HttpError(400, "Invalid key: must match [A-Za-z0-9_.-] and be 1-64 chars.");
    }
    if (key.startsWith("_")) {
      throw new HttpError(400, "keys starting with '_' are reserved for server-managed cursors and cannot be read or written via the schedule-state tools.");
    }
  };

  const validateTypedValue = (key: string, value: string): void => {
    if (key !== "email_watermark") return;
    if (!EPOCH_SECONDS_RE.test(value)) {
      throw new HttpError(
        400,
        'value for key=email_watermark must be a unix epoch timestamp in seconds, as an integer string (e.g. "1776441057"). String timestamps are rejected because they are unsafe under lexicographic SQL comparison.',
      );
    }
    const nowEpoch = Math.floor(Date.now() / 1000);
    const epoch = Number.parseInt(value, 10);
    const floor = nowEpoch - EPOCH_PAST_WINDOW_DAYS * 86_400;
    const ceiling = nowEpoch + EPOCH_FUTURE_WINDOW_HOURS * 3600;
    if (epoch < floor || epoch > ceiling) {
      throw new HttpError(
        400,
        `value for key=${key} (${value}) is outside the sane window [now-${EPOCH_PAST_WINDOW_DAYS}d, now+${EPOCH_FUTURE_WINDOW_HOURS}h]. Likely a mentally-translated ISO date with the year off; select the epoch in your SQL via CAST(strftime('%s', date) AS INTEGER) AS epoch and persist that column verbatim — never translate ISO → epoch in your head.`,
      );
    }
  };

  app.get("/api/tasks/:task_id/schedule-state/:key", (c: Context) => {
    getCurrentUser(c, auth);
    const key = c.req.param("key") ?? "";
    validateStateKey(key);
    const task = loadScheduledTask(c.req.param("task_id") ?? "");
    const storeScope = (task.store_id as string | null) ?? "";
    const nowEpoch = Math.floor(Date.now() / 1000);
    const state = db
      .prepare("SELECT * FROM schedule_state WHERE schedule_id = ? AND store_id = ? AND key = ?")
      .get(String(task.schedule_id), storeScope, key) as Record<string, unknown> | undefined;
    if (!state) {
      // 空命中常是模型幻觉了键名——回出已有键集让它自纠；服务器管理的 `_` 前缀键不暴露
      const existing = db
        .prepare("SELECT key FROM schedule_state WHERE schedule_id = ? AND store_id = ?")
        .all(String(task.schedule_id), storeScope) as unknown as { key: string }[];
      return c.json({
        key,
        value: null,
        updated_at: null,
        updated_by_task_id: null,
        other_known_keys: existing.map((r) => r.key).filter((k) => !k.startsWith("_")).sort(),
        now_epoch: nowEpoch,
      });
    }
    return c.json({
      key: state.key,
      value: state.value,
      updated_at: state.updated_at,
      updated_by_task_id: state.updated_by_task_id,
      now_epoch: nowEpoch,
    });
  });

  app.put("/api/tasks/:task_id/schedule-state/:key", async (c: Context) => {
    getCurrentUser(c, auth);
    const key = c.req.param("key") ?? "";
    validateStateKey(key);
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!value) throw new HttpError(422, "value required");
    validateTypedValue(key, value);
    const task = loadScheduledTask(c.req.param("task_id") ?? "");
    const storeScope = (task.store_id as string | null) ?? "";
    // Email 水位下限（_email_watermark_floor，4.6 收回 email 分支）：有链接邮箱账户的
    // 店铺，email_watermark 只能推进到 get_new_emails 展示给 agent 的位置——
    // floor 由 new-emails 端点服务器侧维护（MAX 原子单调），这里拒绝更低的值，
    // 防止 agent 从 Date 头手推游标导致下一轮重扫已处理邮件（原 e2e 泄漏事故）。
    if (key === "email_watermark" && storeHasEmailAccounts(db, String(task.store_id ?? ""))) {
      const floor = getWatermarkFloor(db, String(task.schedule_id), storeScope);
      if (floor === null) {
        throw new HttpError(
          400,
          "This store has linked email account(s): call vibe_seller_get_new_emails first and persist its `next_watermark` verbatim. The watermark must come from that tool (it keys off the fetched_at axis the reader filters on) — do not set email_watermark by hand or from an email Date header.",
        );
      }
      if (Number.parseInt(value, 10) < floor) {
        throw new HttpError(
          400,
          `value ${value} is below the email-watermark floor ${floor} — the newest email vibe_seller_get_new_emails has shown you. Persisting it would re-sweep already-processed emails next run. Persist the \`next_watermark\` from get_new_emails verbatim; never derive the watermark from an email Date header.`,
        );
      }
    }
    const now = nowIso();
    db.prepare(
      `INSERT INTO schedule_state (schedule_id, store_id, key, value, updated_at, updated_by_task_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(schedule_id, store_id, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at, updated_by_task_id = excluded.updated_by_task_id`,
    ).run(String(task.schedule_id), storeScope, key, value, now, String(task.id));
    return c.json({ ok: true, key, value, updated_at: now, updated_by_task_id: task.id });
  });

  // ── 广告任务声明（vibe_seller_declare_ad_task） ──

  const asDict = (r: Record<string, unknown>): Record<string, unknown> => {
    let scope: unknown = {};
    try {
      scope = JSON.parse(String(r.scope ?? "{}"));
    } catch {
      scope = {};
    }
    return {
      seq: r.seq,
      kind: r.kind,
      scope: typeof scope === "object" && scope !== null ? scope : {},
      user_turn: r.user_turn,
      created_at: r.created_at,
    };
  };


  // ── email 水位下限与 new-emails（4.6 收回，tasks_schedule_state.py 的 email 分支） ──

  const storeHasEmailAccounts = (database: DatabaseSync, storeId: string): boolean => {
    if (!storeId) return false;
    return Boolean(database.prepare("SELECT id FROM store_email_links WHERE store_id = ? LIMIT 1").get(storeId));
  };

  const getWatermarkFloor = (database: DatabaseSync, scheduleId: string, storeScope: string): number | null => {
    const row = database
      .prepare("SELECT value FROM schedule_state WHERE schedule_id = ? AND store_id = ? AND key = '_email_watermark_floor'")
      .get(scheduleId, storeScope) as { value: string | null } | undefined;
    if (!row || !row.value) return null;
    return Number.parseInt(row.value, 10);
  };

  const emailStore = new EmailStore(`${deps.config.homeDir}/data/email_dbs`);

  // new-emails：服务器侧水位清扫。读 email_watermark 游标（无则 lookback_hours 回看），
  // 查各链接账户 per-account DB，返回严格更新的邮件 + next_watermark；floor 原子
  // MAX 单调推进（ON CONFLICT 取 CAST 后两值最大，防并发回退）。
  app.get("/api/tasks/:task_id/new-emails", (c: Context) => {
    getCurrentUser(c, auth);
    const task = loadScheduledTask(c.req.param("task_id") ?? "");
    if (!task.store_id) {
      throw new HttpError(400, "new-emails requires a store-scoped scheduled task; this task has no store_id.");
    }
    const storeScope = String(task.store_id);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const state = db
      .prepare("SELECT value FROM schedule_state WHERE schedule_id = ? AND store_id = ? AND key = 'email_watermark'")
      .get(String(task.schedule_id), storeScope) as { value: string | null } | undefined;
    let sinceEpoch: number;
    let firstRun: boolean;
    if (state && state.value) {
      sinceEpoch = Number.parseInt(state.value, 10);
      firstRun = false;
    } else {
      const lookbackHours = Number.parseInt(c.req.query("lookback_hours") ?? "24", 10);
      sinceEpoch = nowEpoch - Math.max(1, Number.isNaN(lookbackHours) ? 24 : lookbackHours) * 3600;
      firstRun = true;
    }

    const accounts = db
      .prepare(
        `SELECT a.* FROM email_accounts a JOIN store_email_links l ON l.email_account_id = a.id WHERE l.store_id = ?`,
      )
      .all(storeScope) as { id: string; email: string }[];

    const accountsOut: Record<string, unknown>[] = [];
    let total = 0;
    let nextWatermark = sinceEpoch;
    const folder = c.req.query("folder") ?? "INBOX";
    for (const acct of accounts) {
      emailStore.initEmailDb(acct.id);
      const { emails, maxEpoch } = emailStore.getNewEmailsSince(acct.id, sinceEpoch, folder);
      nextWatermark = Math.max(nextWatermark, maxEpoch);
      total += emails.length;
      accountsOut.push({ account_id: acct.id, email: acct.email, new_emails: emails });
    }

    const floorNow = nowIso();
    db.prepare(
      `INSERT INTO schedule_state (schedule_id, store_id, key, value, updated_at, updated_by_task_id)
       VALUES (?, ?, '_email_watermark_floor', ?, ?, ?)
       ON CONFLICT(schedule_id, store_id, key) DO UPDATE SET
         value = CAST(MAX(CAST(excluded.value AS INTEGER), CAST(schedule_state.value AS INTEGER)) AS TEXT),
         updated_at = excluded.updated_at,
         updated_by_task_id = excluded.updated_by_task_id`,
    ).run(String(task.schedule_id), storeScope, String(nextWatermark), floorNow, String(task.id));

    return c.json({
      key: "email_watermark",
      first_run: firstRun,
      watermark_used: sinceEpoch,
      now_epoch: nowEpoch,
      count: total,
      next_watermark: String(nextWatermark),
      accounts: accountsOut,
      next_action:
        "Report each new_emails body verbatim, then call vibe_seller_set_schedule_state('email_watermark', next_watermark). Do NOT query the email DB with a raw sqlite SELECT for this sweep.",
    });
  });

  app.get("/api/tasks/:task_id/ad-declarations", (c: Context) => {
    getCurrentUser(c, auth);
    const rows = db
      .prepare("SELECT * FROM ad_task_declarations WHERE task_id = ? ORDER BY seq ASC")
      .all(c.req.param("task_id") ?? "") as unknown as Record<string, unknown>[];
    return c.json(rows.map(asDict));
  });

  app.post("/api/tasks/:task_id/ad-declaration", async (c: Context) => {
    getCurrentUser(c, auth);
    const taskId = c.req.param("task_id") ?? "";
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new HttpError(404, "Task not found");
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string; scope?: unknown };
    const kind = (body.kind ?? "").trim().toLowerCase();
    if (!AD_TASK_KINDS.has(kind)) {
      throw new HttpError(400, `kind must be one of ${[...AD_TASK_KINDS].sort().join(",")}. Note there is no "edit" kind — a request to change a few bids is kind="audit" with those campaigns in scope.`);
    }
    const scope = normaliseScope(body.scope);
    const turns = (db.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND role = 'user'").get(taskId) as { n: number }).n;
    const prev = db
      .prepare("SELECT * FROM ad_task_declarations WHERE task_id = ? ORDER BY seq DESC LIMIT 1")
      .get(taskId) as Record<string, unknown> | undefined;

    const insert = (seq: number): Record<string, unknown> => {
      const row = { task_id: taskId, seq, kind, scope: JSON.stringify(scope), user_turn: turns, created_at: nowIso() };
      db.prepare("INSERT INTO ad_task_declarations (id, task_id, seq, kind, scope, user_turn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        crypto.randomUUID(),
        taskId,
        seq,
        kind,
        row.scope,
        turns,
        row.created_at,
      );
      // 停闸门同步读的是工作区镜像（行是权威，镜像是副本）
      writeDeclarationFile(config.homeDir, taskId, kind, scope);
      return { seq, kind, scope, user_turn: turns, created_at: row.created_at };
    };

    if (prev && turns <= Number(prev.user_turn ?? 0)) {
      let prevScope: AdScope = {};
      try {
        prevScope = normaliseScope(JSON.parse(String(prev.scope ?? "{}")));
      } catch {
        prevScope = {};
      }
      if (supersedes(String(prev.kind), prevScope, kind, scope)) {
        return c.json(insert(Number(prev.seq ?? 0) + 1));
      }
      throw new HttpError(
        409,
        `This task already declared kind="${String(prev.kind)}" for the current turn, and this call neither NARROWS it nor corrects it upward.\nThe two legal in-turn moves are:\n1. NARROW at the same kind — same marketplaces, and a campaign list that goes from "all of them" to a named subset. That is how you record campaign ids you could only learn by enumerating the account.\n2. Correct kind="investigate" to kind="audit" when the work turned out to produce bid/pause/negate decisions rather than just figures — same marketplaces or fewer, same campaigns or fewer. This one exists so an under-declared phase can still hand the user a review console instead of deleting its recommendations.\nYou cannot add a marketplace, widen the campaign list, or move to a kind that owes LESS than the one you declared (audit → investigate is refused). A wider scope needs a new message from the USER. Work within what you declared, or say in your result why it does not fit and let them redirect you.`,
      );
    }
    return c.json(insert(prev ? Number(prev.seq ?? 0) + 1 : 1));
  });
}
