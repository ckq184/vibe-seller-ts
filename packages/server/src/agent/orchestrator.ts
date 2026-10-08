// 任务编排器：批次 4.3。把 agent 执行接进 @vibe/runtime（进程内复用 @vibe/bridge 的
// translator/MCP 客户端/profiles），事件翻译成 event_bus 契约（SSE + task_messages 落库），
// 终局走 outcome 裁决（accepted > submitted > transcript_tail > FAILED，唯一裁判）。
//
// 三条竞态修复从桥 server 移植（见 packages/bridge/src/server.ts）：
//   1. awaiting_human → 保持开放等批复（run 活着，不终局）
//   2. abort 与门挂起乱序 → 直接登记 cancelled 终局
//   3. done 恰好一帧（sawDone 防重发）
// runId 同源：桥同款 newRunId 注入（曾因双 ID resume 落 "unknown run"）。

import { join } from "node:path";
import { AgentRuntime, JsonlRunLog, MemorySessionStore, type RunHandle } from "@vibe/runtime";
import { createTranslator, defaultBudget, type RunFactoryResult } from "@vibe/bridge";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../config";
import { canTransition } from "../task_states";
import { sendTaskCompleted, sendTaskFailed, sendTaskResumed, TaskFailureCategory, TaskFailurePhase } from "../telemetry/tasks";
import { applyOutcome, resolveOutcome } from "./outcome";
import { buildRunPrompt, type RunMode } from "./prompt";

export interface EngineFactoryResult {
  engine: RunFactoryResult["engine"];
  tools: RunFactoryResult["tools"];
  gates?: RunFactoryResult["gates"];
  dispose?: () => Promise<void>;
}

export type EngineFactory = (ctx: { taskId: string; profileId: string }) => Promise<EngineFactoryResult>;

export interface OrchestratorDeps {
  config: ServerConfig;
  db: DatabaseSync;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  engineFactory: EngineFactory;
  maxConcurrent?: number;
}

export interface LaunchOptions {
  mode: RunMode;
  store?: { id: string; name: string } | null;
  history?: { role: string; content: string }[];
  profileId?: string;
  /** 入队转 queued 后排水重启时保留的原始意图。 */
  queuedFrom?: "start" | "wake";
  /**
   * 背景火源（调度器 fanout/single/finalize/唤醒）在并发饱和时进队排队而不是拒绝——
   * 用户手动 start 的 409 契约不适用于系统自动触发（原 task_queue 无拒绝语义）。
   */
  queueWhenSaturated?: boolean;
}

interface RunEntry {
  runId: string;
  taskId: string;
  mode: RunMode;
  abort: AbortController;
  runtime: AgentRuntime;
  dispose?: () => Promise<void>;
  gateSeq: number;
  pendingGateRequestId?: string;
  awaiting: boolean;
  finished: boolean;
  /** 当前（或最近一个）run handle；resume 前必须等它的 done——RunLog 单写者。 */
  handle?: RunHandle;
  /** 本 run 曾在确认闸门挂起并被保持开放；此后旧 consume 的 settle 无权终局。 */
  gateHeld?: boolean;
  /** 批复已受理、resume 排队在 prev.done 之后：旧 consume 的 settle 在此窗口无权终局。 */
  resuming?: boolean;
  /** 停止已请求。与闸门锁存的到达顺序不定：锁存在后也要补终局。 */
  stopRequested?: boolean;
  /** 事件流崩溃（未处理异常）：终局 phase 记 'pipeline'（原 TaskFailurePhase 映射）。 */
  pipelineError?: boolean;
}

export type EnqueueResult = "launched" | "queued" | "rejected";

export class TaskOrchestrator {
  private readonly running = new Map<string, RunEntry>();
  private readonly queuedOpts = new Map<string, LaunchOptions>();
  private readonly queues = new Map<string | null, string[]>(); // storeId → FIFO；null 泳道 = 无店铺任务
  private active = 0;

