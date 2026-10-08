import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { isAbortError, resolvePendingGate, type GatePolicy, type ToolCallResult, type ToolIntent, type ToolPort } from "@vibe/core";
import type { RunEngine } from "@vibe/runtime";
import type { TSchema } from "typebox";

// 本文件的每个 SDK API 都对照 node_modules 内 v0.84.2 的 dist/*.d.ts 核实过（2026-09-24），
// 出处见 docs/adapter-mapping-note.md；禁止凭记忆新增 SDK 调用。

export interface VibeToolSpec {
  name: string;
  description: string;
  /** TypeBox schema（模型看到的参数面） */
  parameters: TSchema;
}

export interface PiEngineConfig {
  modelRuntime: ModelRuntime;
  model: Model<any>;
  systemPrompt: string;
  /** 工具执行面：闸门与执行都在引擎掌控之下 */
  toolPort: ToolPort;
  toolSpecs: readonly VibeToolSpec[];
  /** 确认闸门：命中的工具意图先挂起等批复（语义裁判是 core 的 resolvePendingGate，与 Core 引擎一致） */
  gates?: GatePolicy;
  cwd: string;
  agentDir: string;
}

/**
 * Pi 引擎：SDK 拥有循环（一次 prompt() = 一整段 episode），本适配器把 SDK 事件归一化为
 * 产品级事件流：
 *
 *   turn_start           → model_requested
 *   tool_execution_start → decision_made(call_tool) + tool_started
 *   tool_execution_end   → tool_completed + observation_added
 *   （最后的 assistant 文本）→ decision_made(respond)
 *
 * 确认闸门：episode 内命中门的意图不执行、立即中止会话并挂起（awaiting_human）；
 * 恢复时批复在 SDK 之外消费——批准则引擎亲自执行工具并把结果以 recap 交回模型继续，
 * 拒绝则把拒绝说明交回模型。事件词表与 Core 引擎逐字对齐，金标可交叉验证。
 */
