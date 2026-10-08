import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fakeTools, modelDrivenCore, scriptedModel, type AgentEvent, type GatePolicy, type Run } from "@vibe/core";
import { AgentRuntime, JsonlRunLog, MemorySessionStore, type RunHandle } from "@vibe/runtime";
import { createPiEngine } from "../src/index";
import { startFakeAnthropicServer } from "./fake-anthropic";

/**
 * Pi 引擎确认闸门端到端：真实 SDK × 假 Anthropic SSE 服务器。
 *
 * 场景：调价（update_price）必须人工批准。
 *   第 1 段 run：模型请求调价 → 引擎中止 episode、挂起等批复（绝不执行）；
 *   resume 批准  → 引擎在 SDK 之外执行工具，把结果以 recap 交回模型继续；
 *   resume 拒绝  → 把拒绝说明交回模型，工具永不执行。
 */

const task = { id: "task-price-1", input: { sku: "A1", price: 99 } };

const priceGate: GatePolicy = {
  requiresApproval: (intent) => intent.name === "update_price",
  question: (intent) => `授权执行 ${intent.name}？参数：${JSON.stringify(intent.arguments)}`,
};

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function collect(handle: RunHandle): Promise<{ events: AgentEvent[]; run: Run }> {
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const run = await handle.done;
  return { events, run };
}

interface Harness {
  runtime: AgentRuntime;
  log: JsonlRunLog;
  close(): Promise<void>;
}

async function makeHarness(finalText: string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-pi-gate-"));
  cleanup.push(dir);
  const fake = await startFakeAnthropicServer([
    { toolUse: { id: "toolu_1", name: "update_price", input: { sku: "A1", price: 99 } }, inputTokens: 100, outputTokens: 15 },
    { text: finalText, inputTokens: 260, outputTokens: 30 },
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

  const runtime = new AgentRuntime({
    // engine 接管迭代；core 仅为满足 RuntimeDeps 必填（不会被调用）
    core: modelDrivenCore(scriptedModel([])),
    tools: fakeTools({ update_price: () => ({ ok: true, newPrice: 99 }) }),
    runLog: new JsonlRunLog(join(dir, "runs")),
    sessions: new MemorySessionStore(),
    budget: { maxIterations: 8, maxToolCalls: 4, maxRetries: 0, timeoutMs: 30_000 },
    gates: priceGate,
    engine: createPiEngine({
      modelRuntime,
      model: model!,
      systemPrompt: "你是电商运营助手。调价前必须获得人工批准。",
      toolPort: fakeTools({ update_price: () => ({ ok: true, newPrice: 99 }) }),
      toolSpecs: [
        { name: "update_price", description: "修改商品价格。", parameters: Type.Object({ sku: Type.String(), price: Type.Number() }) },
      ],
      gates: priceGate,
      cwd: dir,
      agentDir: dir,
    }),
  });
  return {
    runtime,
    log: new JsonlRunLog(join(dir, "runs")),
    close: () => fake.close(),
  };
}

describe("Pi 引擎确认闸门（真实 SDK × 假 LLM）", () => {
  it("批准路径：episode 内拦截挂起 → resume 后 SDK 之外执行 → recap 交回模型收尾", async () => {
    const harness = await makeHarness("调价已完成：A1 → 99。");
    try {
      const first = await collect(harness.runtime.run(task));
      expect(first.events.map((e) => e.type)).toEqual([
        "run_started",
        "model_requested",
        "decision_made",
        "human_input_requested",
        "usage_reported",
      ]);
      // 绝不执行
      expect(first.events.some((e) => e.type === "tool_started")).toBe(false);

      const runId = (first.events[0] as { runId: string }).runId;
      const second = await collect(harness.runtime.resume(runId, { kind: "tool_approval", approved: true }));
      expect(second.events[0]?.type).toBe("human_input_received");
      expect(second.events[1]?.type).toBe("run_resumed");
      // 批准消费：工具在 SDK 之外执行一次，事件与 Core 引擎同构
      expect(second.events.filter((e) => e.type === "tool_completed")).toHaveLength(1);
      expect(second.events.find((e) => e.type === "observation_added")).toMatchObject({
        observation: { ok: true, newPrice: 99 },
      });
      // 模型收到 recap 后收尾
      const completed = second.events.at(-1);
      expect(completed).toMatchObject({ type: "run_completed", status: "complete" });
      expect((completed as { result?: unknown }).result).toContain("调价已完成");

      // 全量日志：两次决策（挂起段的 call_tool + 恢复段的 respond）、工具只执行一次
      const all = await harness.log.listEvents(runId);
      expect(all.filter((e) => e.type === "decision_made")).toHaveLength(2);
      expect(all.filter((e) => e.type === "tool_started")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("拒绝路径：工具永不执行，拒绝说明交回模型，落 approval_denied 观察", async () => {
    const harness = await makeHarness("用户已拒绝调价，商品保持原价。");
    try {
      const first = await collect(harness.runtime.run(task));
      expect(first.run.status).toBe("awaiting_human");

      const runId = (first.events[0] as { runId: string }).runId;
      const second = await collect(harness.runtime.resume(runId, { kind: "tool_approval", approved: false }));
      expect(second.run.status).toBe("completed");
      // 全程没有工具执行
      expect(second.events.some((e) => e.type === "tool_started")).toBe(false);
      // 拒绝观察（与 Core 引擎同构）
      expect(second.events.find((e) => e.type === "observation_added")).toMatchObject({
        observation: { error: { code: "approval_denied" } },
      });
      const completed = second.events.at(-1);
      expect(completed).toMatchObject({ type: "run_completed", status: "complete" });
      expect((completed as { result?: unknown }).result).toContain("拒绝");
    } finally {
      await harness.close();
    }
  }, 60_000);
});