  constructor(private readonly deps: OrchestratorDeps) {}

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** 等全部在飞 run 收尾（含排队排空）；测试/优雅停机用。门挂起的条目不算在飞终局——调用方需自行批复。 */
  async idle(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.running.size === 0 && this.queues.size === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  pendingQuestions(taskId: string): { pending: true; request_id: string; questions: unknown[] } | { pending: false } {
    const entry = this.running.get(taskId);
    if (!entry?.pendingGateRequestId) return { pending: false };
    return { pending: true, request_id: entry.pendingGateRequestId, questions: [{ kind: "tool_approval" }] };
  }

  private storeBusy(storeId: string | null): boolean {
    if (!storeId) return false;
    for (const taskId of this.running.keys()) {
      if (this.storeOf(taskId) === storeId) return true;
    }
    return (this.queues.get(storeId)?.length ?? 0) > 0;
  }

  private storeOf(taskId: string): string | null {
    const row = this.deps.db.prepare("SELECT store_id FROM tasks WHERE id = ?").get(taskId) as
      | { store_id: string | null }
      | undefined;
    return row?.store_id ?? null;
  }

  /**
   * 店铺任务进 per-store FIFO（队列里排 QUEUED），无店铺任务直启；全局并发饱和时
   * 无店铺任务拒绝。状态转移由本方法执行（queued→running 的转移在排水时发生）。
   */
  enqueueOrLaunch(taskId: string, opts: LaunchOptions): EnqueueResult {
    // 唤醒遥测（原 execute_woken_task 入口）：必须在清 wait_condition / 状态转移前读
    if (opts.mode === "woken") sendTaskResumed(this.deps.db, this.deps.config.homeDir, taskId);
    const max = this.deps.maxConcurrent ?? 2;
    const storeId = this.storeOf(taskId);
    if (this.storeBusy(storeId) || this.active >= max) {
      if (!storeId && !opts.queueWhenSaturated) return "rejected";
      const lane = storeId ?? null; // null 泳道 = 无店铺任务（原 task_queue 同款）
      const q = this.queues.get(lane) ?? [];
      q.push(taskId);
      this.queues.set(lane, q);
      this.queuedOpts.set(taskId, opts);
      this.transition(taskId, "queued");
      return "queued";
    }
    this.transition(taskId, "running");
    void this.start(taskId, opts);
    return "launched";
  }

  transition(taskId: string, to: string): boolean {
    const row = this.deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    if (!row) return false;
    if (!canTransition(row.status, to)) return false;
    const now = new Date().toISOString();
    // 占位与实参必须同步生成：非 running 转移没有 started_at 占位
    const sql = `UPDATE tasks SET status = ?, ${to === "running" ? "started_at = COALESCE(started_at, ?), " : ""}updated_at = ? WHERE id = ?`;
    this.deps.db.prepare(sql).run(...(to === "running" ? [to, now, now, taskId] : [to, now, taskId]));
    this.deps.bus.emit("task_update", { task_id: taskId, status: to });
    return true;
  }

  /** 直接启动一个 run（调用方已做状态守卫与转移，如 design→DESIGNING）。 */
  async start(taskId: string, opts: LaunchOptions): Promise<void> {
    const { db, config } = this.deps;
    // 并发计数同步推进：engineFactory 是异步的，若等工厂返回再计数，
    // 连续排水/入队会读到过期计数而超额启动。
    this.active += 1;
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!task) {
      this.active -= 1;
      throw new Error(`unknown task: ${taskId}`);
    }

    const profileId = (opts.profileId ?? (task.ai_profile_id as string | null) ?? "default") || "default";
    let per: EngineFactoryResult;
    try {
      per = await this.deps.engineFactory({ taskId, profileId });
    } catch (err: unknown) {
      // 引擎工厂失败（无 key / profile 未知 / MCP 拉起失败）：任务落 FAILED，绝不悬死
      this.active -= 1;
      const now = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
      if (row) {
        db.prepare("UPDATE tasks SET error = ?, error_category = 'engine_factory_failed', status = ?, updated_at = ? WHERE id = ?").run(
          `engine factory failed: ${message}`,
          canTransition(row.status, "failed") ? "failed" : row.status,
          now,
          taskId,
        );
        this.deps.bus.emit("task_update", { task_id: taskId, status: "failed", error: `engine factory failed: ${message}` });
        // 遥测：run 尚未起飞即失败 → phase=pre_running（原 pre-run 检查失败路径的
        // TS 等价点）；error_category 已落 DB（'engine_factory_failed'），优先于兜底。
        const fresh = db.prepare("SELECT id, store_id, schedule_id, plan_mode, ai_profile_id, started_at, completed_at, error_category FROM tasks WHERE id = ?").get(taskId) as
          | Parameters<typeof sendTaskFailed>[2]
          | undefined;
        if (fresh) {
          sendTaskFailed(db, config.homeDir, fresh, TaskFailurePhase.PRE_RUNNING, TaskFailureCategory.AGENT_SET_ERROR);
        }
      }
      return;
    }

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const abort = new AbortController();
    const runtime = new AgentRuntime({
      core: { step: async () => ({ kind: "respond", content: "" }) },
      runLog: new JsonlRunLog(join(config.dataDir, "ts-runs")),
      sessions: new MemorySessionStore(),
      budget: defaultBudget(),
      engine: per.engine,
      tools: per.tools,
      ...(per.gates ? { gates: per.gates } : {}),
      newRunId: () => runId, // 同源：注册表 runId = RunLog runId
    });

    const built = buildRunPrompt(config, {
      task: {
        id: taskId,
        title: task.title as string,
        description: (task.description as string | null) ?? null,
        platform: (task.platform as string | null) ?? null,
        country: (task.country as string | null) ?? null,
        store_id: (task.store_id as string | null) ?? null,
        wait_condition: (task.wait_condition as string | null) ?? null,
        plan: (task.plan as string | null) ?? null,
      },
      mode: opts.mode,
      store: opts.store ?? null,
      history: opts.history ?? [],
    });

    const entry: RunEntry = {
      runId,
      taskId,
      mode: opts.mode,
      abort,
      runtime,
      dispose: per.dispose,
      gateSeq: 0,
      awaiting: false,
      finished: false,
    };
    this.running.set(taskId, entry);

    // 非 chat 跟进：落用户 prompt（首行头部说明之后的正文）；chat 的用户消息由路由先落
    if (opts.mode !== "chat") {
      const bodyText = built.prompt.split("\n\n").slice(1).join("\n\n");
      this.insertMessage(taskId, "user", bodyText || built.prompt);
    }

    const handle = runtime.run({ id: taskId, input: { prompt: built.prompt, mode: opts.mode, profile_id: profileId } }, abort.signal);
    entry.handle = handle;
    this.consume(entry, handle);
  }

