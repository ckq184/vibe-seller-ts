import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkillPromptSection, loadVibeSkills } from "../src/index";

const fixtures = join(__dirname, "fixtures", "skills");

describe("vibe 技能加载器（SKILL.md frontmatter）", () => {
  it("发现技能、解析 requires 与 review 契约、提取正文", async () => {
    const { skills, missingRequires } = await loadVibeSkills(fixtures);

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["broken-deps", "noon-fbn", "noon-shared"]);
    expect(missingRequires).toEqual(["not-exist-shared"]); // 缺失依赖显式报告

    const fbn = skills.find((s) => s.name === "noon-fbn");
    expect(fbn?.requires).toEqual(["noon-shared"]);
    expect(fbn?.description).toContain("FBN 报表导出");
    expect(fbn?.body).toContain("sum(charged_amount)");
    expect(fbn?.review?.raw).toMatchObject({
      evidence: ["reports/**/*.csv"],
    });
  });

  it("prompt 注入：只包含点名激活的技能，正文与依赖齐全", async () => {
    const { skills } = await loadVibeSkills(fixtures);
    const prompt = buildSkillPromptSection(skills, ["noon-fbn", "noon-shared"]);

    expect(prompt).toContain('<skill name="noon-fbn">');
    expect(prompt).toContain('<skill name="noon-shared">');
    expect(prompt).toContain("sum(charged_amount)");
    expect(prompt).toContain("sellerlab.noon.com");
    expect(prompt).not.toContain("broken-deps"); // 未激活的技能不进提示词
  });
});
