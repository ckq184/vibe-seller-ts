import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  deriveRun,
  fakeTools,
  modelDrivenCore,
  replayState,
  scriptedModel,
  type AgentEvent,
} from "@vibe/core";
import { AgentRuntime, JsonlRunLog, MemorySessionStore } from "../src/index";

/**
 * 金标回放：noon FBN 报表任务（fake 通道）。
 * 确定性时钟（每 tick +10，从 1010 起）+ 确定性 ID + 零延迟重试，
 * 事件流必须与钉死的 transcript 逐字段一致；
 * 以后接真实 pi SDK 适配器时，同一 transcript 用于 fake/real 语义一致性验证。
 */
const task = { id: "task-noon-1", input: { store: "noon-sg", reportType: "fbn_inventory", month: "2026-09" } };

const pinned: AgentEvent[] = [
  { type: "run_started", runId: "run-noon-1", sequence: 0, timestamp: 1010, sessionId: "sess-noon-1", task },
  { type: "model_requested", runId: "run-noon-1", sequence: 1, timestamp: 1030 },
  { type: "decision_made", runId: "run-noon-1", sequence: 2, timestamp: 1040, decision: { kind: "call_tool", intent: { name: "list_reports", arguments: { store: "noon-sg", reportType: "fbn_inventory" } } } },
  { type: "tool_started", runId: "run-noon-1", sequence: 3, timestamp: 1050, toolCallId: "tc-1", toolName: "list_reports" },
  { type: "tool_completed", runId: "run-noon-1", sequence: 4, timestamp: 1060, toolCallId: "tc-1", toolName: "list_reports", status: "success", result: { reports: [{ id: "R-1001", period: "2026-09", status: "ready" }] }, durationMs: 10 },
  { type: "observation_added", runId: "run-noon-1", sequence: 5, timestamp: 1070, name: "list_reports", observation: { reports: [{ id: "R-1001", period: "2026-09", status: "ready" }] } },
  { type: "model_requested", runId: "run-noon-1", sequence: 6, timestamp: 1080 },
  { type: "decision_made", runId: "run-noon-1", sequence: 7, timestamp: 1090, decision: { kind: "call_tool", intent: { name: "download_report", arguments: { reportId: "R-1001", targetDir: "store-data/noon-sg/reports/2026-09" } } } },
  { type: "tool_started", runId: "run-noon-1", sequence: 8, timestamp: 1100, toolCallId: "tc-2", toolName: "download_report" },
  { type: "tool_completed", runId: "run-noon-1", sequence: 9, timestamp: 1110, toolCallId: "tc-2", toolName: "download_report", status: "success", result: { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 }, durationMs: 10 },
  { type: "observation_added", runId: "run-noon-1", sequence: 10, timestamp: 1120, name: "download_report", observation: { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 } },
  { type: "model_requested", runId: "run-noon-1", sequence: 11, timestamp: 1130 },
  { type: "decision_made", runId: "run-noon-1", sequence: 12, timestamp: 1140, decision: { kind: "respond", content: { summary: "FBN 库存报表已导出", file: "store-data/noon-sg/reports/2026-09/R-1001.csv" } } },
  { type: "usage_reported", runId: "run-noon-1", sequence: 13, timestamp: 1160, usage: { toolCalls: 2, durationMs: 130 } },
  { type: "run_completed", runId: "run-noon-1", sequence: 14, timestamp: 1170, status: "complete", result: { summary: "FBN 库存报表已导出", file: "store-data/noon-sg/reports/2026-09/R-1001.csv" } },
];

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("golden transcript（noon 报表演示任务）", () => {
  it("事件流与钉死 transcript 逐字段一致；回放重建状态与终态", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-golden-"));
    cleanup.push(dir);
    let clock = 1000;
    let tc = 0;

    const runtime = new AgentRuntime({
      core: modelDrivenCore(scriptedModel([
        { kind: "call_tool", intent: { name: "list_reports", arguments: { store: "noon-sg", reportType: "fbn_inventory" } } },
        { kind: "call_tool", intent: { name: "download_report", arguments: { reportId: "R-1001", targetDir: "store-data/noon-sg/reports/2026-09" } } },
        { kind: "respond", content: { summary: "FBN 库存报表已导出", file: "store-data/noon-sg/reports/2026-09/R-1001.csv" } },
      ])),
      tools: fakeTools({
        list_reports: (args) => {
          expect(args).toEqual({ store: "noon-sg", reportType: "fbn_inventory" });
          return { reports: [{ id: "R-1001", period: "2026-09", status: "ready" }] };
        },
        download_report: (args) => {
          expect(args).toEqual({ reportId: "R-1001", targetDir: "store-data/noon-sg/reports/2026-09" });
          return { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 };
        },
      }),
      runLog: new JsonlRunLog(join(dir, "runs")),
      sessions: new MemorySessionStore(() => "sess-noon-1"),
      budget: { maxIterations: 8, maxToolCalls: 8, maxRetries: 2, timeoutMs: 5000 },
      now: () => (clock += 10),
      nextToolCallId: () => `tc-${++tc}`,
      newRunId: () => "run-noon-1",
      retryDelayMs: () => 0,
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run(task).events) events.push(event);

    expect(events).toEqual(pinned);

    // 日志 = 流：落盘内容逐字段一致
    expect(await new JsonlRunLog(join(dir, "runs")).listEvents("run-noon-1")).toEqual(pinned);

    // 回放重建 AgentState：2 轮工具迭代、3 决策 + 2 观察 = 5 条消息
    const state = replayState(pinned);
    expect(state?.iteration).toBe(2);
    expect(state?.observations.map((o) => (o as { name: string }).name)).toEqual(["list_reports", "download_report"]);
    expect(state?.messages).toHaveLength(5);

    // 终态可从事件推导
    expect(deriveRun(pinned)?.status).toBe("completed");
  });
});