export function createPiEngine(config: PiEngineConfig): RunEngine {
  return async (deps) => {
    const startedAt = deps.now();
    const toolCallIds = new Map<string, string>();
    const toolStartTimes = new Map<string, number>();
    let toolCalls = 0;
    let turns = 0;
    let finalText: string | undefined;
    let abortReason: "budget_tools" | "budget_iterations" | undefined;
    let failure: { code: "provider_unavailable" | "runtime_error"; message: string } | undefined;
    let gateSuspension: { intent: ToolIntent } | undefined;

    // —— 闸门恢复：批复在 SDK 之外消费（挂起前的会话已废弃，用 recap 把结果交回模型） ——
    const pending = deps.gates ? resolvePendingGate(deps.state, deps.gates) : undefined;
    let gateRecap: string | undefined;
    if (pending?.verdict === "approved") {
      const intent = pending.intent;
      toolCalls += 1;
      const id = deps.nextToolCallId();
      const t0 = deps.now();
      deps.emit({ type: "tool_started", toolCallId: id, toolName: intent.name, timestamp: t0 });
      let result: ToolCallResult;
      try {
        result = await config.toolPort.execute(intent, deps.signal);
      } catch (err) {
        if (deps.signal.aborted || isAbortError(err)) {
          return { status: "cancelled", state: deps.state, usage: { toolCalls, durationMs: deps.now() - startedAt } };
        }
        result = { status: "error", error: { code: "runtime_error", message: err instanceof Error ? err.message : String(err) } };
      }
      const completedAt = deps.now();
      const payload = result.status === "success" ? result.result : { error: result.error };
      deps.emit({
        type: "tool_completed",
        toolCallId: id,
        toolName: intent.name,
        status: result.status,
        ...(result.status === "success" ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
        durationMs: completedAt - t0,
        timestamp: completedAt,
      });
      deps.emit({ type: "observation_added", name: intent.name, observation: payload, timestamp: deps.now() });
      gateRecap = [
        `你此前请求调用工具 ${intent.name}（参数 ${JSON.stringify(intent.arguments)}），已获人工批准并执行完毕。`,
        `执行结果：${JSON.stringify(payload)}`,
        "请基于该结果继续完成任务。",
      ].join("\n");
    } else if (pending?.verdict === "denied") {
      const intent = pending.intent;
      const denial = { error: { code: "approval_denied", message: "human declined this tool call" } };
      deps.emit({ type: "observation_added", name: intent.name, observation: denial, timestamp: deps.now() });
      gateRecap = [
        `你此前请求调用工具 ${intent.name}（参数 ${JSON.stringify(intent.arguments)}）被用户拒绝。`,
        "不得再次请求执行该工具；请改用替代方案，或如实向用户汇报当前状态。",
      ].join("\n");
    }

    // —— 会话与门控工具桥 ——
    const sessionCell: { session?: AgentSession } = {};
    const gatedToolPort: ToolPort = {
      execute: async (intent, signal) => {
        if (deps.gates?.requiresApproval(intent)) {
          // 翻译层（tool_execution_start）负责挂起事件；这里只负责中止 episode
          void sessionCell.session?.abort();
          return { status: "error", error: { code: "approval_required", message: "suspended for human approval" } };
        }
        return config.toolPort.execute(intent, signal);
      },
    };
    const tools = defineVibeTools(gatedToolPort, config.toolSpecs);

    const session = (
      await createAgentSession({
        cwd: config.cwd,
        agentDir: config.agentDir,
        model: config.model,
        thinkingLevel: "off",
        modelRuntime: config.modelRuntime,
        customTools: tools,
        tools: tools.map((tool) => tool.name),
        sessionManager: SessionManager.inMemory(config.cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        resourceLoader: minimalResourceLoader(config.systemPrompt),
      })
    ).session;
    sessionCell.session = session;

    const abortSession = () => {
      void session.abort();
    };
    if (deps.signal.aborted) abortSession();
    deps.signal.addEventListener("abort", abortSession, { once: true });

    const unsubscribe = session.subscribe((event) => {
      // 闸门挂起后 episode 正在被中止：SDK 收尾过程产生的事件（多余的 turn_start、
      // 被中止工具的 tool_execution_end 等）一律不再翻译
      if (gateSuspension) return;
      switch (event.type) {
        case "turn_start": {
          turns += 1;
          if (turns > deps.budget.maxIterations) {
            abortReason = "budget_iterations";
            abortSession();
            return;
          }
          deps.emit({ type: "model_requested", timestamp: deps.now() });
          break;
        }
        case "tool_execution_start": {
          const intent = {
            name: event.toolName,
            arguments: (event.args ?? {}) as Record<string, unknown>,
          };
          if (deps.gates?.requiresApproval(intent)) {
            // 闸门：记决策 → 请求批复 → 中止 episode，绝不执行
            gateSuspension = { intent };
            void session.abort();
            deps.emit({
              type: "decision_made",
              decision: { kind: "call_tool", intent },
              timestamp: deps.now(),
            });
            deps.emit({ type: "human_input_requested", question: deps.gates.question(intent), timestamp: deps.now() });
            return;
          }
          if (toolCalls + 1 > deps.budget.maxToolCalls) {
            abortReason = "budget_tools";
            abortSession();
            return;
          }
          toolCalls += 1;
          deps.emit({
            type: "decision_made",
            decision: { kind: "call_tool", intent },
            timestamp: deps.now(),
          });
          const id = deps.nextToolCallId();
          toolCallIds.set(event.toolCallId, id);
          toolStartTimes.set(event.toolCallId, deps.now());
          deps.emit({ type: "tool_started", toolCallId: id, toolName: event.toolName, timestamp: deps.now() });
          break;
        }
        case "tool_execution_end": {
          if (gateSuspension) return; // 被闸门中止的工具调用不产生完成事件
          const id = toolCallIds.get(event.toolCallId) ?? event.toolCallId;
          const startedAt = toolStartTimes.get(event.toolCallId) ?? deps.now();
          const toolResult = (event.result as { details?: ToolCallResult } | undefined)?.details;
          const status = toolResult?.status ?? (event.isError ? "error" : "success");
          const payload = status === "success" ? toolResult?.result : { error: toolResult?.error };
          deps.emit({
            type: "tool_completed",
            toolCallId: id,
            toolName: event.toolName,
            status,
            ...(payload !== undefined ? { result: payload } : {}),
            ...(status === "error" && toolResult?.error ? { error: toolResult.error } : {}),
            durationMs: deps.now() - startedAt,
            timestamp: deps.now(),
          });
          deps.emit({ type: "observation_added", name: event.toolName, observation: payload, timestamp: deps.now() });
          break;
        }
        case "message_end": {
          if (event.message.role === "assistant") {
            const text = extractAssistantText(event.message.content);
            if (text !== undefined) finalText = text;
          }
          break;
        }
        default:
          break;
      }
    });

    const promptText = gateRecap
      ? [gateRecap, "", "任务输入（JSON）：", JSON.stringify(deps.state.task.input, null, 2)].join("\n")
      : [
          "任务输入（JSON）：",
          JSON.stringify(deps.state.task.input, null, 2),
          "",
          "规则：需要数据时调用工具；拿到足够信息后，用一段简短文字作为最终答复，不再调用工具。",
        ].join("\n");

    try {
      await session.prompt(promptText);
    } catch (err) {
      if (!deps.signal.aborted) {
        failure = {
          code: err instanceof Error && /auth|api key|401|403/i.test(err.message) ? "provider_unavailable" : "runtime_error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    let stats: { tokens: { input: number; output: number } } | undefined;
    try {
      stats = session.getSessionStats();
    } catch {
      // usage 尽力而为（技能验证日志观察 2：部分 provider 不回报 token）
    }
    unsubscribe();
    session.dispose();

    const usage = {
      toolCalls,
      durationMs: deps.now() - startedAt,
      model: String(config.model.id),
      ...(stats ? { inputTokens: stats.tokens.input, outputTokens: stats.tokens.output } : {}),
    };

    if (gateSuspension) {
      // 挂起：不发 respond 决策，等批复后由 resume 续跑
      return {
        status: "awaiting_human",
        state: deps.state,
        question: config.gates?.question(gateSuspension.intent) ?? "需要人工确认",
        pendingIntent: gateSuspension.intent,
        usage,
      };
    }
    if (abortReason === "budget_iterations") {
      return { status: "failed", state: deps.state, error: { code: "budget_iterations", message: `iteration budget exhausted (${deps.budget.maxIterations})` }, usage };
    }
    if (abortReason === "budget_tools") {
      return { status: "failed", state: deps.state, error: { code: "budget_tools", message: `tool budget exhausted (${deps.budget.maxToolCalls})` }, usage };
    }
    if (deps.signal.aborted && !failure) {
      return { status: "cancelled", state: deps.state, usage };
    }
    if (failure) {
      return { status: "failed", state: deps.state, error: failure, usage };
    }

    // 成功路径的收尾决策：与 Core 引擎同构——respond 决策先于 usage/终态事件
    deps.emit({
      type: "decision_made",
      decision: { kind: "respond", content: finalText ?? "" },
      timestamp: deps.now(),
    });
    return { status: "completed", state: deps.state, result: finalText ?? "", usage };
  };
}

/** ToolPort → SDK defineTool 桥：结果转 { content, details }，SDK 细节不回灌 Core。 */
export function defineVibeTools(toolPort: ToolPort, specs: readonly VibeToolSpec[]): ToolDefinition[] {
  return specs.map((spec) =>
    defineTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (_toolCallId, params, signal) => {
        const result: ToolCallResult = await toolPort.execute(
          { name: spec.name, arguments: params as Record<string, unknown> },
          signal ?? new AbortController().signal,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result.status === "success" ? result.result : { error: result.error }) },
          ],
          details: result,
        };
      },
    }),
  );
}

export function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text);
  const text = parts.join("").trim();
  return text.length > 0 ? text : undefined;
}

/** 完全受控的资源加载器（官方 12-full-control.ts 模式）：无发现、无注入，系统提示词来自配置。 */
function minimalResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
