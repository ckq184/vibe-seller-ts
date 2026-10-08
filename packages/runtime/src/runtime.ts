import { randomUUID } from "node:crypto";
import {
  applyHumanInput,
  deriveRun,
  driveLoop,
  initialState,
  replayState,
  type AgentCore,
  type AgentState,
  AgentEvent,
  type GatePolicy,
  type LoopOutcome,
  RawAgentEvent,
  Run,
  RunBudget,
  Session,
  Task,
  ToolPort,
} from "@vibe/core";
import { EventChannel } from "./channel";
import type { RunLog } from "./runlog";
import type { SessionStore } from "./session";

/** 引擎入参：一次 Run 的迭代发生时所需的全部执行面。 */
export interface EngineDeps {
  state: AgentState;
  budget: RunBudget;
  /** 确认闸门策略：命中即挂起等人工批复（Core 引擎实现；Pi 引擎的等价物在 Phase 2 后续）。 */
  gates?: GatePolicy;
  signal: AbortSignal;
  emit: (event: RawAgentEvent) => void;
  now: () => number;
  nextToolCallId: () => string;
  retryDelayMs?: (attempt: number) => number;
}

/**
 * 引擎 = "一次 Run 的迭代如何发生"。
 * 缺省 Core 引擎（driveLoop）逐步决策；Pi 引擎（@vibe/adapters-pi）把整段 SDK
 * episode 归一化为同一套事件词表。两者必须通过同一金标 transcript 验证语义一致。
 */
export type RunEngine = (deps: EngineDeps) => Promise<LoopOutcome>;

/** DoD 评审上下文：completed 结束时、终态事件发出之前，评审者看到的是已落盘的事件日志。 */
export interface RunReviewContext {
  runId: string;
  task: Task;
  events: readonly AgentEvent[];
  state: AgentState;
}

export interface RunReviewResult {
  verdict: "pass" | "incomplete";
  /** 判 incomplete 时必须点名缺失材料（审计义务来自枚举清单，不来自报告形状）。 */
  missingMaterial?: string[];
  reason?: string;
}

/** 任务后钩子（如反思写知识库）：completed/failed/cancelled 后调用；awaiting_human 不算终局。 */
export interface RunAfterContext {
  runId: string;
  task: Task;
  run: Run;
  events: readonly AgentEvent[];
  state: AgentState;
}

export interface RuntimeDeps {
  core: AgentCore;
  tools: ToolPort;
  runLog: RunLog;
  sessions: SessionStore;
  budget: RunBudget;
  /** 缺省使用 Core 引擎（driveLoop）。 */
  engine?: RunEngine;
  /** 确认闸门策略：命中的工具意图必须先获得人工批准（经 awaiting_human → resume 流程）。 */
  gates?: GatePolicy;
  /** DoD 评审：completed 时调用；incomplete → run_completed(partial) + missingMaterial。 */
  review?: (ctx: RunReviewContext) => RunReviewResult | Promise<RunReviewResult>;
  /** 任务后钩子：终局（非 awaiting_human）且事件落盘后调用。 */
  afterRun?: (ctx: RunAfterContext) => Promise<void> | void;
  now?: () => number;
  nextToolCallId?: () => string;
  newRunId?: () => string;
  /** 重试退避延迟；测试注入 () => 0 保持确定性。 */
  retryDelayMs?: (attempt: number) => number;
}

export interface RunHandle {
  /** 产品级事件流（单消费者）；审计/回放从 RunLog 读。 */
  events: AsyncIterable<AgentEvent>;
  /** 终局 Run；从事件日志推导，事件日志是唯一事实源。 */
  done: Promise<Run>;
}

type ExecuteRequest =
  | { mode: "new"; task: Task; callerSignal?: AbortSignal }
  | { mode: "resume"; runId: string; input: unknown; callerSignal?: AbortSignal };

/**
 * 执行托管：把 Core 的循环语义落成有身份、有持久化、可取消、可恢复的 Run。
 * 事件先落 RunLog 再推给消费者 —— 日志永远领先或等于消费方所见。
 */
