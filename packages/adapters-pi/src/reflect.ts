import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunAfterContext } from "@vibe/runtime";

/**
 * 任务后反思：把可迁移经验（URL 模式、页面结构、流程规则、踩坑）追加写入知识笔记。
 * 对齐 vibe-seller 反思硬规则——只写可迁移、非时效性的知识；
 * 模型无可沉淀内容时回答 NONE，则什么都不写。
 */
export interface ReflectorOptions {
  ask: (prompt: string) => Promise<string>;
  /** 追加式知识笔记路径（如 stores/<slug>/notes.md） */
  notesFile: string;
  /** 时间戳来源；默认 UTC ISO */
  clock?: () => string;
}

export function createReflector(options: ReflectorOptions): (ctx: RunAfterContext) => Promise<void> {
  return async (ctx) => {
    const observations = ctx.state.observations
      .map((o) => JSON.stringify(o).slice(0, 600))
      .join("\n");
    const answer = (
      await options.ask(
        [
          "以下是刚完成的电商运营任务。请提取 0-3 条可迁移经验（URL 模式、页面结构、流程规则、踩坑）。",
          "硬规则：只写可迁移、非时效性的知识；禁止包含任务业务数据（SKU、价格、订单号）与时点状态。",
          "若无值得沉淀的内容，只回答 NONE。",
          "",
          `任务输入：${JSON.stringify(ctx.task.input)}`,
          `终局状态：${ctx.run.status}`,
          `工具观察（截断）：\n${observations || "（无）"}`,
        ].join("\n"),
      )
    ).trim();

    const firstLine = answer.split("\n")[0]?.trim() ?? "";
    if (!answer || /^NONE$/i.test(firstLine)) return;

    const stamp = (options.clock ?? (() => new Date().toISOString()))();
    await mkdir(dirname(options.notesFile), { recursive: true });
    await appendFile(options.notesFile, `\n## Skill follow-ups (${stamp})\n\n${answer}\n`, "utf8");
  };
}
