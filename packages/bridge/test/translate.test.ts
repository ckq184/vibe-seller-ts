import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@vibe/core";
import { createTranslator } from "../src/translate";

let seq = 0;
function ev(partial: Record<string, unknown>): AgentEvent {
  seq += 1;
  return { runId: "r1", sequence: seq, ...partial } as AgentEvent;
}

describe("translate：AgentEvent → 桥 SSE 帧", () => {
  it("call_tool 决策 → tool_use 消息（JSON 串 content）", () => {
    const t = createTranslator("t1");
    const frames = t.translate(
      ev({ type: "decision_made", decision: { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A-1", price: 9.9 } } }, timestamp: 1 }),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: "message", data: { task_id: "t1", role: "tool_use" } });
    expect(JSON.parse((frames[0]!.data.content as string))).toEqual({ tool: "update_price", input: { sku: "A-1", price: 9.9 } });
  });

  it("observation → agent_event 诊断帧（role=agent_event，可解析）", () => {
    const t = createTranslator("t1");
    const frames = t.translate(ev({ type: "observation_added", name: "list_reports", observation: { status: "success" }, timestamp: 2 }));
    expect(frames[0]!.event).toBe("message");
    const data = frames[0]!.data as { role: string; content: string };
    expect(data.role).toBe("agent_event");
    expect(JSON.parse(data.content)).toEqual({ event: "observation", tool: "list_reports", ok: "success" });
  });

  it("门挂起 → questions 帧，request_id 顺序递增", () => {
    const t = createTranslator("t1");
    const f1 = t.translate(ev({ type: "human_input_requested", question: "需要确认", timestamp: 3 }));
    const f2 = t.translate(ev({ type: "human_input_requested", question: "再次确认", timestamp: 4 }));
    expect(f1[0]!.event).toBe("questions");
    expect(f1[0]!.data.request_id).toBe("gate-1");
    expect(f2[0]!.data.request_id).toBe("gate-2");
    expect(f1[0]!.data.questions).toEqual([{ question: "需要确认", kind: "tool_approval" }]);
  });

  it("run_completed(complete) → result 消息 + done(completed)", () => {
    const t = createTranslator("t1");
    t.translate(ev({ type: "usage_reported", usage: { toolCalls: 2, durationMs: 100, inputTokens: 10 }, timestamp: 5 }));
    const frames = t.translate(ev({ type: "run_completed", status: "complete", result: "报表已生成", timestamp: 6 }));
    expect(frames.map((f) => f.event)).toEqual(["message", "done"]);
    expect(frames[0]!.data).toMatchObject({ role: "result", content: "报表已生成" });
    const done = frames[1]!.data as Record<string, unknown>;
    expect(done).toMatchObject({ task_id: "t1", status: "completed", result_text: "报表已生成" });
    expect((done.usage as Record<string, unknown>).toolCalls).toBe(2);
  });

  it("run_completed(partial) → done(partial) + missing_materials", () => {
    const t = createTranslator("t1");
    const frames = t.translate(
      ev({ type: "run_completed", status: "partial", result: "部分完成", missingMaterial: ["check 未执行： a.py"], timestamp: 7 }),
    );
    const done = frames.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ status: "partial", missing_materials: ["check 未执行： a.py"] });
  });

  it("run_failed → system 消息 + done(failed, error_code)", () => {
    const t = createTranslator("t1");
    const frames = t.translate(ev({ type: "run_failed", error: { code: "no_progress", message: "stuck" }, timestamp: 8 }));
    expect(frames[0]!.data).toMatchObject({ role: "system" });
    expect(frames[1]!.data).toMatchObject({ status: "failed", error_code: "no_progress" });
  });

  it("run_cancelled → done(cancelled, interrupted)", () => {
    const t = createTranslator("t1");
    const frames = t.translate(ev({ type: "run_cancelled", timestamp: 9 }));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toMatchObject({ status: "cancelled", interrupted: true });
  });

  it("run_started/model_requested/tool_started 不产生 UI 帧", () => {
    const t = createTranslator("t1");
    expect(t.translate(ev({ type: "run_started", sessionId: "s1", task: { id: "t1", input: {} }, timestamp: 10 }))).toEqual([]);
    expect(t.translate(ev({ type: "model_requested", timestamp: 11 }))).toEqual([]);
    expect(t.translate(ev({ type: "tool_started", toolCallId: "tc1", toolName: "x", timestamp: 12 }))).toEqual([]);
  });
});
