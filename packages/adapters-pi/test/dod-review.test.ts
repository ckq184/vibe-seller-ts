import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  driveLoop,
  fakeTools,
  initialState,
  modelDrivenCore,
  replayState,
  scriptedModel,
  type AgentEvent,
  type RawAgentEvent,
} from "@vibe/core";
import type { RunReviewContext } from "@vibe/runtime";
import { createSkillDodReview, type PiReviewer } from "../src/index";
import { loadVibeSkills } from "../src/index";

const task = { id: "t1", input: { store: "noon-sg", reportType: "fbn_inventory" } };

/** 跑一个真实的小 run（导出报表）拿到事件日志与状态，作为评审上下文。 */
async function buildContext(observations: { name: string; data: unknown }[]): Promise<RunReviewContext> {
  const events: AgentEvent[] = [];
  let sequence = 0;
  events.push({ type: "run_started", runId: "r1", sequence: sequence++, timestamp: 0, sessionId: "s1", task });
  const emit = (raw: RawAgentEvent) => {
    events.push({ ...raw, runId: "r1", sequence: sequence++ } as AgentEvent);
  };
  const handlers: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {};
  for (const o of observations) {
    handlers[o.name] = () => o.data as Record<string, unknown>;
  }
  const script = [
    ...observations.map((o) => ({ kind: "call_tool" as const, intent: { name: o.name, arguments: {} } })),
    { kind: "respond" as const, content: "报表已导出" },
  ];
  await driveLoop(initialState(task), {
    core: modelDrivenCore(scriptedModel(script)),
    tools: fakeTools(handlers),
    budget: { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 2000 },
    signal: new AbortController().signal,
    emit,
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    nextToolCallId: (() => {
      let i = 0;
      return () => `tc-${++i}`;
    })(),
  });
  const state = replayState(events);
  if (!state) throw new Error("unreachable");
  return { runId: "r1", task, events, state };
}

const fixtureSkill = async () => {
  const { skills } = await loadVibeSkills(join(__dirname, "fixtures", "skills"));
  const skill = skills.find((s) => s.name === "noon-fbn");
  if (!skill) throw new Error("fixture skill missing");
  return skill;
};

function fakeReviewer(answer: string, log: string[] = []): PiReviewer {
  return {
    modelId: "fake",
    ask: async (prompt) => {
      log.push(prompt);
      return answer;
    },
  };
}

describe("技能 DoD 评审（createSkillDodReview）", () => {
  it("evidence 缺失 → incomplete 且点名证据模式；checks 无执行器时显式记未执行", async () => {
    const skill = await fixtureSkill();
    const ctx = await buildContext([
      { name: "list_reports", data: { reports: [{ id: "R-1001" }] } }, // 没有任何 csv 证据
    ]);
    const review = createSkillDodReview({ skill });
    const result = await review(ctx);

    expect(result.verdict).toBe("incomplete");
    expect(result.missingMaterial).toContain("evidence: reports/**/*.csv");
    expect(result.missingMaterial).toContain("check 未执行: scripts/check_fee_rows.py");
  });

  it("evidence 命中 + runCheck 通过 + rubric FAIL → incomplete（rubric 细节分号拆条）", async () => {
    const skill = await fixtureSkill();
    const ctx = await buildContext([
      { name: "download_report", data: { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 } },
    ]);
    const prompts: string[] = [];
    const reviewer = fakeReviewer("FAIL: 银行流水缺失；VAT 对账不平", prompts);
    const review = createSkillDodReview({
      skill,
      reviewer,
      runCheck: async (script) => ({ ok: script === "scripts/check_fee_rows.py" }),
    });
    const result = await review(ctx);

    expect(result.verdict).toBe("incomplete");
    expect(result.missingMaterial).toEqual(["rubric: 银行流水缺失", "rubric: VAT 对账不平"]);
    // rubric 提示词里包含评审标准与任务输入
    expect(prompts[0]).toContain("ASN 必须真实出现在列表");
    expect(prompts[0]).toContain("noon-sg");
  });

  it("evidence 命中 + checks 通过 + rubric PASS → 放行", async () => {
    const skill = await fixtureSkill();
    const ctx = await buildContext([
      { name: "download_report", data: { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 } },
    ]);
    const review = createSkillDodReview({
      skill,
      reviewer: fakeReviewer("PASS"),
      runCheck: async () => ({ ok: true }),
    });
    const result = await review(ctx);
    expect(result.verdict).toBe("pass");
  });

  it("无 reviewer 无 criteria 路径：只跑确定性检查", async () => {
    const skill = await fixtureSkill();
    const ctx = await buildContext([
      { name: "download_report", data: { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 } },
    ]);
    const executed: string[] = [];
    const review = createSkillDodReview({
      skill,
      runCheck: async (script) => {
        executed.push(script);
        return { ok: true };
      },
    });
    const result = await review(ctx);
    expect(result.verdict).toBe("pass");
    expect(executed).toEqual(["scripts/check_fee_rows.py"]);
  });
});

describe("globMatches", () => {
  it("** 跨段、* 单段、正则元字符转义", async () => {
    const { globMatches } = await import("../src/index");
    expect(globMatches("reports/**/*.csv", "x/reports/2026-09/R-1.csv")).toBe(true);
    expect(globMatches("reports/*.csv", "x/reports/R-1.csv")).toBe(true);
    expect(globMatches("reports/*.csv", "x/reports/2026-09/R-1.csv")).toBe(false);
    expect(globMatches("**/*.pdf", "x/reports/R-1.csv")).toBe(false);
  });
});
