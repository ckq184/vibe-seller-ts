import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlRunLog, MemorySessionStore } from "@vibe/runtime";
import type { Decision, RunBudget } from "@vibe/core";
import { startBridge, createScriptedEngine, parseScriptedConfig, TaskRegistry, type BridgeServer } from "../src/index";

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

const budget: RunBudget = { maxIterations: 24, maxToolCalls: 40, maxRetries: 2, timeoutMs: 10_000 };

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** 极简 SSE 客户端：GET events → 收帧直到 done 或连接关闭。 */
async function collectSse(port: number, runId: string): Promise<Frame[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}/events`);
  expect(res.status).toBe(200);
  const text = await res.text();
  return parseSse(text);
}

function parseSse(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (event && data) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}

async function setup(script: string, maxConcurrent = 4): Promise<{ bridge: BridgeServer; run: (body: Record<string, unknown>) => Promise<Response> }> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-bridge-"));
  cleanup.push(dir);
  const engine = createScriptedEngine(parseScriptedConfig(script));
  const bridge = await startBridge({
    base: {
      core: { step: async () => ({ kind: "respond", content: "" }) },
      tools: { execute: async () => ({ status: "error", error: { code: "invalid_tool", message: "unused" } }) },
      runLog: new JsonlRunLog(dir),
      sessions: new MemorySessionStore(),
      budget,
      engine,
    },
    registry: new TaskRegistry(),
    maxConcurrent,
    port: 0,
  });
  return {
    bridge,
    run: (body) => fetch(`http://127.0.0.1:${bridge.port}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

const HAPPY = JSON.stringify({
  tool_names: ["list_reports", "download_report"],
  decisions: [
    { kind: "call_tool", intent: { name: "list_reports", arguments: { period: "2026-09" } } },
    { kind: "call_tool", intent: { name: "download_report", arguments: { id: "R-1001" } } },
    { kind: "respond", content: "报表 R-1001 已下载，42 行。" },
  ],
});

const GATED = JSON.stringify({
  tool_names: ["update_price"],
  gated_tools: ["update_price"],
  decisions: [
    { kind: "call_tool", intent: { name: "update_price", arguments: { sku: "A-1", price: 9.9 } } },
    { kind: "respond", content: "价格已更新。" },
  ],
});

