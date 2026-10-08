import type { RunReviewContext, RunReviewResult } from "@vibe/runtime";
import type { PiReviewer } from "./reviewer";
import type { VibeSkill } from "./skills";

/**
 * 技能 DoD 评审：消费 vibe 技能 `review:` frontmatter 契约
 * （evidence 证据 glob / checks 确定性检查脚本 / criteria LLM 评审 rubric），
 * 产出 Runtime 的 RunReviewResult。审计义务来自枚举清单，incomplete 必须点名缺失材料。
 */
export interface SkillDodReviewOptions {
  skill: VibeSkill;
  /** LLM rubric 评审者；缺省时只跑确定性检查 */
  reviewer?: PiReviewer;
  /** checks 脚本执行器（工作区确定性检查器）；缺省时检查记为“未执行”而不是静默放过 */
  runCheck?: (script: string) => Promise<{ ok: boolean; message?: string }>;
  /** 观察 payload 进 LLM 提示词前的截断长度（默认 600 字符） */
  maxObservationChars?: number;
}

export function createSkillDodReview(
  options: SkillDodReviewOptions,
): (ctx: RunReviewContext) => Promise<RunReviewResult> {
  const contract = options.skill.review?.raw ?? {};
  const evidence = Array.isArray(contract.evidence) ? contract.evidence.map((e) => String(e)) : [];
  const checks = Array.isArray(contract.checks) ? contract.checks.map((c) => String(c)) : [];
  const criteria = typeof contract.criteria === "string" ? contract.criteria : "";

  return async (ctx) => {
    const missing: string[] = [];
    const reasons: string[] = [];

    // 1) evidence：观察载荷中必须能匹配到证据模式
    if (evidence.length > 0) {
      const haystack = ctx.state.observations
        .map((o) => JSON.stringify((o as { data?: unknown }).data ?? o))
        .join("\n");
      for (const pattern of evidence) {
        if (!globMatches(pattern, haystack)) missing.push(`evidence: ${pattern}`);
      }
    }

    // 2) checks：确定性检查脚本。没有执行器时显式记“未执行”，绝不静默放行。
    for (const script of checks) {
      if (!options.runCheck) {
        missing.push(`check 未执行: ${script}`);
        reasons.push(`未提供 runCheck，无法执行 ${script}`);
        continue;
      }
      const result = await options.runCheck(script);
      if (!result.ok) {
        missing.push(`check: ${script}${result.message ? ` (${result.message})` : ""}`);
      }
    }

    // 3) criteria：LLM rubric 评审（约定：首行 PASS 或 FAIL: <缺失，分号分隔>）
    if (criteria && options.reviewer) {
      const observations = ctx.state.observations
        .map((o) => JSON.stringify(o).slice(0, options.maxObservationChars ?? 600))
        .join("\n");
      const lastMessage = ctx.state.messages[ctx.state.messages.length - 1];
      const verdict = (
        await options.reviewer.ask(
          [
            "你是电商运营任务的完成度评审员。依据评审标准判断本次任务结果是否可放行。",
            `评审标准：${criteria}`,
            `任务输入：${JSON.stringify(ctx.task.input)}`,
            `最终答复摘要：${JSON.stringify(lastMessage).slice(0, 800)}`,
            `工具观察（截断）：\n${observations}`,
            "",
            "只回答下面两行之一，不要输出任何其它内容：",
            "PASS",
            "FAIL: <缺失材料，多条用分号分隔>",
          ].join("\n"),
        )
      ).trim();
      const firstLine = verdict.split("\n")[0]?.trim() ?? "";
      if (/^FAIL/i.test(firstLine)) {
        reasons.push(`LLM rubric 判定 FAIL：${firstLine}`);
        const detail = firstLine.replace(/^FAIL[:：]\s*/i, "").trim();
        const items = detail
          ? detail.split(/[;；]/).map((s) => s.trim()).filter(Boolean)
          : [];
        if (items.length > 0) for (const item of items) missing.push(`rubric: ${item}`);
        else missing.push("rubric: 评审员判定未达标");
      }
    }

    if (missing.length === 0) return { verdict: "pass" };
    return {
      verdict: "incomplete",
      missingMaterial: [...new Set(missing)],
      ...(reasons.length > 0 ? { reason: reasons.join("；") } : {}),
    };
  };
}

/** 极简 glob（支持 ** 跨段、* 单段内、? 单字符），对整个文本做搜索式匹配。 */
export function globMatches(pattern: string, text: string): boolean {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("")
        .map((ch) => {
          if (ch === "*") return "[^/]*";
          if (ch === "?") return "[^/]";
          return /[a-zA-Z0-9/]/.test(ch) ? ch : `\\${ch}`;
        })
        .join(""),
    )
    .join(".*");
  return new RegExp(source).test(text);
}
