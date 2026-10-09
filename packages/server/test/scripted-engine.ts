// server 测试专用确定性引擎（原 @vibe/bridge scripted.ts）。
// Phase 5.2 桥的 scripted 引擎随 Python 编排路径退役：生产路径（VIBE_BRIDGE_ENGINE=
// scripted）已不存在；仅测试仍需要一个零网络的确定性引擎驱动编排器/调度器全链路，
// 故落为测试助手（实现逐字未改；闸门策略 gatePolicyFor 仍在 @vibe/bridge 生产面）。

import { gatePolicyFor } from "@vibe/bridge";
import { driveLoop, modelDrivenCore, scriptedModel, type Decision, type ToolPort } from "@vibe/core";
import type { EngineDeps, RunEngine } from "@vibe/runtime";

export { gatePolicyFor };

export interface ScriptedConfig {
  decisions: Decision[];
  gatedTools: string[];
  /** 工具桩：任何调用回显参数并成功（脚本引擎只验证协议与编排，不验证工具语义）。 */
  toolNames: string[];
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