  stop(taskId: string): boolean {
    const entry = this.running.get(taskId);
    if (!entry) return false;
    entry.abort.abort();
    // 挂起中的 run：runtime episode 已结束，abort 无处可去 —— 直接终局
    //（等价 CLI 停掉停在提问的进程 / 桥的 stop-on-awaiting）。若 episode 还在跑，
    // abort 会让引擎走 cancelled，settle 的 finished 守卫保证只收一次。
    entry.stopRequested = true;
    if ((entry.awaiting || entry.gateHeld) && !entry.resuming) {
      // 已挂起：runtime episode 已结束，abort 无处可去 —— 直接终局（等价 CLI 停掉
      // 停在提问的进程）。若 stop 抢在闸门事件之前，锁存后的 settle 会补终局。
      this.finish(entry, { status: "cancelled", result_text: "" });
    }
    return true;
  }

  /** 批复确认闸门：批准/拒绝经 runtime.resume 续写同一 run。 */
  answer(taskId: string, requestId: string, answers: Record<string, unknown>): boolean {
    const entry = this.running.get(taskId);
    if (!entry || entry.finished || !entry.awaiting || entry.pendingGateRequestId !== requestId) return false;
    const approved = answers.approved !== false;
    entry.pendingGateRequestId = undefined;
    entry.awaiting = false;
    // 等上一 episode 真正收尾（usage_reported 落盘、done 结算）再 resume：
    // RunLog 是单写者，episodes 并发写会撞 sequence、偶发"no replayable state"。
    // resuming 置位必须同步：旧 consume 的 settle 在"批复受理→resume 起飞"窗口里
    // 看到 awaiting=false 会误走兜底失败。
    entry.resuming = true;
    const launch = () => {
      entry.resuming = false;
      let handle: RunHandle;
      try {
        handle = entry.runtime.resume(entry.runId, { kind: "tool_approval", approved }, entry.abort.signal);
      } catch (err: unknown) {
        // resume 拒绝（run 不在 awaiting_human / 日志异常）：任务落 FAILED，绝不悬死
        console.error(`[vibe-orchestrator] resume rejected for task ${entry.taskId}:`, err);
        this.finish(entry, { status: "failed", result_text: "", error_code: "runtime_error" });
        return;
      }
      entry.handle = handle;
      this.consume(entry, handle);
    };
    const prev = entry.handle;
    if (prev) {
      void prev.done.then(launch, launch);
    } else {
      launch();
    }
    return true;
  }

