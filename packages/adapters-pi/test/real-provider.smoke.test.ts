import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fakeTools, modelDrivenCore, scriptedModel, type AgentEvent, type GatePolicy, type Run } from "@vibe/core";
import { AgentRuntime, JsonlRunLog, MemorySessionStore, type RunHandle } from "@vibe/runtime";
import { createPiEngine } from "../src/index";

/**
 * 真实 provider 冒烟测试（StepFun step-3.7-flash，Anthropic 兼容端点）。
 *
 * 安全规则：API key 只从环境变量读，绝不写入代码/日志/事件；
 * 未设置 VIBE_SMOKE_API_KEY 时整组用例自动跳过（npm test 保持绿色）。
 *
 * 运行：
 *   VIBE_SMOKE_API_KEY=... npx vitest run real-provider
 * 可选：VIBE_SMOKE_BASE_URL（默认 https://api.stepfun.com/step_plan）
 *      VIBE_SMOKE_MODEL（默认 step-3.7-flash）
 */

const apiKey = process.env.VIBE_SMOKE_API_KEY;
const baseUrl = process.env.VIBE_SMOKE_BASE_URL ?? "https://api.stepfun.com/step_plan";
const modelId = process.env.VIBE_SMOKE_MODEL ?? "step-3.7-flash";
const providerId = "stepfun";

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

