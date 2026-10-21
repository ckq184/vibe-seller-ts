// run 的 prompt/system 组装（批次 4.3 精简版；店铺上下文的完整形态在 4.5 workspace
// 批次深化——STORE.md/知识库/catalog 限制提示词届时接入）。
// 头部语义对齐原 task_runner.py 的 TaskHeader：design/auto/execute/woken/chat。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config";
import { storeSlug } from "../workspace/storeData";

export type RunMode = "execute" | "design" | "plan_execute" | "woken" | "chat";

export interface PromptTask {
  id: string;
  title: string;
  description: string | null;
  platform: string | null;
  country: string | null;
  store_id: string | null;
  wait_condition: string | null;
  plan: string | null;
}

export interface PromptInput {
  task: PromptTask;
  mode: RunMode;
  store?: { id: string; name: string } | null;
  /** 上一轮结果/历史（follow-up 场景），逐条 {role, content}。 */
  history?: { role: string; content: string }[];
}

function storeContext(config: ServerConfig, store: { id: string; name: string } | undefined | null): string {
  if (!store) return "";
  // 原 task_runner_context.py：slug = _store_slug(store.name, store.id)，档案在 stores/{slug}/
  const storeMd = join(config.homeDir, "stores", storeSlug(store.name, store.id), "STORE.md");
  if (existsSync(storeMd)) {
    try {
      return readFileSync(storeMd, "utf8").slice(0, 8000);
    } catch {
      return "";
    }
  }
  return "";
}

export function buildRunPrompt(config: ServerConfig, input: PromptInput): { prompt: string; systemExtra: string } {
  const { task, mode, store, history = [] } = input;
  const sections: string[] = [];

  const header =
    mode === "design"
      ? "【设计任务】请先产出一份可执行计划（不要执行写操作），计划要具体到步骤。"
      : mode === "plan_execute"
        ? "【执行已批准的计划】按计划执行；偏离计划时先说明原因。"
        : mode === "woken"
          ? "【任务被唤醒】此前任务在等待条件；请先读取等待条件与最新状态再继续。"
          : mode === "chat"
            ? "【跟进消息】这是用户在任务完成后的追加消息，请结合上下文继续处理。"
            : "【执行任务】直接执行，用工具获取数据，完成后给出简短结论。";
  sections.push(header);

  const desc = task.description || task.title;
  sections.push(`任务：${task.title}\n\n${desc}`);
  if (task.platform || task.country) {
    sections.push(`平台/国家：${[task.platform, task.country].filter(Boolean).join(" / ")}`);
  }
  if (mode === "plan_execute" && task.plan) {
    sections.push(`已批准的计划：\n${task.plan}`);
  }
  if (mode === "woken" && task.wait_condition) {
    sections.push(`等待条件：${task.wait_condition}`);
  }
  const ctx = storeContext(config, store);
  if (ctx) sections.push(`店铺资料（STORE.md）：\n${ctx}`);
  if (history.length > 0) {
    const recent = history.slice(-10);
    sections.push(
      `对话历史（最近 ${recent.length} 条）：\n${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}`,
    );
  }
  sections.push("需要数据时调用工具；拿到足够信息后，用一段简短文字作为最终答复，不再调用工具。");
  return { prompt: sections.join("\n\n"), systemExtra: "" };
}