  insertUserMessage(taskId: string, content: string): void {
    this.insertMessage(taskId, "user", content);
  }

  private insertMessage(taskId: string, role: string, content: string): void {
    const row = this.deps.db.prepare("SELECT MAX(seq) AS m FROM task_messages WHERE task_id = ?").get(taskId) as {
      m: number | null;
    };
    const seq = (row?.m ?? 0) + 1;
    this.deps.db
      .prepare("INSERT INTO task_messages (id, task_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, role, content, seq, new Date().toISOString());
  }

  private consume(entry: RunEntry, handle: RunHandle): void {
    const translator = createTranslator(entry.taskId);
    void (async () => {
      try {
        for await (const ev of handle.events) {
          if (ev.type === "human_input_requested") {
            entry.gateSeq += 1;
            entry.pendingGateRequestId = `gate-${entry.gateSeq}`;
            entry.awaiting = true;
            // 闸门锁存：从这一刻起旧 consume 的收尾永远无权终局（answer 与 settle
            // 的到达顺序不定，resuming 会在 launch 里被清掉，不能作为终局豁免依据）。
            entry.gateHeld = true;
          }
          for (const frame of translator.translate(ev)) {
            if (frame.event === "message") {
              const role = frame.data.role as string;
              const content = frame.data.content as string;
              if (role !== "delta") this.insertMessage(entry.taskId, role, content);
              this.deps.bus.emit("task_message", { task_id: entry.taskId, role, content });
            } else if (frame.event === "questions") {
              this.deps.bus.emit("task_questions", {
                task_id: entry.taskId,
                request_id: frame.data.request_id,
                questions: frame.data.questions,
              });
            } else if (frame.event === "todos") {
              this.deps.bus.emit("task_todos", { task_id: entry.taskId, todos: frame.data.todos });
            }
          }
        }
      } catch (err: unknown) {
        console.error(`[vibe-orchestrator] run ${entry.runId} stream crashed:`, err);
        entry.pipelineError = true; // 未处理异常 → 终局遥测记 pipeline（原 UNHANDLED_EXCEPTION 路径）
      }
      try {
        await handle.done;
      } catch (err: unknown) {
        console.error(`[vibe-orchestrator] run ${entry.runId} done rejected:`, err);
      }
      this.settle(entry, translator);
    })();
  }

  private settle(entry: RunEntry, translator: ReturnType<typeof createTranslator>): void {
    if (entry.finished) return; // 已终局（如 stop 直接收尾）：迟到的旧 consume 无权再写
    const done = translator.done;
    if (!done) {
      // 闸门锁存过的 run：旧 consume 的收尾永远无权终局，只有后续 consume 的
      // 终局帧（translator.done）能收尾。gateHeld 在 human_input_requested 事件
      // 时刻锁存——answer 与 settle 的到达顺序不定，事后标志都会漏窗口。
      if (entry.gateHeld) {
        // stop 抢在锁存前只来得及 abort（对已返回的 episode 无效）：在这里补终局
        if (entry.stopRequested && !entry.resuming) this.finish(entry, { status: "cancelled", result_text: "" });
        return;
      }
      if (entry.awaiting && entry.abort.signal.aborted) {
        // stop 与门挂起乱序的竞态：等价 CLI 停掉停在提问的进程
        this.finish(entry, { status: "cancelled", result_text: "" });
        return;
      }
    }
    this.finish(entry, done ?? { status: "failed", result_text: "", error_code: "runtime_error" });
  }

  private finish(
    entry: RunEntry,
    done: { status: string; result_text: string; error_code?: string },
  ): void {
    const { db, bus, config } = this.deps;
    entry.finished = true;
    entry.awaiting = false;
    const now = new Date().toISOString();

    // 先落 run 的原始产出（transcript_tail / infra 错误对），再由 outcome 唯一裁决
    if (done.status === "completed" || done.status === "partial") {
      db.prepare("UPDATE tasks SET transcript_tail = ?, updated_at = ? WHERE id = ?").run(done.result_text, now, entry.taskId);
    } else if (done.status === "failed") {
      // 常驻诊断：基础设施性失败必须留下一眼可查的痕迹（对齐桥的 crash 日志）
      console.error(`[vibe-orchestrator] task ${entry.taskId} finished failed: ${JSON.stringify(done)}`);
      db.prepare("UPDATE tasks SET error = ?, error_category = ?, updated_at = ? WHERE id = ?").run(
        `agent run failed: ${done.error_code ?? "runtime_error"}`,
        "runtime_error",
        now,
        entry.taskId,
      );
    } else if (done.status === "cancelled") {
      db.prepare("UPDATE tasks SET error = ?, error_category = ?, updated_at = ? WHERE id = ?").run(
        "Task stopped by user",
        "stopped_by_user",
        now,
        entry.taskId,
      );
    }

    // design 运行：plan 文本落库分支（等价 CLI ExitPlanMode hook 的 _save_design_plan +
    // plan-only 的 _commit_plan_only_approval；plan 只进 task.plan/Schedule.plan，
    // 绝不写 task.result —— transcript_tail 红线）。invalid：fanout 违禁结构 → plan_invalid 失败。
    const designBranch =
      entry.mode === "design" && (done.status === "completed" || done.status === "partial")
        ? this.commitDesignPlan(entry, done.result_text, now)
        : "skip";

    const row = db
      .prepare(
        "SELECT status, result, accepted_result, submitted_result, transcript_tail, review_gaps, error, error_category FROM tasks WHERE id = ?",
      )
      .get(entry.taskId) as Record<string, unknown>;
    const outcome = resolveOutcome(row as never);
    applyOutcome(row as never, outcome);
    let target = outcome.kind === "failed" ? "failed" : "completed";
    if (designBranch === "plan_only" || designBranch === "invalid") target = "completed";
    else if (designBranch === "committed") target = "planned"; // 设计完成等人工执行
    const moved = canTransition(String(row.status), target);
    db.prepare("UPDATE tasks SET result = ?, review_gaps = ?, error = ?, error_category = ? WHERE id = ?").run(
      (row as { result: string | null }).result,
      (row as { review_gaps: string | null }).review_gaps,
      (row as { error: string | null }).error,
      (row as { error_category: string | null }).error_category,
      entry.taskId,
    );
    if (moved) {
      db.prepare("UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(
        target,
        target === "completed" ? now : null,
        now,
        entry.taskId,
      );
    }

    // 终局遥测（原 task_runner_exec 各终局点的 TS 汇聚处；PRD §3.3"orchestrator
    // 终局裁决"）。phase 映射：run 未起飞 → pre_running（start() 工厂失败处已发）；
    // 事件流崩溃 → pipeline；其余 → running。completed 走统计（失败静默降级仍发送）。
    if (moved && (target === "completed" || target === "failed")) {
      const fresh = db
        .prepare("SELECT id, store_id, schedule_id, plan_mode, ai_profile_id, started_at, completed_at, error_category FROM tasks WHERE id = ?")
        .get(entry.taskId) as Parameters<typeof sendTaskCompleted>[2] | undefined;
      if (fresh) {
        if (target === "completed") sendTaskCompleted(db, config.homeDir, fresh);
        else {
          sendTaskFailed(
            db,
            config.homeDir,
            fresh,
            entry.pipelineError ? TaskFailurePhase.PIPELINE : TaskFailurePhase.RUNNING,
            entry.pipelineError ? TaskFailureCategory.UNHANDLED_EXCEPTION : TaskFailureCategory.NO_RESULT,
          );
        }
      }
    }

    bus.emit("agent_done", {
      task_id: entry.taskId,
      return_code: done.status === "cancelled" ? -1 : done.status === "failed" ? 1 : 0,
      mode: entry.mode === "design" ? "plan_then_execute" : "execute",
      ...(done.status === "cancelled" ? { interrupted: true } : {}),
    });
    bus.emit("task_update", {
      task_id: entry.taskId,
      status: moved ? target : (row.status as string),
      ...(designBranch === "committed" ? { plan: done.result_text } : {}),
      ...(target === "failed" && (row.error as string | null) ? { error: row.error } : {}),
    });
    if (designBranch === "plan_only") {
      // plan-only 提交即就绪：前端 SchedulePlanPanel 靠这个事件刷新（对齐 claude_backend_hooks）
      const trow = db.prepare("SELECT schedule_id FROM tasks WHERE id = ?").get(entry.taskId) as { schedule_id: string | null };
      if (trow.schedule_id) {
        const sched = db.prepare("SELECT plan_version FROM schedules WHERE id = ?").get(trow.schedule_id) as
          | { plan_version: number }
          | undefined;
        if (sched) bus.emit("schedule_plan_ready", { schedule_id: trow.schedule_id, plan_version: sched.plan_version });
      }
    }

    this.running.delete(entry.taskId);
    this.active = Math.max(0, this.active - 1);
    void entry.dispose?.().catch(() => {});
    this.drain();
  }

  /**
   * design 运行的 plan 落库：plan_history 追加 + task.plan；plan-only 任务同时提交
   * Schedule（plan/ready/version+1/清指针），普通任务留给 execute-plan。
   * 返回：'committed'（普通）| 'plan_only' | 'invalid' | 'skip'（不适用）。
   */
  private commitDesignPlan(entry: RunEntry, planText: string, now: string): "committed" | "plan_only" | "invalid" | "skip" {
    const { db, bus } = this.deps;
    const task = db
      .prepare("SELECT plan_mode, is_plan_only, schedule_id, plan_history FROM tasks WHERE id = ?")
      .get(entry.taskId) as
      | { plan_mode: number | null; is_plan_only: number | null; schedule_id: string | null; plan_history: string | null }
      | undefined;
    if (!task || !Number(task.plan_mode) || !planText.trim()) return "skip";

    // fanout 计划违禁结构校验（claude_backend_utils._FANOUT_FORBIDDEN_PATTERNS 的移植）：
    // fanout 计划里不许出现子任务编排——调度器本身每店各跑一遍计划。
    if (task.is_plan_only && task.schedule_id) {
      const sched = db.prepare("SELECT phase_mode FROM schedules WHERE id = ?").get(task.schedule_id) as
        | { phase_mode: string | null }
        | undefined;
      if (sched?.phase_mode === "fanout") {
        const haystack = planText.toLowerCase();
        for (const [needle, description] of [
          ["vibe_seller_create_task", "calls the sub-task MCP tool"],
          ["parent_task_id", "designs a parent/sub-task hierarchy"],
        ] as const) {
          if (haystack.includes(needle)) {
            const reason = `the plan ${description} (found ${JSON.stringify(needle)}), but this schedule is a fanout schedule — the scheduler already creates one per-store Task per fire and runs the plan once per store. Remove the orchestrator step and describe what a single store-bound agent should do with the per-store L3 catalog.`;
            db.prepare("UPDATE tasks SET error = ?, error_category = 'plan_invalid', updated_at = ? WHERE id = ?").run(reason, now, entry.taskId);
            return "invalid";
          }
        }
      }
    }

    let history: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(task.plan_history ?? "[]");
      if (Array.isArray(parsed)) history = parsed;
    } catch {
      /* 历史损坏按空处理 */
    }
    history.push({ version: history.length + 1, content: planText, created_at: now });
    db.prepare("UPDATE tasks SET plan = ?, plan_history = ?, updated_at = ? WHERE id = ?").run(
      planText,
      JSON.stringify(history),
      now,
      entry.taskId,
    );

    if (task.is_plan_only && task.schedule_id) {
      const sched = db.prepare("SELECT plan_version FROM schedules WHERE id = ?").get(task.schedule_id) as
        | { plan_version: number | null }
        | undefined;
      if (sched) {
        db.prepare(
          `UPDATE schedules SET plan = ?, plan_status = 'ready', plan_version = ?, plan_error = NULL,
           current_planning_task_id = NULL, updated_at = ? WHERE id = ?`,
        ).run(planText, (sched.plan_version ?? 0) + 1, now, task.schedule_id);
      }
      return "plan_only";
    }
    return "committed";
  }

  /** 队列排水：每个店铺队头各排一个（全局空位允许时）。 */
  private drain(): void {
    const max = this.deps.maxConcurrent ?? 2;
    for (const [storeId, q] of [...this.queues.entries()]) {
      if (q.length === 0 || this.active >= max || this.storeBusy(storeId)) continue;
      const next = q.shift()!;
      const opts = this.queuedOpts.get(next) ?? { mode: "execute" as RunMode };
      this.queuedOpts.delete(next);
      const row = this.deps.db.prepare("SELECT status FROM tasks WHERE id = ?").get(next) as
        | { status: string }
        | undefined;
      if (!row) continue;
      if (this.transition(next, "running")) {
        void this.start(next, opts);
      }
      if (q.length === 0) this.queues.delete(storeId);
    }
  }
}