describe.skipIf(!apiKey)("真实 provider 冒烟（StepFun × Pi 引擎）", () => {
  it("noon 报表任务：真实模型调用真实工具链并给出答复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-smoke-"));
    cleanup.push(dir);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(providerId, {
      name: "StepFun (Anthropic-compatible)",
      baseUrl, // 官方 SDK 在 baseURL 后拼 /v1/messages，故不带 /v1
      api: "anthropic-messages",
      models: [
        {
          id: modelId,
          name: modelId,
          api: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_000,
        },
      ],
    });
    // key 只走运行时注入，不落盘
    await modelRuntime.setRuntimeApiKey(providerId, apiKey!);

    const toolPort = fakeTools({
      list_reports: (args) => {
        console.log("  [tool] list_reports", JSON.stringify(args));
        return { reports: [{ id: "R-1001", period: "2026-09", status: "ready" }] };
      },
      download_report: (args) => {
        console.log("  [tool] download_report", JSON.stringify(args));
        return { file: "store-data/noon-sg/reports/2026-09/R-1001.csv", rows: 42 };
      },
    });

    const runtime = new AgentRuntime({
      // engine 接管迭代；core 仅为满足 RuntimeDeps 必填（不会被调用）
      core: modelDrivenCore(scriptedModel([])),
      tools: toolPort,
      runLog: new JsonlRunLog(join(dir, "runs")),
      sessions: new MemorySessionStore(),
      budget: { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 120_000 },
      engine: createPiEngine({
        modelRuntime,
        model: modelRuntime.getModel(providerId, modelId)!,
        systemPrompt:
          "你是跨境卖家运营助手。执行任务时必须使用提供的工具获取数据，禁止凭记忆编造数据。" +
          "第 1 步必须调用工具 list_reports；第 2 步必须调用工具 download_report；之后用一句中文给出答复。",
        toolPort,
        toolSpecs: [
          { name: "list_reports", description: "列出指定店铺与报表类型的可下载报表。", parameters: Type.Object({ store: Type.String(), reportType: Type.String() }) },
          { name: "download_report", description: "下载指定报表到目标目录。", parameters: Type.Object({ reportId: Type.String(), targetDir: Type.String() }) },
        ],
        cwd: dir,
        agentDir: dir,
      }),
    });

    const { events } = await collect(runtime.run({
      id: "task-noon-smoke",
      input: { store: "noon-sg", reportType: "fbn_inventory", month: "2026-09" },
    }));

    // —— 冒烟断言：流程语义（宽容模型方差，但工具链必须真实发生）——
    const types = events.map((e) => e.type);
    console.log("  [events]", types.join(" → "));

    expect(events[0]).toMatchObject({ type: "run_started" });
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_completed");
    expect(types).toContain("observation_added");
    expect(types).toContain("usage_reported");

    const runCompleted = events.at(-1);
    if (runCompleted?.type === "run_failed") {
      console.log("  [error]", JSON.stringify(runCompleted.error));
    }
    expect(runCompleted).toMatchObject({ type: "run_completed", status: "complete" });

    const usage = events.find((e) => e.type === "usage_reported");
    console.log("  [usage]", JSON.stringify((usage as { usage?: unknown })?.usage));
    expect((usage as { usage: { toolCalls: number } }).usage.toolCalls).toBeGreaterThanOrEqual(2);

    // 终局答复与工具观察一致（模型引用了工具返回的数据）
    const result = (runCompleted as { result?: unknown }).result;
    expect(String(result)).toContain("R-1001");

    // 落盘与回放
    const log = new JsonlRunLog(join(dir, "runs"));
    const stored = await log.listEvents((events[0] as { runId: string }).runId);
    expect(stored).toEqual(events);

    console.log("  [final]", String(result));
  }, 180_000);

  it("真实模型 × 确认闸门：调价请求被拦截挂起，批准后执行并收尾", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-smoke-gate-"));
    cleanup.push(dir);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(providerId, {
      name: "StepFun (Anthropic-compatible)",
      baseUrl,
      api: "anthropic-messages",
      models: [
        {
          id: modelId,
          name: modelId,
          api: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_000,
        },
      ],
    });
    await modelRuntime.setRuntimeApiKey(providerId, apiKey!);
    const model = modelRuntime.getModel(providerId, modelId)!;

    const priceGate: GatePolicy = {
      requiresApproval: (intent) => intent.name === "update_price",
      question: (intent) => `授权执行 ${intent.name}？参数：${JSON.stringify(intent.arguments)}`,
    };

    const makeRuntime = () =>
      new AgentRuntime({
        core: modelDrivenCore(scriptedModel([])), // engine 接管；不会被调用
        tools: fakeTools({ update_price: () => ({ ok: true, newPrice: 99 }) }),
        runLog: new JsonlRunLog(join(dir, "runs")),
        sessions: new MemorySessionStore(),
        budget: { maxIterations: 8, maxToolCalls: 4, maxRetries: 0, timeoutMs: 120_000 },
        gates: priceGate,
        engine: createPiEngine({
          modelRuntime,
          model,
          systemPrompt: "你是电商运营助手。修改价格必须调用 update_price 工具；完成或受阻时用一句中文汇报。",
          toolPort: fakeTools({ update_price: () => ({ ok: true, newPrice: 99 }) }),
          toolSpecs: [
            { name: "update_price", description: "修改指定 SKU 的价格。", parameters: Type.Object({ sku: Type.String(), price: Type.Number() }) },
          ],
          gates: priceGate,
          cwd: dir,
          agentDir: dir,
        }),
      });

    const collect = async (handle: RunHandle): Promise<{ events: AgentEvent[]; run: Run }> => {
      const events: AgentEvent[] = [];
      for await (const event of handle.events) events.push(event);
      const run = await handle.done;
      return { events, run };
    };

    const runtime = makeRuntime();
    const first = await collect(runtime.run({ id: "task-price-gate", input: { sku: "A1", price: 99 } }));
    expect(first.run.status).toBe("awaiting_human");
    expect(first.events.some((e) => e.type === "tool_started")).toBe(false); // 真实模型请求调价也被拦下
    const asked = first.events.find((e) => e.type === "human_input_requested");
    expect(asked).toMatchObject({ type: "human_input_requested" });
    console.log("  [gate]", (asked as { question?: string }).question);

    const runId = (first.events[0] as { runId: string }).runId;
    const second = await collect(runtime.resume(runId, { kind: "tool_approval", approved: true }));
    expect(second.run.status).toBe("completed");
    expect(second.events.filter((e) => e.type === "tool_completed")).toHaveLength(1); // 批准后恰好执行一次
    const completed = second.events.at(-1);
    expect(completed).toMatchObject({ type: "run_completed", status: "complete" });
    console.log("  [final]", String((completed as { result?: unknown }).result));
  }, 300_000);
});
