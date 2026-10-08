// 纯领域契约 —— Core 里不允许出现任何 SDK import、任何副作用。
//
// 对 pi-coding-agent 技能基线契约的两处显式扩展（都有第一性理由）：
//   1. run_started 携带 task/sessionId —— RunLog 回放必须能自足重建 AgentState，
//      否则崩溃恢复时状态无法从唯一事实源（事件日志）重建；
//   2. respond 决策可选携带 partial —— run_completed 必须区分 complete/partial，
//      部分结果必须点名缺失材料，绝不冒充成功。

export interface Task {
  id: string;
  input: unknown;
}

export interface ToolIntent {
  name: string;
  arguments: Record<string, unknown>;
}

/** 人工对受门工具意图的批复：作为 resume 输入注入，成为一条 human 消息。 */
export interface ToolApprovalInput {
  kind: "tool_approval";
  approved: boolean;
}

export function isToolApproval(input: unknown): input is ToolApprovalInput {
  return typeof input === "object" && input !== null && (input as { kind?: string }).kind === "tool_approval";
}

/**
 * 确认闸门策略：命中的工具意图必须先获得人工批准才能执行。
 * 确认是产品语义，归属 Core（对齐 confirm-gate 场景）；默认拒绝——没有批复就不执行。
 */
export interface GatePolicy {
  requiresApproval(intent: ToolIntent): boolean;
  question(intent: ToolIntent): string;
}

/** 模型的一步决策：产出结果、调用工具、或把问题交还给人。 */
export type Decision =
  | { kind: "respond"; content: unknown; partial?: { missingMaterial: string[] } }
  | { kind: "call_tool"; intent: ToolIntent }
  | { kind: "ask_human"; question: string };

export interface ToolCallResult {
  status: "success" | "error";
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface AgentState {
  task: Task;
  messages: unknown[];
  observations: unknown[];
  iteration: number;
}

/** 模型端口：SDK 适配器落点（真路径），假适配器同样实现它。 */
export interface ModelPort {
  decide(state: AgentState, signal: AbortSignal): Promise<Decision>;
}

/** 工具端口：所有执行面（浏览器、MCP、脚本）统一从这个口进出。 */
export interface ToolPort {
  execute(intent: ToolIntent, signal: AbortSignal): Promise<ToolCallResult>;
}

/** 决策来源。真路径 = modelDrivenCore(ModelPort)；假路径 = 脚本驱动。 */
export interface AgentCore {
  step(state: AgentState, signal: AbortSignal): Promise<Decision>;
}

export type RunErrorCode =
  | "budget_iterations"
  | "budget_tools"
  | "budget_timeout"
  | "no_progress"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "invalid_tool"
  | "provider_unavailable"
  | "runtime_error";

export interface RunBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxRetries: number;
  timeoutMs: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  runId: string;
  sessionId: string;
  task: Task;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  createdAt: number;
  runs: Run[];
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls: number;
  durationMs: number;
  model?: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 循环内部产生的事件：无 runId/sequence，由 Runtime 盖章后落盘。 */
export type RawAgentEvent = DistributiveOmit<AgentEvent, "runId" | "sequence">;

/**
 * 产品级事件：唯一对外契约。UI、CLI、trace、测试都消费它；
 * 原始 SDK/模型回调永远不许穿透到这一层之外。
 */
export type AgentEvent =
  | { type: "run_started"; runId: string; sequence: number; timestamp: number; sessionId: string; task: Task }
  | { type: "model_requested"; runId: string; sequence: number; timestamp: number }
  | { type: "decision_made"; runId: string; sequence: number; decision: Decision; timestamp: number }
  | { type: "tool_started"; runId: string; sequence: number; toolCallId: string; toolName: string; timestamp: number }
  | { type: "tool_completed"; runId: string; sequence: number; toolCallId: string; toolName: string; status: "success" | "error"; result?: unknown; error?: { code: string; message: string }; durationMs: number; timestamp: number }
  | { type: "observation_added"; runId: string; sequence: number; name: string; observation: unknown; timestamp: number }
  | { type: "human_input_requested"; runId: string; sequence: number; question: string; timestamp: number }
  | { type: "human_input_received"; runId: string; sequence: number; input: unknown; timestamp: number }
  | { type: "usage_reported"; runId: string; sequence: number; usage: RunUsage; timestamp: number }
  | { type: "run_completed"; runId: string; sequence: number; status: "complete" | "partial"; result: unknown; missingMaterial?: string[]; timestamp: number }
  | { type: "run_failed"; runId: string; sequence: number; error: { code: RunErrorCode; message: string }; timestamp: number }
  | { type: "run_cancelled"; runId: string; sequence: number; timestamp: number }
  | { type: "run_resumed"; runId: string; sequence: number; timestamp: number };
