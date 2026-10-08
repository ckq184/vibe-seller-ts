import { RunError, abortError, isAbortError, normalizeError } from "./errors";
import { applyDecision, applyObservation, type Observation } from "./state";
import { isToolApproval, type AgentCore, type AgentState, type Decision, type GatePolicy, type ModelPort, type RawAgentEvent, type RunBudget, type RunErrorCode, type ToolCallResult, type ToolIntent, type ToolPort } from "./types";

export interface LoopUsage {
  toolCalls: number;
  durationMs: number;
  /** 真实模型通道填充；fake 通道缺省（JSON 序列化时自动消失）。 */
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export type LoopOutcome =
  | { status: "completed"; state: AgentState; result: unknown; partial?: { missingMaterial: string[] }; usage: LoopUsage }
  | { status: "awaiting_human"; state: AgentState; question: string; pendingIntent?: ToolIntent; usage: LoopUsage }
  | { status: "failed"; state: AgentState; error: { code: RunErrorCode; message: string }; usage: LoopUsage }
  | { status: "cancelled"; state: AgentState; usage: LoopUsage };

export interface LoopDeps {
  /** 决策来源：真路径 = modelDrivenCore(modelPort)；测试 = 脚本/挂起模型。 */
  core: AgentCore;
  tools: ToolPort;
  budget: RunBudget;
  /** 已由 Runtime 组合（caller ∥ timeout）的信号；循环只认它。 */
  signal: AbortSignal;
  emit: (event: RawAgentEvent) => void;
  now: () => number;
  nextToolCallId: () => string;
  /** 确认闸门策略；缺省无门。 */
  gates?: GatePolicy;
  /** 重试退避延迟；测试注入 () => 0 保持确定性。缺省指数退避封顶 8s。 */
  retryDelayMs?: (attempt: number) => number;
}

/** 同一（工具+参数）连续失败达到该值即判空转：宁可诚实失败，也不烧预算。 */
const SPIN_LIMIT = 3;

/** messages 里的结构形状（回放/闸门扫描用）。 */
interface MessageShape {
  role: string;
  decision?: Decision;
  input?: unknown;
}

interface PendingGate {
  verdict: "approved" | "denied";
  intent: ToolIntent;
}

/**
 * 解析"最近一次被门拦下、尚无结果"的意图及其批复状态。
 * 两段式：gated 决策之后只要出现过 observation 即视为已处理（批复已消费）；
 * 否则取其后第一条 tool_approval 批复。没有批复 = 未决（默认拒绝）。
 * 闸门语义的唯一裁判：Core 引擎与 Pi 引擎共用，保证跨引擎判定一致。
 */
export function resolvePendingGate(state: AgentState, policy: GatePolicy): PendingGate | undefined {
  let gatedIndex = -1;
  let gatedIntent: ToolIntent | undefined;
  for (let i = 0; i < state.messages.length; i++) {
    const m = state.messages[i] as MessageShape;
    if (m?.role === "decision" && m.decision?.kind === "call_tool" && policy.requiresApproval(m.decision.intent)) {
      gatedIndex = i;
      gatedIntent = m.decision.intent;
    }
  }
  if (gatedIndex < 0 || !gatedIntent) return undefined;
  // 第一段：gated 决策之后出现过任何 observation = 批复已消费（工具已执行或已落拒绝观察）
  for (let i = gatedIndex + 1; i < state.messages.length; i++) {
    if ((state.messages[i] as MessageShape)?.role === "observation") return undefined;
  }
  // 第二段：未决——取其后第一条 tool_approval 批复；没有批复 = 默认拒绝不执行
  for (let i = gatedIndex + 1; i < state.messages.length; i++) {
    const m = state.messages[i] as MessageShape;
    if (m?.role === "human" && isToolApproval(m.input)) {
      return { verdict: m.input.approved ? "approved" : "denied", intent: gatedIntent };
    }
  }
  return undefined;
}

/**
 * 确定性驱动循环：Task → 决策 → 工具 → 观察 → 状态推进 → 终局。
 * 只实现循环语义（预算/取消/重试/无进展守卫/确认闸门），不持有任何资源；
 * 终态事件（usage_reported/run_completed/run_failed/run_cancelled）由 Runtime 统一盖章。
 */
export async function driveLoop(start: AgentState, deps: LoopDeps): Promise<LoopOutcome> {
  const startedAt = deps.now();
  let state = start;
  let toolCalls = 0;
  let retriesLeft = deps.budget.maxRetries;
  let lastFailedIntent: string | undefined;
  let consecutiveFailures = 0;

  const usage = (): LoopUsage => ({ toolCalls, durationMs: deps.now() - startedAt });
  const cancelled = (): LoopOutcome => ({ status: "cancelled", state, usage: usage() });
  const fail = (code: RunErrorCode, message: string): LoopOutcome => ({
    status: "failed",
    state,
    error: { code, message },
    usage: usage(),
  });

  /** 执行一个工具意图并落观察。决策已在 state 里时（闸门放行路径）不再重复记 decision。 */
  const executeTool = async (intent: ToolIntent): Promise<void> => {
    const toolCallId = deps.nextToolCallId();
    const toolStartedAt = deps.now();
    deps.emit({ type: "tool_started", toolCallId, toolName: intent.name, timestamp: toolStartedAt });
    let result: ToolCallResult;
    try {
      result = await deps.tools.execute(intent, deps.signal);
    } catch (err) {
      if (deps.signal.aborted || isAbortError(err)) throw err;
      result = { status: "error", error: { code: "runtime_error", message: err instanceof Error ? err.message : String(err) } };
    }
    toolCalls += 1;
    const completedAt = deps.now();
    deps.emit({
      type: "tool_completed",
      toolCallId,
      toolName: intent.name,
      status: result.status,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs: completedAt - toolStartedAt,
      timestamp: completedAt,
    });
    // 工具结果是不可信输入：失败也必须成为观察，且不得静默覆盖策略字段。
    const observation: Observation = {
      name: intent.name,
      data: result.status === "success" ? result.result : { error: result.error },
    };
    state = applyObservation(state, observation);
    deps.emit({ type: "observation_added", name: observation.name, observation: observation.data, timestamp: deps.now() });

    // 无进展守卫：同一意图连续失败是空转（spin），立即止损。
    const intentKey = JSON.stringify(intent);
    if (result.status === "error") {
      consecutiveFailures = intentKey === lastFailedIntent ? consecutiveFailures + 1 : 1;
      lastFailedIntent = intentKey;
      if (consecutiveFailures >= SPIN_LIMIT) {
        throw new RunError("no_progress", `tool ${intent.name} failed ${SPIN_LIMIT} consecutive times with identical arguments`);
      }
    } else {
      lastFailedIntent = undefined;
      consecutiveFailures = 0;
    }
  };

  try {
    for (;;) {
      if (deps.signal.aborted) return cancelled();
      // 预算归 Runtime 检查语义、循环归 Core 语义的边界在这里：循环只读预算，不管理预算。
      if (state.iteration >= deps.budget.maxIterations) {
        return fail("budget_iterations", `iteration budget exhausted (${deps.budget.maxIterations})`);
      }
      if (toolCalls >= deps.budget.maxToolCalls) {
        return fail("budget_tools", `tool budget exhausted (${deps.budget.maxToolCalls})`);
      }

      // 闸门恢复：上次挂起的意图已批复 → 批准则直接执行（不依赖模型重新决策），拒绝则落拒绝观察。
      const pending = deps.gates ? resolvePendingGate(state, deps.gates) : undefined;
      if (pending?.verdict === "approved") {
        await executeTool(pending.intent);
        continue;
      }
      if (pending?.verdict === "denied") {
        const denial: Observation = {
          name: pending.intent.name,
          data: { error: { code: "approval_denied", message: "human declined this tool call" } },
        };
        state = applyObservation(state, denial);
        deps.emit({ type: "observation_added", name: denial.name, observation: denial.data, timestamp: deps.now() });
        continue;
      }

      deps.emit({ type: "model_requested", timestamp: deps.now() });

      let decision: Decision;
      try {
        decision = await deps.core.step(state, deps.signal);
      } catch (err) {
        if (deps.signal.aborted || isAbortError(err)) return cancelled();
        const runErr = normalizeError(err);
        if (runErr.retryable && retriesLeft > 0) {
          retriesLeft -= 1;
          const attempt = deps.budget.maxRetries - retriesLeft;
          const delay = deps.retryDelayMs ? deps.retryDelayMs(attempt) : Math.min(1000 * 2 ** (attempt - 1), 8000);
          await sleep(delay, deps.signal);
          continue;
        }
        return fail(runErr.code, runErr.message);
      }
      deps.emit({ type: "decision_made", decision, timestamp: deps.now() });

      switch (decision.kind) {
        case "respond": {
          state = applyDecision(state, decision);
          return {
            status: "completed",
            state,
            result: decision.content,
            ...(decision.partial ? { partial: decision.partial } : {}),
            usage: usage(),
          };
        }
        case "ask_human": {
          state = applyDecision(state, decision);
          deps.emit({ type: "human_input_requested", question: decision.question, timestamp: deps.now() });
          return { status: "awaiting_human", state, question: decision.question, usage: usage() };
        }
        case "call_tool": {
          // 确认闸门：命中即挂起等批复，绝不先执行（默认拒绝）。
          if (deps.gates?.requiresApproval(decision.intent)) {
            state = applyDecision(state, decision);
            const question = deps.gates.question(decision.intent);
            deps.emit({ type: "human_input_requested", question, timestamp: deps.now() });
            return { status: "awaiting_human", state, question, pendingIntent: decision.intent, usage: usage() };
          }
          state = applyDecision(state, decision);
          await executeTool(decision.intent);
          break;
        }
      }
    }
  } catch (err) {
    // executeTool 向外抛出的只有取消与空转（no_progress）
    if (deps.signal.aborted || isAbortError(err)) return cancelled();
    if (err instanceof RunError) return fail(err.code, err.message);
    throw err;
  }
}

/** 真路径的决策来源：Core.step 就是问模型。SDK 适配器实现 ModelPort。 */
export function modelDrivenCore(model: ModelPort): AgentCore {
  return { step: (state, signal) => model.decide(state, signal) };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// re-export 便于适配器/测试统一从 loop 取用
export { abortError, RunError };
