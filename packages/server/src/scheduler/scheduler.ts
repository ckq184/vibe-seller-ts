// 调度器（批次 4.4）：APScheduler AsyncIOScheduler 的 TS 等价物。
// Schedule 表是唯一事实源（原 MemoryJobStore 同哲学）：作业在内存里，
// 启动时 rebuild_schedule_jobs() 重建；create/update/delete/pause/resume 即时同步。
//
// 语义对齐：
//   - max_instances=1 + coalesce：上一发还在跑就跳过本次（错过即丢，不排队补）；
//   - next_run 在开跑前置好（错过也不会自旋重放）；
//   - interval 系统作业每次启动重新锚定（原 APScheduler 'interval' 无 start_date 同语义）；
//   - schedule 作业的 interval 网格锚在 created_at，重启不漂移（triggers.ts）。

import { buildTrigger, cronNextRun, parseCronExpression, type CronFields, type NextRunFn } from "../schedule/triggers";
import { validateTimezone } from "../schedule/tz";
import { getServerTimezone } from "./util";
import { runFanoutJob, runSingleJob, runTaskJob, type SchedulerDeps, type ScheduleRow } from "./fire";
import { checkWaitingTasks, cleanupOldTasks, reapFinalizedBatches, reapStalledRunningTasks, reapStuckPlanningTasks, recoverTasksFromDb } from "./reapers";
import { syncAllEmailAccounts } from "./emailSync";
import type { BrowserStarter } from "../browser/starter";

export interface JobSpec {
  id: string;
  name: string;
  nextRunFn: NextRunFn;
  runner: () => void | Promise<void>;
  triggerDesc: string;
}

interface Job extends JobSpec {
  nextRunAt: Date | null;
  paused: boolean;
  running: boolean;
}

export interface SystemJobsHandle {
  schedulerId: string;
  jobIds: string[];
}

