// 活 run 注册表：task_id → 桥内 run 状态。对齐 ClaudeCodeBackend._sessions 的
// 职责面：is_running / 重复启动拒绝 / pending question 跟踪 / 取消句柄。

import type { GatePolicy, RunBudget, ToolPort } from "@vibe/core";
import type { AgentRuntime, RunEngine, RuntimeDeps } from "@vibe/runtime";

export type BridgeRunStatus = "running" | "awaiting_human" | "completed" | "partial" | "failed" | "cancelled";

export interface RunEntry {
  runId: string;
  taskId: string;
  status: BridgeRunStatus;
  controller: AbortController;
  startedAt: number;
  /** 该 run 累计挂起过的门数；request_id = gate-<gateSeq>，与 translate 计数同源同步。 */
  gateSeq?: number;
  /** 挂起中的闸门批复请求（gate-N）；无挂起时为 undefined。 */
  pendingGateRequestId?: string;
  /** 摘要给 GET /v1/runs/:id 的轮询方（Python get_pending_questions 等价）。 */
  pendingQuestions?: { request_id: string; questions: unknown };
  resultText?: string;
  errorCode?: string;
  /** 每 run 资源回收（MCP 服务器进程等）；真终局关闭 feed 时调用。 */
  dispose?: () => Promise<void>;
  /** 该 run 的 runtime 实例（有 runFactory 时按 run 组装，resume 必须回到同一实例）。 */
  runtime?: AgentRuntime;
  /** 当前（或最近一个）run handle；resume 前必须等它的 done——RunLog 单写者。 */
  handle?: import("@vibe/runtime").RunHandle;
  /** 本 run 曾在确认闸门挂起并被保持开放；此后旧 consume 的收尾无权终局。 */
  gateHeld?: boolean;
  /** 批复已受理、resume 排队在 prev.done 之后：旧 consume 的收尾在此窗口无权终局。 */
  resuming?: boolean;
}

export interface RunRequest {
  taskId: string;
  prompt: string;
  systemExtra?: string;
  mode: string;
  messageHistory?: unknown[];
  workspaceDir?: string;
  persistPrompt: boolean;
  /** AI profile（对应原 task.ai_profile_id）；多供应商配置下决定引擎用哪个 provider。 */
  profileId?: string;
}

export class TaskRegistry {
  private readonly byTask = new Map<string, RunEntry>();
  private readonly byRun = new Map<string, RunEntry>();

  /** 拒绝重复启动（同 task 已有活 run）。返回 undefined = 被拒。 */
  start(runId: string, req: RunRequest): RunEntry | undefined {
    if (this.isRunning(req.taskId)) return undefined;
    const entry: RunEntry = {
      runId,
      taskId: req.taskId,
      status: "running",
      controller: new AbortController(),
      startedAt: Date.now(),
    };
    this.byTask.set(req.taskId, entry);
    this.byRun.set(runId, entry);
    return entry;
  }

  finish(runId: string, status: BridgeRunStatus, patch?: Partial<RunEntry>): RunEntry | undefined {
    const entry = this.byRun.get(runId);
    if (!entry) return undefined;
    entry.status = status;
    entry.pendingGateRequestId = undefined;
    entry.pendingQuestions = undefined;
    Object.assign(entry, patch ?? {});
    return entry;
  }

  get(taskId: string): RunEntry | undefined {
    return this.byTask.get(taskId);
  }

  getByRunId(runId: string): RunEntry | undefined {
    return this.byRun.get(runId);
  }

  isRunning(taskId: string): boolean {
    const entry = this.byTask.get(taskId);
    return entry !== undefined && (entry.status === "running" || entry.status === "awaiting_human");
  }

  /** 在飞 run 数（并发上限守卫）。 */
  get inFlight(): number {
    let n = 0;
    for (const entry of this.byTask.values()) {
      if (entry.status === "running" || entry.status === "awaiting_human") n += 1;
    }
    return n;
  }
}

/** 每 run 定制执行面：MCP 工具面按任务拉起时，engine/tools 必须按 run 组装。 */
export interface RunFactoryResult {
  engine: RunEngine;
  tools: ToolPort;
  gates?: GatePolicy;
  budget?: RunBudget;
  dispose?: () => Promise<void>;
}

export interface RunFactoryContext {
  taskId: string;
  request: RunRequest;
}

export type RunFactory = (ctx: RunFactoryContext) => Promise<RunFactoryResult>;

export interface BridgeDeps {
  /**
   * 静态 Runtime 依赖面（不含 newRunId —— 桥接管 runId 生成，保证注册表里的
   * 外部 runId 与 RunLog 里的 runId 同一，resume/answers 才能路由到真 run）。
   */
  base: Omit<RuntimeDeps, "newRunId">;
  /** 可选：每 run 覆盖 engine/tools/gates/budget（如按任务拉 MCP 服务器）；缺省全部 run 共用 base。 */
  runFactory?: RunFactory;
  registry: TaskRegistry;
  maxConcurrent: number;
  token?: string;
  log?: (msg: string) => void;
}
