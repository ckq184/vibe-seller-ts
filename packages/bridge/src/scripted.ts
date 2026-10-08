// 脚本引擎引导：VIBE_BRIDGE_ENGINE=scripted 时的确定性引擎（对齐原仓库
// Options.MOCK_CLI 的假后端模式——测试/CI 用，绝不假装是真模型）。

import { driveLoop, modelDrivenCore, scriptedModel, type Decision, type GatePolicy, type ToolIntent, type ToolPort } from "@vibe/core";
import type { EngineDeps, RunEngine } from "@vibe/runtime";

export interface ScriptedConfig {
  decisions: Decision[];
  gatedTools: string[];
  /** 工具桩：任何调用回显参数并成功（脚本引擎只验证桥协议，不验证工具语义）。 */
  toolNames: string[];
}

export function parseScriptedConfig(raw: string): ScriptedConfig {
  const parsed = JSON.parse(raw) as {
    decisions?: Decision[];
    gated_tools?: string[];
    tool_names?: string[];
  };
  return {
    decisions: parsed.decisions ?? [],
    gatedTools: parsed.gated_tools ?? [],
    toolNames: parsed.tool_names ?? [],
  };
}

export function gatePolicyFor(toolNames: readonly string[]): GatePolicy | undefined {
  if (toolNames.length === 0) return undefined;
  const gated = new Set(toolNames);
  return {
    requiresApproval: (intent: ToolIntent) => gated.has(intent.name),
    question: (intent: ToolIntent) =>
      `工具 ${intent.name} 需要人工确认后才能执行。参数：${JSON.stringify(intent.arguments)}`,
  };
}

export function createScriptedEngine(config: ScriptedConfig, toolPort?: ToolPort): RunEngine {
  const model = scriptedModel(config.decisions);
  const allowed = new Set(config.toolNames);
  const tools: ToolPort = toolPort ?? {
    execute: async (intent) => {
      // 真实异步边界：脚本引擎也要给取消/信号留出插进事件循环的位置
      await new Promise((r) => setTimeout(r, 2));
      if (allowed.size > 0 && !allowed.has(intent.name)) {
        return { status: "error", error: { code: "invalid_tool", message: `未知工具：${intent.name}` } };
      }
      return { status: "success", result: { status: "success", tool: intent.name, args: intent.arguments } };
    },
  };
  const gates = gatePolicyFor(config.gatedTools);
  return (deps: EngineDeps) =>
    driveLoop(deps.state, {
      core: modelDrivenCore(model),
      tools,
      budget: deps.budget,
      gates,
      signal: deps.signal,
      emit: deps.emit,
      now: deps.now,
      nextToolCallId: deps.nextToolCallId,
    });
}