export class VibeScheduler {
  private readonly jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly tickMs = 20_000,
  ) {}

  addJob(spec: JobSpec, opts?: { paused?: boolean; firstFireAfter?: Date }): void {
    const now = new Date();
    this.jobs.set(spec.id, {
      ...spec,
      paused: opts?.paused ?? false,
      running: false,
      nextRunAt: opts?.paused ? null : (spec.nextRunFn(opts?.firstFireAfter ?? now) ?? null),
    });
  }

  removeJob(id: string): boolean {
    return this.jobs.delete(id);
  }

  pauseJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.paused = true;
    job.nextRunAt = null;
    return true;
  }

  resumeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.paused = false;
    job.nextRunAt = job.nextRunFn(new Date());
    return true;
  }

  hasJob(id: string): boolean {
    return this.jobs.has(id);
  }

  nextRun(id: string): string | null {
    const job = this.jobs.get(id);
    return job?.nextRunAt ? job.nextRunAt.toISOString() : null;
  }

  listJobs(): { job_id: string; name: string; next_run: string | null; paused: boolean; trigger: string }[] {
    // 原 list_cron_jobs 走 APScheduler get_jobs()——按 next_run_time 升序
    // （批次 4.7.2 录制 fixture 钉死顺序：1m 组 → 5m 组 → 15m → cron 任务）。
    return [...this.jobs.values()]
      .sort((a, b) => (a.nextRunAt?.getTime() ?? Infinity) - (b.nextRunAt?.getTime() ?? Infinity))
      .map((job) => ({
        job_id: job.id,
        name: job.name,
        next_run: job.nextRunAt ? job.nextRunAt.toISOString() : null,
        paused: job.paused,
        trigger: job.triggerDesc,
      }));
  }

  /** 推进一拍：所有到点作业开跑（跑者内部自行容错）。测试直接调用以保确定性。 */
  tick(now = new Date()): void {
    for (const job of this.jobs.values()) {
      if (job.paused || job.running || !job.nextRunAt) continue;
      if (now < job.nextRunAt) continue;
      job.nextRunAt = job.nextRunFn(now); // 先置下一发：跑者异常也不会自旋重放
      if (job.nextRunAt && job.nextRunAt <= now) job.nextRunAt = job.nextRunFn(new Date(job.nextRunAt.getTime() + 1));
      job.running = true;
      void (async () => {
        try {
          await job.runner();
        } catch (err: unknown) {
          console.error(`[vibe-scheduler] job ${job.id} failed:`, err);
        } finally {
          job.running = false;
        }
      })();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async idle(): Promise<void> {
    // 等所有在跑作业收尾（测试/停机用）
    while ([...this.jobs.values()].some((j) => j.running)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

// ── schedule → 作业 ──

// ── APScheduler str(trigger) 等价格式（/api/cron/jobs 的 trigger 字段契约，
// 批次 4.7.2 录制 fixture 钉死）：interval → 'interval[0:01:00]'；
// cron → "cron[month='1', day='1', hour='3', minute='0']"，字段顺序
// month day day_of_week hour minute（'*'/null 不受限字段省略）。

/** timedelta str 的 [H:MM:SS] 形状（APScheduler 小时不补零：'0:01:00'）。
 * ≥24h 时 Python timedelta str 带 "N day(s), " 前缀且单复数分立（timedelta
 * hours=25 → '1 day, 1:00:00'）——str(IntervalTrigger) 即
 * 'interval[7 days, 0:00:00]'。批次 4.7 整改 D：录制
 * cron_list_with_interval_schedule（minutes=10080）钉死，此前 TS 误产出
 * 'interval[168:00:00]'。 */
function intervalTriggerDesc(ms: number): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const rest = totalSeconds % 86_400;
  const h = Math.floor(rest / 3_600);
  const m = Math.floor((rest % 3_600) / 60);
  const s = rest % 60;
  const hms = `${h}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `interval[${days} ${days === 1 ? "day" : "days"}, ${hms}]` : `interval[${hms}]`;
}

function sortedNums(set: Set<number> | null): string | null {
  if (set === null) return null;
  return [...set].sort((a, b) => a - b).join(",");
}

function cronTriggerDesc(fields: CronFields): string {
  const parts: string[] = [];
  const month = sortedNums(fields.month);
  if (month !== null) parts.push(`month='${month}'`);
  const dom = sortedNums(fields.dom);
  if (dom !== null) parts.push(`day='${dom}'`);
  const dow = sortedNums(fields.dow);
  if (dow !== null) parts.push(`day_of_week='${dow}'`);
  parts.push(`hour='${sortedNums(fields.hour)}'`);
  parts.push(`minute='${sortedNums(fields.minute)}'`);
  return `cron[${parts.join(", ")}]`;
}

/** schedule 行 → APScheduler 风格 trigger 描述（days interval=1 为 fixture 可观测面）。 */
function scheduleTriggerDesc(sched: ScheduleRow): string {
  const h = (sched.schedule_time ?? "00:00").split(":")[0] ?? "0";
  const m = (sched.schedule_time ?? "00:00").split(":")[1] ?? "0";
  const interval = Math.max(1, sched.interval_value ?? 1);
  const hh = String(Number.parseInt(h, 10) || 0);
  const mm = String(Number.parseInt(m, 10) || 0);
  if (sched.schedule_type === "minutes") return intervalTriggerDesc(interval * 60_000);
  if (sched.schedule_type === "hours") return intervalTriggerDesc(interval * 3_600_000);
  if (sched.schedule_type === "days") {
    return interval === 1 ? `cron[hour='${hh}', minute='${mm}']` : `cron[day='*/${interval}', hour='${hh}', minute='${mm}']`;
  }
  if (sched.schedule_type === "weekly") {
    // APScheduler 对 day_of_week 输出名字（Mon=0..Sun=6，原 CronTrigger 语义）
    const names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const day = sched.schedule_day !== null ? names[(sched.schedule_day - 1) % 7] : undefined;
    const dayPart = day !== undefined && interval === 1 ? `day_of_week='${day}', ` : "";
    return `cron[${dayPart}hour='${hh}', minute='${mm}']`;
  }
  return `cron[day='${sched.schedule_day ?? 1}', hour='${hh}', minute='${mm}']`;
}

/** add_schedule_job_for：Schedule 行 → 调度作业（store/fanout/single 按 phase_mode 路由）。 */
export function addScheduleJobFor(scheduler: VibeScheduler, deps: SchedulerDeps, sched: ScheduleRow): void {
  const nextRunFn = buildTrigger({
    scheduleType: sched.schedule_type,
    scheduleTime: sched.schedule_time,
    scheduleDay: sched.schedule_day,
    intervalValue: sched.interval_value ?? 1,
    timezone: sched.timezone,
    anchor: sched.created_at,
  });
  const runner = () => {
    if (sched.store_id) {
      runTaskJob(deps, {
        taskTitle: sched.title,
        storeId: sched.store_id,
        scheduleId: sched.id,
        description: sched.description,
        planMode: Boolean(sched.plan_mode),
        aiProfileId: sched.ai_profile_id,
      });
    } else if (sched.phase_mode === "single") {
      runSingleJob(deps, {
        scheduleId: sched.id,
        taskTitle: sched.title,
        description: sched.description,
        planMode: Boolean(sched.plan_mode),
        aiProfileId: sched.ai_profile_id,
      });
    } else {
      runFanoutJob(deps, {
        scheduleId: sched.id,
        taskTitle: sched.title,
        description: sched.description,
        planMode: Boolean(sched.plan_mode),
        aiProfileId: sched.ai_profile_id,
      });
    }
  };
  scheduler.addJob({
    id: `schedule_${sched.id}`,
    name: sched.title,
    nextRunFn,
    runner,
    triggerDesc: scheduleTriggerDesc(sched),
  });
}

export function removeScheduleJob(scheduler: VibeScheduler, scheduleId: string): boolean {
  return scheduler.removeJob(`schedule_${scheduleId}`);
}

/** rebuild_schedule_jobs：启动时把所有 active 调度重建为作业。 */
export function rebuildScheduleJobs(scheduler: VibeScheduler, deps: SchedulerDeps): number {
  const rows = deps.db.prepare("SELECT * FROM schedules WHERE is_active = 1").all() as unknown as ScheduleRow[];
  let count = 0;
  for (const sched of rows) {
    try {
      addScheduleJobFor(scheduler, deps, sched);
      count += 1;
    } catch (err: unknown) {
      console.error(`[vibe-scheduler] failed to rebuild job for schedule ${sched.id}:`, err);
    }
  }
  return count;
}

/** 裸 cron 表达式作业（/api/cron）。字段数/值非法抛错 → 路由 400。 */
export function addCronJob(
  scheduler: VibeScheduler,
  deps: SchedulerDeps,
  opts: { jobId: string; taskTitle: string; cronExpression: string; storeId?: string | null },
): void {
  const fields: CronFields = parseCronExpression(opts.cronExpression);
  scheduler.addJob({
    id: opts.jobId,
    name: opts.taskTitle,
    nextRunFn: (after) => cronNextRun(fields, after, getServerTimezone(deps)),
    runner: () => {
      runTaskJob(deps, { taskTitle: opts.taskTitle, storeId: opts.storeId ?? null, scheduleId: null });
    },
    triggerDesc: cronTriggerDesc(fields),
  });
}

// ── 系统周期作业（start_scheduler） ──

export interface SchedulerBootResult {
  scheduler: VibeScheduler;
  rebuilt: number;
  recovered: { resumed: number; marked: number };
  systemJobIds: string[];
}

/**
 * start_scheduler 等价：注册 7 个系统周期作业 + 重建 schedule 作业 + 任务队列恢复。
 * email_sync（4.6：全账户 IMAP → per-account SQLite，信号量并发 3）与
 * idle_browser_sweeper（4.6：无活跃任务绑定且空闲 ≥ VIBE_BROWSER_IDLE_S 的浏览器
 * 停掉，0 禁用）已接入；测试可用 deps.emailSyncFn/idleSweepFn 覆盖本体。
 * 传入 opts.scheduler 时复用该实例（路由层已装配的同一个），否则新建。
 */
export function startScheduler(deps: SchedulerDeps, opts?: { scheduler?: VibeScheduler; tickMs?: number; withSystemJobs?: boolean; recover?: boolean; browserSweeper?: BrowserStarter }): SchedulerBootResult {
  const scheduler = opts?.scheduler ?? new VibeScheduler(deps, opts?.tickMs ?? 20_000);
  const browserSweeper = opts?.browserSweeper;
  const systemJobIds: string[] = [];

  const interval = (id: string, name: string, ms: number, runner: () => void | Promise<void>) => {
    const start = new Date(Date.now() + ms);
    scheduler.addJob(
      { id, name, nextRunFn: (after) => new Date(after.getTime() + ms), runner, triggerDesc: intervalTriggerDesc(ms) },
      { firstFireAfter: start },
    );
    systemJobIds.push(id);
  };

  // name 一律用 runner 函数名——APScheduler 的 job.name 缺省取 func.__name__，
  // /api/cron/jobs 的 name 字段契约（批次 4.7.2 fixture：'check_waiting_tasks' 等）。
  if (opts?.withSystemJobs !== false) {
    interval("waiting_checker", "check_waiting_tasks", 15 * 60_000, () => {
      checkWaitingTasks(deps);
    });
    interval("email_sync", "sync_all_email_accounts", 5 * 60_000, () => {
      if (deps.emailSyncFn) return void deps.emailSyncFn();
      if (deps.jwtSecret) void syncAllEmailAccounts(deps.db, deps.config.homeDir, deps.jwtSecret).catch(() => undefined);
    });
    interval("plan_reaper", "reap_stuck_planning_tasks", 5 * 60_000, () => {
      reapStuckPlanningTasks(deps);
    });
    interval("stall_reaper", "reap_stalled_running_tasks", 60_000, () => {
      reapStalledRunningTasks(deps);
    });
    interval("idle_browser_sweeper", "sweep_idle_browsers", 60_000, () => {
      if (deps.idleSweepFn) return void deps.idleSweepFn();
      if (browserSweeper) {
        const idleS = Number.parseInt(process.env.VIBE_BROWSER_IDLE_S ?? "300", 10);
        void browserSweeper.sweepIdleBrowsers(Number.isNaN(idleS) ? 300 : idleS).catch(() => undefined);
      }
    });
    interval("finalize_reaper", "reap_finalized_batches", 60_000, () => {
      reapFinalizedBatches(deps);
    });
    // 每日 03:30 服务器时区（低活跃窗口）
    const serverTz = getServerTimezone(deps);
    if (!validateTimezone(serverTz)) throw new Error(`Invalid timezone: ${serverTz}`);
    const cleanupFields = parseCronExpression("30 3 * * *");
    scheduler.addJob({
      id: "task_cleanup",
      name: "cleanup_old_tasks",
      nextRunFn: (after) => cronNextRun(cleanupFields, after, serverTz),
      runner: () => {
        cleanupOldTasks(deps);
      },
      triggerDesc: cronTriggerDesc(cleanupFields),
    });
    systemJobIds.push("task_cleanup");
  }

  const recovered = opts?.recover === false ? { resumed: 0, marked: 0 } : recoverTasksFromDb(deps);
  const rebuilt = rebuildScheduleJobs(scheduler, deps);
  scheduler.start();
  return { scheduler, rebuilt, recovered, systemJobIds };
}
