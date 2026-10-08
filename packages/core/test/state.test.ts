import { describe, expect, it } from "vitest";
import {
  applyDecision,
  applyHumanInput,
  applyObservation,
  deriveRun,
  initialState,
  replayState,
  type AgentEvent,
} from "../src/index";

const task = { id: "t1", input: { store: "noon-sg" } };

describe("state transitions", () => {
  it("applyObservation 追加消息与观察并推进迭代，且不改原 state", () => {
    const before = initialState(task);
    const after = applyObservation(before, { name: "list_reports", data: { reports: [] } });
    expect(after.iteration).toBe(1);
    expect(after.observations).toHaveLength(1);
    expect(after.messages).toHaveLength(1);
    expect(before.iteration).toBe(0);
    expect(before.observations).toHaveLength(0);
  });

  it("applyDecision / applyHumanInput 追加消息", () => {
    let state = initialState(task);
    state = applyDecision(state, { kind: "ask_human", question: "确认？" });
    state = applyHumanInput(state, { approved: true });
    expect(state.messages).toEqual([
      { role: "decision", decision: { kind: "ask_human", question: "确认？" } },
      { role: "human", input: { approved: true } },
    ]);
  });
});

describe("replayState（事件回放重建 AgentState）", () => {
  const events: AgentEvent[] = [
    { type: "run_started", runId: "r1", sequence: 0, timestamp: 1, sessionId: "s1", task },
    { type: "model_requested", runId: "r1", sequence: 1, timestamp: 2 },
    { type: "decision_made", runId: "r1", sequence: 2, timestamp: 3, decision: { kind: "call_tool", intent: { name: "list_reports", arguments: { store: "noon-sg" } } } },
    { type: "tool_started", runId: "r1", sequence: 3, timestamp: 4, toolCallId: "tc-1", toolName: "list_reports" },
    { type: "tool_completed", runId: "r1", sequence: 4, timestamp: 5, toolCallId: "tc-1", toolName: "list_reports", status: "success", result: { reports: ["R-1"] }, durationMs: 1 },
    { type: "observation_added", runId: "r1", sequence: 5, timestamp: 6, name: "list_reports", observation: { reports: ["R-1"] } },
    { type: "decision_made", runId: "r1", sequence: 6, timestamp: 7, decision: { kind: "respond", content: "done" } },
    { type: "usage_reported", runId: "r1", sequence: 7, timestamp: 8, usage: { toolCalls: 1, durationMs: 6 } },
    { type: "run_completed", runId: "r1", sequence: 8, timestamp: 9, status: "complete", result: "done" },
  ];

  it("回放重建状态且幂等（同一事件列表重放两次全等）", () => {
    const first = replayState(events);
    const second = replayState(events);
    expect(first).toEqual(second);
    expect(first?.task).toEqual(task);
    expect(first?.iteration).toBe(1);
    expect(first?.observations).toEqual([{ name: "list_reports", data: { reports: ["R-1"] } }]);
    expect(first?.messages).toHaveLength(3); // decision + observation + decision
  });

  it("空事件列表与缺失 run_started 都不会凭空造状态", () => {
    expect(replayState([])).toBeUndefined();
    expect(replayState([{ type: "model_requested", runId: "r1", sequence: 0, timestamp: 1 }])).toBeUndefined();
  });
});

describe("deriveRun（从事件日志推导 Run）", () => {
  const start: AgentEvent = { type: "run_started", runId: "r1", sequence: 0, timestamp: 10, sessionId: "s1", task };

  it("终态事件决定 status，时间取首尾事件", () => {
    const run = deriveRun([
      start,
      { type: "usage_reported", runId: "r1", sequence: 1, timestamp: 20, usage: { toolCalls: 0, durationMs: 10 } },
      { type: "run_completed", runId: "r1", sequence: 2, timestamp: 30, status: "complete", result: "x" },
    ]);
    expect(run).toMatchObject({ runId: "r1", sessionId: "s1", status: "completed", startedAt: 10, updatedAt: 30 });
  });

  it("ask_human 之后无终态 → awaiting_human；run_cancelled → cancelled", () => {
    const awaiting = deriveRun([
      start,
      { type: "human_input_requested", runId: "r1", sequence: 1, timestamp: 11, question: "确认？" },
    ]);
    expect(awaiting?.status).toBe("awaiting_human");

    const cancelled = deriveRun([
      start,
      { type: "run_cancelled", runId: "r1", sequence: 1, timestamp: 12 },
    ]);
    expect(cancelled?.status).toBe("cancelled");
  });

  it("无 run_started → undefined", () => {
    expect(deriveRun([])).toBeUndefined();
  });
});
