import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { extractAssistantText } from "./pi-engine";

/**
 * 单次 LLM 调用封装：DoD rubric 评审与任务后反思共用。
 * 走 ModelRuntime.complete()（已核实的 SDK 表面），不经过 agent 循环。
 */
export interface PiReviewer {
  modelId: string;
  ask(prompt: string): Promise<string>;
}

export function createPiReviewer(options: {
  modelRuntime: ModelRuntime;
  model: Model<any>;
  systemPrompt?: string;
}): PiReviewer {
  return {
    modelId: String(options.model.id),
    ask: async (prompt) => {
      const context: Context = {
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      };
      const message = await options.modelRuntime.complete(options.model, context);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `reviewer LLM call failed (${message.stopReason})`);
      }
      return extractAssistantText(message.content) ?? "";
    },
  };
}
