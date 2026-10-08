import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  fakeTools,
  modelDrivenCore,
  replayState,
  scriptedModel,
  type AgentEvent,
} from "@vibe/core";
import { AgentRuntime, JsonlRunLog, MemorySessionStore, type RunHandle } from "@vibe/runtime";
import { createPiEngine } from "../src/index";
import { startFakeAnthropicServer } from "./fake-anthropic";

/**
 * 集成测试：真实 pi SDK（createAgentSession + @anthropic-ai/sdk 流式客户端）
 * × 本地假 Anthropic Messages 服务器（确定性"大脑"）× 本适配器事件归一化
 * → AgentRuntime 全链路。不需要任何 API key。
 *
 * 金标语义一致性：事件类型序列必须与 Core 引擎 fake 通道
 * （packages/runtime/test/golden.test.ts）完全一致。
 */

const task = { id: "task-noon-1", input: { store: "noon-sg", reportType: "fbn_inventory", month: "2026-09" } };

/** 与 fake 金标一致的事件类型序列（run_started 之后 Runtime 终态化之前的形态） */
const expectedEventTypes = [
  "run_started",
  "model_requested",
  "decision_made",
  "tool_started",
  "tool_completed",
  "observation_added",
  "model_requested",
  "decision_made",
  "tool_started",
  "tool_completed",
  "observation_added",
  "model_requested",
  "decision_made",
  "usage_reported",
  "run_completed",
];

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function collect(handle: RunHandle): Promise<{ events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  await handle.done;
  return { events };
}

describe("Pi 引擎（真实 SDK × 假 LLM）", () => {
  it("noon 报表任务：事件词表与 fake 金标一致，真实 usage 到账，回放重建状态", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-pi-"));
    cleanup.push(dir);

    const fake = await startFakeAnthropicServer([
      { toolUse: { id: "toolu_1", name: "list_reports", input: { store: "noon-sg", reportType: "fbn_inventory" } }, inputTokens: 120, outputTokens: 18 },
      { toolUse: { id: "toolu_2", name: "download_report", input: { reportId: "R-1001", targetDir: "store-data/noon-sg/reports/2026-09" } }, inputTokens: 340, outputTokens: 22 },
      { text: "FBN 库存报表已导出：store-data/noon-sg/reports/2026-09/R-1001.csv（42 行）。", inputTokens: 510, outputTokens: 40 },
    ]);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("vibe-test", {
      name: "Vibe test provider",
      baseUrl: fake.url,
      api: "anthropic-messages",
      apiKey: "test-key",
      models: [
        {
          id: "scripted-1",
          name: "scripted-1",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_000,
        },
      ],
    });
    await modelRuntime.setRuntimeApiKey("vibe-test", "test-key");
    const model = modelRuntime.getModel("vibe-test", "scripted-1");
    expect(model).toBeDefined();

    const toolPort = fakeTools({
      list_reports: (args) => {
        expect(args).toEqual({ store: "noon-sg", reportType: "fbn_inventory" });
        return { reports: [{ id: "R-1001", period: "2026-09", status: "ready" }] };
      },
      download_report: (args) => {
        expect(args).toEqual({ reportId: "R-1001", targetDir: "store-data/noon-sg/reports/2026-09" });
        return { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 };
      },
    });

    const runtime = new AgentRuntime({
      // engine 接管迭代；core 仅为满足 RuntimeDeps 必填（不会被调用）
      core: modelDrivenCore(scriptedModel([])),
      tools: toolPort,
      runLog: new JsonlRunLog(join(dir, "runs")),
      sessions: new MemorySessionStore(),
      budget: { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 30_000 },
      engine: createPiEngine({
        modelRuntime,
        model: model!,
        systemPrompt: "你是跨境卖家运营助手。需要数据时调用工具；拿到足够信息后用简短文字答复。",
        toolPort,
        toolSpecs: [
          { name: "list_reports", description: "列出指定店铺与报表类型的可下载报表。", parameters: Type.Object({ store: Type.String(), reportType: Type.String() }) },
          { name: "download_report", description: "下载指定报表到目标目录。", parameters: Type.Object({ reportId: Type.String(), targetDir: Type.String() }) },
        ],
        cwd: dir,
        agentDir: dir,
      }),
    });

    const { events } = await collect(runtime.run(task));

    expect(events.map((e) => e.type)).toEqual(expectedEventTypes);

    const runCompleted = events.at(-1);
    expect(runCompleted).toMatchObject({ type: "run_completed", status: "complete" });
    expect((runCompleted as { result?: unknown }).result).toContain("R-1001.csv");

    // 工具载荷经真实 SDK 往返后保真
    const downloadObservation = events.find((e) => e.type === "observation_added" && e.name === "download_report");
    expect((downloadObservation as { observation?: { rows?: number } })?.observation?.rows).toBe(42);

    // 真实 usage 通道：token 数来自假 LLM 的 SSE usage 字段
    const usage = events.find((e) => e.type === "usage_reported");
    expect(usage).toMatchObject({
      type: "usage_reported",
      usage: { toolCalls: 2, model: "scripted-1", inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    });
    expect((usage as { usage: { inputTokens: number } }).usage.inputTokens).toBeGreaterThan(0);

    // 事件回放重建状态（与 fake 通道同一不变量）
    const state = replayState(events);
    expect(state?.iteration).toBe(2);
    expect(state?.observations.map((o) => (o as { name: string }).name)).toEqual(["list_reports", "download_report"]);

    // 模型确实发生了 3 轮真实 LLM 请求
    expect(fake.requests.length).toBe(3);

    await fake.close();
  }, 60_000);
});