export class AgentRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  run(task: Task, callerSignal?: AbortSignal): RunHandle {
    const channel = new EventChannel<AgentEvent>();
    return this.launch(channel, this.execute({ mode: "new", task, callerSignal }, channel));
  }

  /** 从 RunLog 回放续跑 awaiting_human 的 run；sequence 全局接续。 */
  resume(runId: string, input: unknown, callerSignal?: AbortSignal): RunHandle {
    const channel = new EventChannel<AgentEvent>();
    return this.launch(channel, this.execute({ mode: "resume", runId, input, callerSignal }, channel));
  }

  private launch(channel: EventChannel<AgentEvent>, execution: Promise<Run>): RunHandle {
    const done = execution.then(
      (run) => {
        channel.close();
        return run;
      },
      (err: unknown) => {
        channel.close(err);
        throw err;
      },
    );
    return { events: channel, done };
  }

  private async execute(opts: ExecuteRequest, channel: EventChannel<AgentEvent>): Promise<Run> {
    const now = this.deps.now ?? Date.now;
    const nextToolCallId = this.deps.nextToolCallId ?? counter("tc");
    const newRunId = this.deps.newRunId ?? (() => randomUUID());

    const timeoutSignal = AbortSignal.timeout(this.deps.budget.timeoutMs);
    const signal = opts.callerSignal ? AbortSignal.any([opts.callerSignal, timeoutSignal]) : timeoutSignal;

    // 事件先落盘再入通道：保证消费方看到的序 = 日志的序
    let chain: Promise<void> = Promise.resolve();
    const emit = (raw: RawAgentEvent) => {
      chain = chain.then(() => this.appendAndPush(channel, runId, sequence++, raw));
    };

    let runId: string;
    let sequence: number;
    let state: AgentState;
    let session: Session;
    let task: Task;

    if (opts.mode === "new") {
      runId = newRunId();
      task = opts.task;
      session = await this.deps.sessions.createSession();
      sequence = 0;
      const startedRaw: RawAgentEvent = { type: "run_started", sessionId: session.id, task, timestamp: now() };
      emit(startedRaw);
      session.runs.push({
        runId,
        sessionId: session.id,
        task,
        status: "running",
        startedAt: startedRaw.timestamp,
        updatedAt: startedRaw.timestamp,
      });
      await this.deps.sessions.saveSession(session);
      state = initialState(task);
    } else {
      const prevEvents = await this.deps.runLog.listEvents(opts.runId);
      const prevRun = deriveRun(prevEvents);
      if (!prevRun) throw new Error(`unknown run: ${opts.runId}`);
      if (prevRun.status !== "awaiting_human") {
        throw new Error(`run ${opts.runId} is ${prevRun.status}; only awaiting_human runs can resume`);
      }
      runId = prevRun.runId;
      task = prevRun.task;
      const loaded = await this.deps.sessions.loadSession(prevRun.sessionId);
      if (!loaded) throw new Error(`unknown session: ${prevRun.sessionId}`);
      session = loaded;
      sequence = (prevEvents[prevEvents.length - 1]?.sequence ?? -1) + 1;
      const replayed = replayState(prevEvents);
      if (!replayed) throw new Error(`run ${opts.runId} has no replayable state`);
      const entry = session.runs.find((r) => r.runId === runId);
      if (entry) {
        entry.status = "running";
        entry.updatedAt = now();
      }
      await this.deps.sessions.saveSession(session);
      emit({ type: "human_input_received", input: opts.input, timestamp: now() });
      emit({ type: "run_resumed", timestamp: now() });
      state = applyHumanInput(replayed, opts.input);
    }

    const engine = this.deps.engine ?? this.coreEngine;
    const outcome = await engine({
      state,
      budget: this.deps.budget,
      gates: this.deps.gates,
      signal,
      emit,
      now,
      nextToolCallId,
      retryDelayMs: this.deps.retryDelayMs,
    });

    await chain; // 引擎事件全部落盘后，评审者与终态化才面对唯一事实源

    // DoD 评审：只评 completed；审计义务来自枚举清单，incomplete 必须点名缺失材料。
    let reviewResult: RunReviewResult | undefined;
    if (outcome.status === "completed" && this.deps.review) {
      const eventsForReview = await this.deps.runLog.listEvents(runId);
      reviewResult = await this.deps.review({
        runId,
        task,
        events: eventsForReview,
        state: replayState(eventsForReview) ?? outcome.state,
      });
    }

    // 终态化：usage 在前，终态事件在后（对齐 Runtime loop 契约的终止顺序）
    emit({
      type: "usage_reported",
      usage: { ...outcome.usage },
      timestamp: now(),
    });
    let finalStatus: Run["status"];
    switch (outcome.status) {
      case "completed": {
        const missingMaterial = [
          ...new Set([
            ...(outcome.partial?.missingMaterial ?? []),
            ...(reviewResult?.verdict === "incomplete" ? reviewResult.missingMaterial ?? [] : []),
          ]),
        ];
        const incomplete = Boolean(outcome.partial) || reviewResult?.verdict === "incomplete";
        emit({
          type: "run_completed",
          status: incomplete ? "partial" : "complete",
          result: outcome.result,
          ...(missingMaterial.length > 0 ? { missingMaterial } : {}),
          timestamp: now(),
        });
        finalStatus = "completed";
        break;
      }
      case "awaiting_human":
        finalStatus = "awaiting_human";
        break;
      case "cancelled":
        if (opts.callerSignal?.aborted) {
          emit({ type: "run_cancelled", timestamp: now() });
          finalStatus = "cancelled";
        } else if (timeoutSignal.aborted) {
          emit({
            type: "run_failed",
            error: { code: "budget_timeout", message: `budget timeout exceeded (${this.deps.budget.timeoutMs}ms)` },
            timestamp: now(),
          });
          finalStatus = "failed";
        } else {
          emit({ type: "run_cancelled", timestamp: now() });
          finalStatus = "cancelled";
        }
        break;
      case "failed":
        emit({ type: "run_failed", error: outcome.error, timestamp: now() });
        finalStatus = "failed";
        break;
    }

    await chain; // 全部落盘后才更新 Session 快照
    const finalRun = deriveRun(await this.deps.runLog.listEvents(runId));
    if (!finalRun) throw new Error(`run ${runId} produced no log`);
    const runEntry = session.runs.find((r) => r.runId === runId);
    if (runEntry) {
      runEntry.status = finalStatus;
      runEntry.updatedAt = finalRun.updatedAt;
      await this.deps.sessions.saveSession(session);
    }
    // 任务后钩子（反思等）：只在真终局触发；awaiting_human 会在 resume 后再次走到这里
    if (this.deps.afterRun && finalStatus !== "awaiting_human") {
      const finalEvents = await this.deps.runLog.listEvents(runId);
      await this.deps.afterRun({
        runId,
        task,
        run: finalRun,
        events: finalEvents,
        state: replayState(finalEvents) ?? outcome.state,
      });
    }
    return finalRun;
  }

  /** 缺省引擎：Core 引擎（driveLoop），逐步决策、预算/重试/空转守卫/闸门都在 Core。 */
  private get coreEngine(): RunEngine {
    return (deps) =>
      driveLoop(deps.state, {
        core: this.deps.core,
        tools: this.deps.tools,
        budget: deps.budget,
        gates: deps.gates,
        signal: deps.signal,
        emit: deps.emit,
        now: deps.now,
        nextToolCallId: deps.nextToolCallId,
        retryDelayMs: deps.retryDelayMs,
      });
  }

  private async appendAndPush(channel: EventChannel<AgentEvent>, runId: string, sequence: number, raw: RawAgentEvent): Promise<void> {
    const event = { ...raw, runId, sequence } as AgentEvent;
    await this.deps.runLog.appendEvent(event);
    channel.push(event);
  }
}

function counter(prefix: string): () => string {
  let i = 0;
  return () => `${prefix}-${++i}`;
}