describe("桥 e2e（真 HTTP × 脚本引擎）", () => {
  it("健康检查：protocol=1", async () => {
    const { bridge } = await setup(HAPPY);
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, protocol: 1, max_concurrent: 4 });
    await bridge.close();
  });

  it("happy path：POST run → SSE（tool_use/result/done），晚订阅者从缓冲回放", async () => {
    const { bridge, run } = await setup(HAPPY);
    const post = await run({ task_id: "task-1", prompt: "拉 noon 报表" });
    expect(post.status).toBe(202);
    const { run_id } = (await post.json()) as { run_id: string };

    const frames = await collectSse(bridge.port, run_id);
    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("message");
    expect(frames[0]!.data).toMatchObject({ role: "tool_use" });
    expect(events).toContain("done");
    const done = frames.find((f) => f.event === "done")!;
    expect(done.data).toMatchObject({ task_id: "task-1", status: "completed", result_text: "报表 R-1001 已下载，42 行。" });
    expect(frames.filter((f) => (f.data as { role?: string }).role === "tool_use")).toHaveLength(2);

    // 晚订阅者：run 已结束，回放全帧后关闭
    const replay = await collectSse(bridge.port, run_id);
    expect(replay.at(-1)!.event).toBe("done");
    await bridge.close();
  });


  async function awaitAwaiting(bridgePort: number, runId: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/runs/${runId}`);
      const status = (await res.json()) as { status: string; pending_questions?: { request_id: string } };
      if (status.status === "awaiting_human" && status.pending_questions?.request_id === "gate-1") return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("run never reached awaiting_human(gate-1)");
  }

  async function awaitDoneFrame(bridgePort: number, runId: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await (await fetch(`http://127.0.0.1:${bridgePort}/v1/runs/${runId}/events`)).text();
      if (text.includes("event: done")) return; // SSE 帧行，非 JSON 键
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("done frame never appeared");
  }

  it("确认闸门：挂起发 questions → 批准 → 工具执行 → 完成", async () => {
    const { bridge, run } = await setup(GATED);
    const post = await run({ task_id: "task-gate", prompt: "把 A-1 调到 9.9" });
    const { run_id } = (await post.json()) as { run_id: string };

    // 等挂起帧出现（挂起期 SSE 不关闭，轮询 run 状态确认；固定睡眠在并行负载下会抢跑）
    await awaitAwaiting(bridge.port, run_id);

    const answers = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "gate-1", answers: { approved: true } }),
    });
    expect(answers.status).toBe(202);
    await awaitDoneFrame(bridge.port, run_id);

    const all = parseSse(await (await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/events`)).text());
    const questionIdx = all.findIndex((f) => f.event === "questions");
    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(all[questionIdx]!.data.request_id).toBe("gate-1");
    // 批准后才执行：observation（执行证据）必须出现在 questions 之后
    const obsIdx = all.findIndex(
      (f) => f.event === "message" && (f.data as { role?: string }).role === "agent_event",
    );
    expect(obsIdx).toBeGreaterThan(questionIdx);
    const obs = JSON.parse(
      (all[obsIdx]!.data as { content: string }).content,
    ) as { tool: string; ok: string };
    expect(obs).toMatchObject({ tool: "update_price", ok: "success" });
    const done = all.find((f) => f.event === "done")!;
    expect(done.data).toMatchObject({ status: "completed", result_text: "价格已更新。" });
    await bridge.close();
  });

  it("拒绝批复：不产生 tool_use，agent 直接收尾", async () => {
    const { bridge, run } = await setup(GATED);
    const post = await run({ task_id: "task-deny", prompt: "调价" });
    const { run_id } = (await post.json()) as { run_id: string };
    await awaitAwaiting(bridge.port, run_id);

    const answers = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "gate-1", answers: { approved: false } }),
    });
    expect(answers.status).toBe(202);
    await awaitDoneFrame(bridge.port, run_id);

    const all = parseSse(await (await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/events`)).text());
    // 拒绝后工具绝不执行：不存在 success 的 observation；只有 approval_denied 诊断
    const observations = all
      .filter((f) => f.event === "message" && (f.data as { role?: string }).role === "agent_event")
      .map((f) => JSON.parse((f.data as { content: string }).content) as { tool: string; ok: string });
    expect(observations.some((o) => o.tool === "update_price" && o.ok === "success")).toBe(false);
    expect(observations.some((o) => o.tool === "update_price" && o.ok === "denied")).toBe(true);
    expect(all.find((f) => f.event === "done")!.data.status).toBe("completed"); // 拒绝不是失败
    await bridge.close();
  });

  it("陈旧 request_id → 409", async () => {
    const { bridge, run } = await setup(GATED);
    const post = await run({ task_id: "task-stale", prompt: "调价" });
    const { run_id } = (await post.json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 50));
    const answers = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "gate-99", answers: { approved: true } }),
    });
    expect(answers.status).toBe(409);
    await bridge.close();
  });

  it("同 task 重复启动 → 409；stop → done(cancelled)", async () => {
    const { bridge, run } = await setup(GATED);
    const first = await run({ task_id: "task-dup", prompt: "调价" });
    const { run_id } = (await first.json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 50));
    const dup = await run({ task_id: "task-dup", prompt: "再来一次" });
    expect(dup.status).toBe(409);

    const stop = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const all = parseSse(await (await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/events`)).text());
    // 挂起中的 run 被 stop → cancelled 终局
    expect(all.find((f) => f.event === "done")!.data.status).toBe("cancelled");
    await bridge.close();
  });

  it("messages → 409 not_live（路由 fallback 契约）；未知 run → 404", async () => {
    const { bridge, run } = await setup(HAPPY);
    const happy = await run({ task_id: "task-msg", prompt: "hi" });
    const { run_id } = (await happy.json()) as { run_id: string };
    const msg = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "跟进" }),
    });
    expect(msg.status).toBe(409);

    const missing = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/run-nope`);
    expect(missing.status).toBe(404);
    const events404 = await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/run-nope/events`);
    expect(events404.status).toBe(404);
    await bridge.close();
  });

  it("plan 模式 v2：按 execute 语义接受（plan 落库在适配器 save_plan 钩子）", async () => {
    const { bridge, run } = await setup(HAPPY);
    const plan = await run({ task_id: "task-plan", prompt: "设计方案", mode: "plan_then_execute" });
    expect(plan.status).toBe(202);
    const { run_id } = (await plan.json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 80));
    const all = parseSse(await (await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/events`)).text());
    expect(all.find((f) => f.event === "done")!.data.status).toBe("completed");
    await bridge.close();
  });

  it("并发上限：饱和时第二个 task → 429", async () => {
    const { bridge, run } = await setup(GATED, 1);
    await run({ task_id: "task-cap-1", prompt: "先来" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await run({ task_id: "task-cap-2", prompt: "后来" });
    expect(second.status).toBe(429);
    await bridge.close();
  });

  it("长任务中途 stop → done(cancelled, interrupted)", async () => {
    const decisions: Decision[] = Array.from({ length: 60 }, (_, i) => ({
      kind: "call_tool",
      intent: { name: "tick", arguments: { i } },
    }));
    decisions.push({ kind: "respond", content: "never" });
    const { bridge, run } = await setup(JSON.stringify({ tool_names: ["tick"], decisions }));
    const post = await run({ task_id: "task-long", prompt: "跑长任务" });
    const { run_id } = (await post.json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20));
    await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/stop`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 100));
    const all = parseSse(await (await fetch(`http://127.0.0.1:${bridge.port}/v1/runs/${run_id}/events`)).text());
    const done = all.find((f) => f.event === "done");
    expect(done).toBeDefined();
    expect(done!.data).toMatchObject({ status: "cancelled", interrupted: true });
    await bridge.close();
  });
});
