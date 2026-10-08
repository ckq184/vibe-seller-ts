import { describe, expect, it } from "vitest";
import {
  applyHumanInput,
  driveLoop,
  fakeTools,
  initialState,
  modelDrivenCore,
  scriptedModel,
  type AgentEvent,
  type GatePolicy,
  type RawAgentEvent,
  type RunBudget,
  type ToolIntent,
} from "../src/index";

const task = { id: "t1", input: { store: "noon-sg" } };
const budget: RunBudget = { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 2000 };

/** 受门策略：调价（update_price）必须人工批准；查询类直接放行。 */
const priceGate: GatePolicy = {
  requiresApproval: (intent: ToolIntent) => intent.name === "update_price",
  question: (intent: ToolIntent) => `授权执行 ${intent.name}？参数：${JSON.stringify(intent.arguments)}`,
};

function harness() {
  const events: AgentEvent[] = [];
  let sequence = 0;
  let clock = 0;
  let tc = 0;
  return {
    events,
    emit: (raw: RawAgentEvent) => {
      events.push({ ...raw, runId: "r1", sequence: sequence++ } as AgentEvent);
    },
    now: () => (clock += 10),
    nextToolCallId: () => `tc-${++tc}`,
  };
}

describe("确认闸门（GatePolicy）", () => {
  it("受门工具：先挂起等批复，绝不先执行", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([
        { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A1", price: 99 } } },
      ])),
      tools: fakeTools({ update_price: () => ({ ok: true }) }),
      budget,
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });

    expect(outcome.status).toBe("awaiting_human");
    if (outcome.status === "awaiting_human") {
      expect(outcome.question).toContain("update_price");
      expect(outcome.pendingIntent?.arguments).toEqual({ sku: "A1", price: 99 });
    }
    // tool_started 绝不出现
    expect(h.events.some((e) => e.type === "tool_started")).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: "human_input_requested" });
  });

  it("批准后恢复：直接执行挂起意图，不依赖模型重新决策", async () => {
    const h = harness();
    const tools = fakeTools({ update_price: () => ({ ok: true, newPrice: 99 }) });
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A1", price: 99 } } },
      { kind: "respond", content: "调价完成" },
    ]);
    const first = await driveLoop(initialState(task), {
      core: modelDrivenCore(model),
      tools,
      budget,
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });
    expect(first.status).toBe("awaiting_human");

    // Runtime resume 语义：批复作为 human 消息注入后重放续跑
    const resumedState = applyHumanInput(first.state, { kind: "tool_approval", approved: true });
    const second = await driveLoop(resumedState, {
      core: modelDrivenCore(model),
      tools,
      budget,
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });

    expect(second.status).toBe("completed");
    const started = h.events.filter((e) => e.type === "tool_started");
    expect(started).toHaveLength(1); // 只执行一次
    expect(second.state.observations).toEqual([{ name: "update_price", data: { ok: true, newPrice: 99 } }]);
    // 批准路径不产生重复的 decision_made（决策在挂起前已记录）
    expect(h.events.filter((e) => e.type === "decision_made")).toHaveLength(2); // call_tool + respond
  });

  it("拒绝后恢复：落 approval_denied 观察，不执行，模型可改走替代路径", async () => {
    const h = harness();
    const tools = fakeTools({ update_price: () => ({ ok: true }) });
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A1", price: 99 } } },
      { kind: "respond", content: "用户拒绝调价，保持原价" },
    ]);
    const first = await driveLoop(initialState(task), {
      core: modelDrivenCore(model),
      tools,
      budget,
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });
    expect(first.status).toBe("awaiting_human");

    const resumedState = applyHumanInput(first.state, { kind: "tool_approval", approved: false });
    const second = await driveLoop(resumedState, {
      core: modelDrivenCore(model),
      tools,
      budget,
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });

    expect(second.status).toBe("completed");
    expect(h.events.some((e) => e.type === "tool_started")).toBe(false); // 始终没执行
    expect(second.state.observations.at(-1)).toEqual({
      name: "update_price",
      data: { error: { code: "approval_denied", message: expect.any(String) } },
    });
  });

  it("未受门工具不受影响", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([
        { kind: "call_tool", intent: { name: "list_reports", arguments: {} } },
        { kind: "respond", content: "ok" },
      ])),
      tools: fakeTools({ list_reports: () => ({ reports: [] }) }),
      budget,
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });
    expect(outcome.status).toBe("completed");
    expect(h.events.filter((e) => e.type === "tool_completed")).toHaveLength(1);
  });

  it("批准后的执行计入工具预算", async () => {
    const h = harness();
    const tools = fakeTools({ update_price: () => ({ ok: true }) });
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A1", price: 99 } } },
    ]);
    const first = await driveLoop(initialState(task), {
      core: modelDrivenCore(model),
      tools,
      budget: { ...budget, maxToolCalls: 1 },
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });
    expect(first.status).toBe("awaiting_human");

    const resumedState = applyHumanInput(first.state, { kind: "tool_approval", approved: true });
    const second = await driveLoop(resumedState, {
      core: modelDrivenCore(model),
      tools,
      budget: { ...budget, maxToolCalls: 1 },
      signal: new AbortController().signal,
      gates: priceGate,
      ...h,
    });
    // 恢复后执行消耗了唯一一次工具预算，随后诚实失败
    expect(second).toMatchObject({ status: "failed", error: { code: "budget_tools" } });
    expect(h.events.filter((e) => e.type === "tool_completed")).toHaveLength(1);
  });
});
