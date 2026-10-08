import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  abortError,
  fakeTools,
  modelDrivenCore,
  replayState,
  scriptedModel,
  type AgentCore,
  AgentEvent,
  Run,
  RunBudget,
  ToolPort,
} from "@vibe/core";
import { AgentRuntime, FileSessionStore, JsonlRunLog, type RunHandle } from "../src/index";

const task = { id: "t1", input: { store: "noon-sg" } };
const budget: RunBudget = { maxIterations: 8, maxToolCalls: 8, maxRetries: 0, timeoutMs: 2000 };

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-run-"));
  cleanup.push(dir);
  return dir;
}

async function collect(handle: RunHandle): Promise<{ events: AgentEvent[]; run: Run }> {
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const run = await handle.done;
  return { events, run };
}

function makeRuntime(dir: string, core: AgentCore, tools: ToolPort, budgetOverride?: RunBudget): AgentRuntime {
  return new AgentRuntime({
    core,
    tools,
    runLog: new JsonlRunLog(join(dir, "runs")),
    sessions: new FileSessionStore(join(dir, "sessions")),
    budget: budgetOverride ?? budget,
  });
}

describe("AgentRuntime", () => {
  it("端到端完成：JSONL 落盘与事件流逐字段一致，重启后可从磁盘读回", async () => {
    const dir = await tmpDir();
    const core = modelDrivenCore(scriptedModel([
      { kind: "call_tool", intent: { name: "download_report", arguments: { reportId: "R-1" } } },
      { kind: "respond", content: { file: "R-1.csv" } },
    ]));
    const runtime = makeRuntime(dir, core, fakeTools({ download_report: () => ({ file: "R-1.csv", rows: 5 }) }));
    const { events, run } = await collect(runtime.run(task));

    expect(run.status).toBe("completed");
    expect(events.at(-1)).toMatchObject({ type: "run_completed", status: "complete", result: { file: "R-1.csv" } });

    const log = new JsonlRunLog(join(dir, "runs"));
    expect(await log.listEvents(run.runId)).toEqual(events);
    expect(await log.loadRun(run.runId)).toEqual(run);

    // 新 store 实例 = 模拟进程重启后从磁盘恢复
    const store = new FileSessionStore(join(dir, "sessions"));
    const session = await store.loadSession(run.sessionId);
    expect(session?.runs[0]).toMatchObject({ runId: run.runId, status: "completed" });
  });

  it("ask_human → resume：sequence 全局单调接续，回放包含人类输入", async () => {
    const dir = await tmpDir();
    const core: AgentCore = {
      async step(state) {
        if (state.messages.length === 0) return { kind: "ask_human", question: "确认下载 R-1？" };
        return { kind: "respond", content: "downloaded" };
      },
    };
    const runtime = makeRuntime(dir, core, fakeTools({}));
    const first = await collect(runtime.run(task));
    expect(first.run.status).toBe("awaiting_human");

    const second = await collect(runtime.resume(first.run.runId, { approved: true }));
    expect(second.run.status).toBe("completed");
    expect(second.events[0]?.type).toBe("human_input_received");
    expect(second.events[1]?.type).toBe("run_resumed");

    const log = new JsonlRunLog(join(dir, "runs"));
    const all = await log.listEvents(first.run.runId);
    const sequences = all.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(all.at(-1)).toMatchObject({ type: "run_completed" });

    const state = replayState(all);
    expect(state?.messages.some((m) => (m as { role: string }).role === "human")).toBe(true);
  });

  it("resume 非 awaiting_human 的 run 会被拒绝", async () => {
    const dir = await tmpDir();
    const core = modelDrivenCore(scriptedModel([{ kind: "respond", content: "done" }]));
    const runtime = makeRuntime(dir, core, fakeTools({}));
    const { run } = await collect(runtime.run(task));
    expect(run.status).toBe("completed");
    await expect(collect(runtime.resume(run.runId, {}))).rejects.toThrow(/only awaiting_human/);
  });

  it("中途取消：run_cancelled 落盘，绝不伪造 run_completed", async () => {
    const dir = await tmpDir();
    const controller = new AbortController();
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
    const core = modelDrivenCore(scriptedModel([
      { kind: "call_tool", intent: { name: "slow_export", arguments: {} } },
    ]));
    const runtime = makeRuntime(dir, core, selfAborting);
    const { events, run } = await collect(runtime.run(task, controller.signal));

    expect(run.status).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({ type: "run_cancelled" });
    expect(events.some((e) => e.type === "run_completed")).toBe(false);

    const log = new JsonlRunLog(join(dir, "runs"));
    expect((await log.listEvents(run.runId)).at(-1)).toMatchObject({ type: "run_cancelled" });
  });

  it("预算超时：模型挂起 → run_failed(budget_timeout)，归因到预算而非取消", async () => {
    const dir = await tmpDir();
    const hanging: AgentCore = {
      async step(_state, signal) {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(abortError()), { once: true }),
        );
        throw new Error("unreachable");
      },
    };
    const runtime = makeRuntime(dir, hanging, fakeTools({}), { ...budget, timeoutMs: 50 });
    const { events, run } = await collect(runtime.run(task));

    expect(run.status).toBe("failed");
    expect(events.at(-1)).toMatchObject({ type: "run_failed", error: { code: "budget_timeout" } });
  });

  it("两个 Session 隔离：runId/sessionId 互异，日志互不串扰", async () => {
    const dir = await tmpDir();
    const core: AgentCore = {
      async step(state) {
        return { kind: "respond", content: state.task.input };
      },
    };
    const runtime = makeRuntime(dir, core, fakeTools({}));
    const a = await collect(runtime.run({ id: "a", input: { store: "noon-sg" } }));
    const b = await collect(runtime.run({ id: "b", input: { store: "lazada-my" } }));

    expect(a.run.runId).not.toBe(b.run.runId);
    expect(a.run.sessionId).not.toBe(b.run.sessionId);
    expect(a.events.every((e) => e.runId === a.run.runId)).toBe(true);
    expect(b.events.every((e) => e.runId === b.run.runId)).toBe(true);

    const log = new JsonlRunLog(join(dir, "runs"));
    expect(await log.listEvents(a.run.runId)).toEqual(a.events);
    expect(await log.listEvents(b.run.runId)).toEqual(b.events);
    expect(a.events).not.toEqual(b.events);
  });
});
