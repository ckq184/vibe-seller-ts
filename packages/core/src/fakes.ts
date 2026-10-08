import { abortError } from "./errors";
import type { Decision, ModelPort, ToolIntent, ToolPort } from "./types";

export { abortError };

/**
 * 脚本化模型：按顺序弹出决策。
 * 脚本耗尽时诚实 respond("script exhausted") 而不是伪造成功 —— 假路径也遵守
 * “绝不冒充完成”的不变量。
 */
export function scriptedModel(script: readonly Decision[]): ModelPort {
  const queue = [...script];
  return {
    async decide(_state, signal) {
      if (signal.aborted) throw abortError();
      const decision = queue.shift();
      if (!decision) return { kind: "respond", content: "script exhausted" };
      return decision;
    },
  };
}

export type FakeToolHandler = (args: Record<string, unknown>) => Record<string, unknown>;

/**
 * 假工具箱：allowlist 语义 —— 未注册的工具一律拒绝（invalid_tool）；
 * handler 抛错归一为 error 结果而不是打断循环。
 */
export function fakeTools(handlers: Record<string, FakeToolHandler>): ToolPort {
  return {
    async execute(intent: ToolIntent, signal) {
      if (signal.aborted) throw abortError();
      const handler = handlers[intent.name];
      if (!handler) {
        return { status: "error", error: { code: "invalid_tool", message: `unknown tool: ${intent.name}` } };
      }
      try {
        return { status: "success", result: handler(intent.arguments) };
      } catch (err) {
        return { status: "error", error: { code: "runtime_error", message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
