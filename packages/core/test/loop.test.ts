import { describe, expect, it } from "vitest";
import {
  RunError,
  abortError,
  driveLoop,
  fakeTools,
  initialState,
  modelDrivenCore,
  scriptedModel,
  type AgentCore,
  AgentEvent,
  LoopOutcome,
  RawAgentEvent,
  RunBudget,
  ToolPort,
} from "../src/index";

const task = { id: "t1", input: { store: "noon-sg" } };
const budget: RunBudget = { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 2000 };

/** 确定性时钟/ID：每个测试内先声明，保证事件序列可逐字段断言。 */
function harness() {
  const events: AgentEvent[] = [];
  let sequence = 0;
  let clock = 0;
  let tc = 0;
  const emit = (raw: RawAgentEvent) => {
    events.push({ ...raw, runId: "r1", sequence: sequence++ } as AgentEvent);
  };
  const now = () => (clock += 10);
  const nextToolCallId = () => `tc-${++tc}`;
  return { events, emit, now, nextToolCallId };
}

const alwaysTool = (name: string): AgentCore => ({
  async step() {
    return { kind: "call_tool", intent: { name, arguments: {} } };
  },
});

describe("driveLoop（确定性核心循环）", () => {
  it("工具选择 → 观察追加 → 终局：事件序与状态推进精确", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([
        { kind: "call_tool", intent: { name: "list_reports", arguments: { store: "noon-sg" } } },
        { kind: "respond", content: { summary: "ok" } },
      ])),
      tools: fakeTools({ list_reports: () => ({ reports: [{ id: "R-1" }] }) }),
      budget,
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.state.iteration).toBe(1);
    expect(outcome.state.observations).toEqual([{ name: "list_reports", data: { reports: [{ id: "R-1" }] } }]);
    expect(h.events.map((e) => e.type)).toEqual([
      "model_requested",
      "decision_made",
      "tool_started",
      "tool_completed",
      "observation_added",
      "model_requested",
      "decision_made",
    ]);
    const completed = h.events[3];
    expect(completed).toMatchObject({ type: "tool_completed", toolCallId: "tc-1", status: "success" });
  });

  it("未知工具被拒绝为 invalid_tool，错误也成为观察，运行继续", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([
        { kind: "call_tool", intent: { name: "delete_everything", arguments: {} } },
        { kind: "respond", content: "skipped" },
      ])),
      tools: fakeTools({}),
      budget,
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome.status).toBe("completed");
    const completed = h.events.find((e) => e.type === "tool_completed");
    expect(completed).toMatchObject({ status: "error", error: { code: "invalid_tool" } });
    expect(outcome.state.observations[0]).toEqual({
      name: "delete_everything",
      data: { error: { code: "invalid_tool", message: expect.any(String) } },
    });
  });

  it("迭代预算耗尽 → budget_iterations，诚实失败", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: alwaysTool("download_report"),
      tools: fakeTools({ download_report: () => ({ file: "x.csv" }) }),
      budget: { ...budget, maxIterations: 3, maxToolCalls: 10 },
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome).toMatchObject({ status: "failed", error: { code: "budget_iterations" } });
    expect(h.events.filter((e) => e.type === "tool_completed")).toHaveLength(3);
  });

  it("工具预算耗尽 → budget_tools", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: alwaysTool("download_report"),
      tools: fakeTools({ download_report: () => ({ file: "x.csv" }) }),
      budget: { ...budget, maxIterations: 10, maxToolCalls: 2 },
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome).toMatchObject({ status: "failed", error: { code: "budget_tools" } });
    expect(h.events.filter((e) => e.type === "tool_completed")).toHaveLength(2);
  });

  it("工具执行中被取消 → cancelled，绝不伪造完成", async () => {
    const h = harness();
    const controller = new AbortController();
    // 自我中止的工具：进入执行即触发取消，规避测试时序竞态。
    // 注意：signal 可能已经 aborted，此时 addEventListener 永远不会触发，必须先检查。
    const selfAborting: ToolPort = {
      async execute(_intent, signal) {
        controller.abort();
        await new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
        return { status: "success", result: {} };
      },
    };
    const outcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([
        { kind: "call_tool", intent: { name: "slow_export", arguments: {} } },
        { kind: "respond", content: "never" },
      ])),
      tools: selfAborting,
      budget,
      signal: controller.signal,
      ...h,
    });

    expect(outcome.status).toBe("cancelled");
    expect(h.events.at(-1)?.type).toBe("tool_started"); // tool_completed 不存在
    expect(h.events.filter((e) => e.type === "run_completed")).toHaveLength(0);
  });

  it("ask_human → awaiting_human，问题进入事件流", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([{ kind: "ask_human", question: "确认调价 R-1 → ¥99？" }])),
      tools: fakeTools({}),
      budget,
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome.status).toBe("awaiting_human");
    if (outcome.status === "awaiting_human") expect(outcome.question).toContain("调价");
    expect(h.events.at(-1)).toMatchObject({ type: "human_input_requested", question: expect.stringContaining("调价") });
  });

  it("可重试模型错误按预算退避重试，成功后继续", async () => {
    const h = harness();
    let calls = 0;
    const flaky: AgentCore = {
      async step() {
        calls += 1;
        if (calls <= 2) throw new RunError("rate_limited", "429 slow down");
        return { kind: "respond", content: "ok" };
      },
    };
    const outcome = await driveLoop(initialState(task), {
      core: flaky,
      tools: fakeTools({}),
      budget: { ...budget, maxRetries: 2 },
      signal: new AbortController().signal,
      retryDelayMs: () => 0,
      ...h,
    });

    expect(outcome.status).toBe("completed");
    expect(calls).toBe(3);
    expect(h.events.filter((e) => e.type === "model_requested")).toHaveLength(3); // 每次尝试都有迹可查
    expect(h.events.filter((e) => e.type === "decision_made")).toHaveLength(1); // 但只有一次决策
  });

  it("partial respond 保留 missingMaterial，供 run_completed 区分 complete/partial", async () => {
    const h = harness();
    const outcome: LoopOutcome = await driveLoop(initialState(task), {
      core: modelDrivenCore(scriptedModel([
        { kind: "respond", content: "reports only", partial: { missingMaterial: ["tax_invoice"] } },
      ])),
      tools: fakeTools({}),
      budget,
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.partial).toEqual({ missingMaterial: ["tax_invoice"] });
    }
  });

  it("同一工具同参数连续失败 3 次 → no_progress（空转止损）", async () => {
    const h = harness();
    const outcome = await driveLoop(initialState(task), {
      core: alwaysTool("broken"),
      tools: fakeTools({ broken: () => { throw new Error("boom"); } }),
      budget: { ...budget, maxIterations: 10 },
      signal: new AbortController().signal,
      ...h,
    });

    expect(outcome).toMatchObject({ status: "failed", error: { code: "no_progress" } });
    expect(h.events.filter((e) => e.type === "tool_completed")).toHaveLength(3);
  });
});
