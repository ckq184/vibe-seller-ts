import { readFile } from "node:fs/promises";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * vibe-seller 技能格式加载器（SKILL.md + YAML frontmatter）。
 *
 * 兼容原项目 app/skills_v2 的关键 frontmatter 字段：
 *   name / description —— 标准 Agent Skills 字段（SDK 负责发现与解析）；
 *   requires           —— 本技能依赖的其它技能名（数组），缺失依赖必须显式报告；
 *   review             —— DoD 审核契约（checks/evidence/criteria），本增量只透传不解释。
 * 发现与 frontmatter 解析用 SDK 原语（loadSkillsFromDir / parseFrontmatter），不自造解析器。
 */

export interface VibeSkillReview {
  raw: Record<string, unknown>;
}

export interface VibeSkill {
  name: string;
  description: string;
  /** 依赖的其它技能名 */
  requires: string[];
  /** frontmatter 之外的正文（URL 模式、页签表、流程知识） */
  body: string;
  /** DoD 审核契约原样保留，供 Runtime review 钩子实现者消费 */
  review?: VibeSkillReview;
  filePath: string;
}

export interface LoadVibeSkillsResult {
  skills: VibeSkill[];
  /** requires 指向的技能不存在时逐条列出——绝不静默忽略依赖缺失 */
  missingRequires: string[];
}

export function loadVibeSkills(dir: string): Promise<LoadVibeSkillsResult> {
  return (async () => {
    const { skills } = loadSkillsFromDir({ dir, source: "vibe" });
    const loaded: VibeSkill[] = [];
    for (const skill of skills) {
      const raw = await readFile(skill.filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const requires = Array.isArray(frontmatter.requires) ? frontmatter.requires.map((r) => String(r)) : [];
      const reviewRaw = frontmatter.review;
      loaded.push({
        name: skill.name,
        description: skill.description ?? "",
        requires,
        body,
        ...(reviewRaw !== undefined && typeof reviewRaw === "object" && reviewRaw !== null
          ? { review: { raw: reviewRaw as Record<string, unknown> } }
          : {}),
        filePath: skill.filePath,
      });
    }
    const names = new Set(loaded.map((s) => s.name));
    const missingRequires = [
      ...new Set(loaded.flatMap((s) => s.requires.filter((r) => !names.has(r)))),
    ];
    return { skills: loaded, missingRequires };
  })();
}

/**
 * 把激活的技能拼进系统提示词。只注入 active 里点名的技能——
 * 与 vibe-seller 的目录契约一致：agent 精确拿到它需要的知识，而不是全量倾倒。
 */
export function buildSkillPromptSection(skills: readonly VibeSkill[], active: readonly string[]): string {
  const chosen = active
    .map((name) => skills.find((s) => s.name === name))
    .filter((s): s is VibeSkill => s !== undefined);
  return chosen
    .map((skill) => {
      const parts = [`<skill name="${skill.name}">`];
      if (skill.description) parts.push(`说明：${skill.description}`);
      if (skill.requires.length > 0) parts.push(`依赖：${skill.requires.join("、")}`);
      parts.push(skill.body.trim());
      parts.push("</skill>");
      return parts.join("\n");
    })
    .join("\n\n");
}
