import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fakeTools,
  modelDrivenCore,
  scriptedModel,
  type AgentCore,
  type AgentEvent,
  type GatePolicy,
  type Run,
} from "@vibe/core";
import { AgentRuntime, JsonlRunLog, MemorySessionStore, type RunAfterContext, type RunHandle, type RunReviewContext, type RuntimeDeps } from "../src/index";

const task = { id: "t1", input: { store: "noon-sg" } };
const budget = { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 2000 };

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

function makeRuntime(dir: string, extra: Partial<RuntimeDeps>, core?: AgentCore): AgentRuntime {
  return new AgentRuntime({
    core: core ?? modelDrivenCore(scriptedModel([{ kind: "respond", content: "done" }])),
    tools: fakeTools({}),
    runLog: new JsonlRunLog(join(dir, "runs")),
    sessions: new MemorySessionStore(),
    budget,
    ...extra,
  });
}

describe("DoD 评审（run review）", () => {
  it("评审 incomplete → run_completed(partial) + missingMaterial，绝不冒充完成", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-rev-"));
    cleanup.push(dir);
    const seen: RunReviewContext[] = [];
    const runtime = makeRuntime(dir, {
      review: (ctx) => {
        seen.push(ctx);
        return {
          verdict: "incomplete",
          missingMaterial: ["R-1001.csv 落盘证据"],
          reason: "答复声称已导出，但观察里没有文件证据",
        };
      },
    });

    const { events, run } = await collect(runtime.run(task));
    expect(run.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.task).toEqual(task);
    expect(seen[0]?.events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({
      type: "run_completed",
      status: "partial",
      missingMaterial: ["R-1001.csv 落盘证据"],
    });
  });

  it("评审 pass → complete；引擎 partial 与评审缺失正确合流", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-rev-"));
    cleanup.push(dir);
    const runtime = makeRuntime(dir, {
      review: () => ({ verdict: "pass" }),
      core: modelDrivenCore(scriptedModel([
        { kind: "respond", content: "只完成一半", partial: { missingMaterial: ["tax_invoice"] } },
      ])),
    });
    const { events } = await collect(runtime.run(task));
    expect(events.at(-1)).toMatchObject({ type: "run_completed", status: "partial", missingMaterial: ["tax_invoice"] });
  });

  it("评审 incomplete 的缺失与引擎 partial 缺失合并去重", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-rev-"));
    cleanup.push(dir);
    const runtime = makeRuntime(dir, {
      review: () => ({ verdict: "incomplete", missingMaterial: ["tax_invoice", "bank_statement"] }),
      core: modelDrivenCore(scriptedModel([
        { kind: "respond", content: "只完成一半", partial: { missingMaterial: ["tax_invoice"] } },
      ])),
    });
    const { events } = await collect(runtime.run(task));
    expect(events.at(-1)).toMatchObject({
      type: "run_completed",
      status: "partial",
      missingMaterial: ["tax_invoice", "bank_statement"],
    });
  });
});

describe("任务后钩子（afterRun / 反思接缝）", () => {
  it("终局后调用一次；awaiting_human 不触发", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-after-"));
    cleanup.push(dir);
    const calls: RunAfterContext[] = [];
    const core: AgentCore = {
      async step(state) {
        if (state.messages.length === 0) return { kind: "ask_human", question: "确认？" };
        return { kind: "respond", content: "ok" };
      },
    };
    const runtime = makeRuntime(dir, { afterRun: (ctx) => void calls.push(ctx) }, core);

    const first = await collect(runtime.run(task));
    expect(first.run.status).toBe("awaiting_human");
    expect(calls).toHaveLength(0); // 挂起不是终局

    const second = await collect(runtime.resume(first.run.runId, { approved: true }));
    expect(second.run.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.run.runId).toBe(first.run.runId);
    expect(calls[0]?.run.status).toBe("completed");
    expect(calls[0]?.state.messages.some((m) => (m as { role: string }).role === "human")).toBe(true);
  });
});

describe("确认闸门（Runtime 端到端：挂起 → resume 批复）", () => {
  const priceGate: GatePolicy = {
    requiresApproval: (intent) => intent.name === "update_price",
    question: (intent) => `授权执行 ${intent.name}？参数：${JSON.stringify(intent.arguments)}`,
  };

  function gateRuntime(dir: string): AgentRuntime {
    return new AgentRuntime({
      core: {
        async step(state) {
          if (state.messages.length === 0) {
            return { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A1", price: 99 } } };
          }
          return { kind: "respond", content: "调价流程结束" };
        },
      },
      tools: fakeTools({ update_price: () => ({ ok: true, newPrice: 99 }) }),
      runLog: new JsonlRunLog(join(dir, "runs")),
      sessions: new MemorySessionStore(),
      budget,
      gates: priceGate,
    });
  }

  it("批准：resume 注入批复后工具被放行执行一次", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-gate-"));
    cleanup.push(dir);
    const runtime = gateRuntime(dir);

    const first = await collect(runtime.run(task));
    expect(first.run.status).toBe("awaiting_human");
    expect(first.events.some((e) => e.type === "tool_started")).toBe(false);
    const asked = first.events.find((e) => e.type === "human_input_requested");
    expect(asked).toMatchObject({ type: "human_input_requested", question: expect.stringContaining("update_price") });

    const second = await collect(runtime.resume(first.run.runId, { kind: "tool_approval", approved: true }));
    expect(second.run.status).toBe("completed");
    expect(second.events.filter((e) => e.type === "tool_completed")).toHaveLength(1);
    // resume 段只新增 respond 决策（call_tool 决策在挂起前已记录，批准不重复记）
    expect(second.events.filter((e) => e.type === "decision_made")).toHaveLength(1);
    expect(second.events[0]?.type).toBe("human_input_received");
    expect(second.events[1]?.type).toBe("run_resumed");

    // 事件日志（唯一事实源）里：批复消息在、两次决策齐全
    const log = new JsonlRunLog(join(dir, "runs"));
    const all = await log.listEvents(first.run.runId);
    expect(all.some((e) => e.type === "human_input_received")).toBe(true);
    expect(all.filter((e) => e.type === "decision_made")).toHaveLength(2);
  });

  it("拒绝：resume 注入拒绝后工具永不执行，落 approval_denied 观察", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-gate-"));
    cleanup.push(dir);
    const runtime = gateRuntime(dir);

    const first = await collect(runtime.run(task));
    const second = await collect(runtime.resume(first.run.runId, { kind: "tool_approval", approved: false }));

    expect(second.run.status).toBe("completed");
    expect(second.events.some((e) => e.type === "tool_started")).toBe(false);
    const denial = second.events.find((e) => e.type === "observation_added");
    expect(denial).toMatchObject({
      type: "observation_added",
      observation: { error: { code: "approval_denied" } },
    });
  });
});
