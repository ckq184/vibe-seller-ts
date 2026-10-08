// 桥 HTTP 服务：node:http 零依赖实现 docs/bridge-protocol.md v1。
// 运行面：POST /v1/runs 启动 → 服务端自持消费循环（无订阅者也照常消费、落盘），
// SSE 订阅者是只读视图，晚到订阅从帧缓冲回放（与原 event_bus 单向广播语义对齐，
// 可回放性由 RunLog 承担）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentEvent, Run, Task } from "@vibe/core";
import { AgentRuntime, type RunHandle, type RuntimeDeps } from "@vibe/runtime";
import { TaskRegistry, type BridgeDeps, type RunEntry, type RunFactoryResult, type RunRequest } from "./registry";
import { createTranslator, type BridgeEvent, type DonePayload } from "./translate";

interface RunFeed {
  translator: ReturnType<typeof createTranslator>;
  frames: BridgeEvent[];
  finished: boolean;
  push: (frame: BridgeEvent) => void;
  close: () => void;
  subscribe: (fn: (frame: BridgeEvent | null) => void) => () => void;
}

function createFeed(taskId: string): RunFeed {
  const listeners = new Set<(frame: BridgeEvent | null) => void>();
  const frames: BridgeEvent[] = [];
  const feed: RunFeed = {
    translator: createTranslator(taskId),
    frames,
    finished: false,
    push(frame: BridgeEvent) {
      frames.push(frame);
      for (const fn of [...listeners]) fn(frame);
    },
    close() {
      if (feed.finished) return;
      feed.finished = true;
      for (const fn of [...listeners]) fn(null);
      listeners.clear();
    },
    subscribe(fn: (frame: BridgeEvent | null) => void) {
      if (feed.finished) {
        fn(null);
        return () => {};
      }
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return feed;
}

function writeSseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export interface BridgeServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
  feeds: Map<string, RunFeed>;
}

export function createBridgeServer(deps: BridgeDeps): BridgeServer {
  const { registry, maxConcurrent } = deps;
  const log = deps.log ?? console.error;
  const feeds = new Map<string, RunFeed>();
  let runCounter = 0;
  // 桥接管 runId 生成：注册表的外部 runId = RunLog 里的 runId。
  // runtime.run() 在同步段就消费 newRunId()，单线程下赋值无竞态。
  const currentRunId = { value: "" };
  const sharedRuntime = new AgentRuntime({ ...deps.base, newRunId: () => currentRunId.value });

  /** 有 runFactory 时按 run 组装 runtime；否则共用静态实例。 */
  function runtimeFor(per: RunFactoryResult | undefined): AgentRuntime {
    if (!per) return sharedRuntime;
    return new AgentRuntime({
      ...deps.base,
      newRunId: () => currentRunId.value,
      engine: per.engine,
      tools: per.tools,
      ...(per.gates ? { gates: per.gates } : {}),
      ...(per.budget ? { budget: per.budget } : {}),
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`bridge handler error: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (deps.token) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${deps.token}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/v1/health") {
      sendJson(res, 200, { ok: true, protocol: 1, runs_in_flight: registry.inFlight, max_concurrent: maxConcurrent });
      return;
    }

    if (method === "POST" && path === "/v1/runs") {
      await startRun(req, res);
      return;
    }

    const runMatch = path.match(/^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/);
    if (!runMatch) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const runId = decodeURIComponent(runMatch[1]!);
    const sub = runMatch[2];

    if (method === "GET" && !sub) {
      const entry = registry.getByRunId(runId);
      if (!entry) {
        sendJson(res, 404, { error: "unknown_run" });
        return;
      }
      sendJson(res, 200, {
        run_id: entry.runId,
        task_id: entry.taskId,
        status: entry.status,
        result_text: entry.resultText ?? "",
        error_code: entry.errorCode,
        pending_questions: entry.pendingQuestions,
      });
      return;
    }

    if (method === "GET" && sub === "/events") {
      streamEvents(runId, req, res);
      return;
    }

    if (method === "POST" && sub === "/answers") {
      let body: { request_id?: string; answers?: Record<string, unknown> };
      try {
        body = JSON.parse((await readBody(req)) || "{}") as typeof body;
      } catch {
        sendJson(res, 400, { error: "bad_json" });
        return;
      }
      const entry = registry.getByRunId(runId);
      if (!entry || !registry.isRunning(entry.taskId)) {
        sendJson(res, 404, { error: "unknown_run" });
        return;
      }
      if (entry.status !== "awaiting_human" || entry.pendingGateRequestId !== body.request_id) {
        sendJson(res, 409, { error: "no_pending_question" });
        return;
      }
      const approved = body.answers?.approved !== false;
      entry.pendingGateRequestId = undefined;
      entry.pendingQuestions = undefined;
      entry.status = "running";
      entry.resuming = true; // 旧 consume 的收尾在"受理→resume 起飞"窗口无权终局
      consumeResume(entry, { kind: "tool_approval", approved });
      sendJson(res, 202, { ok: true });
      return;
    }

    if (method === "POST" && sub === "/stop") {
      const entry = registry.getByRunId(runId);
      if (!entry) {
        sendJson(res, 404, { error: "unknown_run" });
        return;
      }
      if (entry.status === "awaiting_human") {
        // 挂起中的 run：runtime 执行段已结束，abort 无处可去 —— 直接终局（等价 CLI 停掉
        // 停在 AskUserQuestion 的进程：agent_done rc=-1）。RunLog 仍留有可回放状态。
        registry.finish(runId, "cancelled", { resultText: "" });
        const feed = feedFor(runId);
        feed.push({ event: "done", data: { task_id: entry.taskId, status: "cancelled", result_text: "", interrupted: true } });
        feed.close();
        void entry.dispose?.();
        sendJson(res, 200, { ok: true });
        return;
      }
      entry.controller.abort();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && sub === "/messages") {
      // v1：活会话续话未实现；Python 侧 fallback（fresh run + message_history）接管
      sendJson(res, 409, { error: "not_live" });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  async function startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "bad_json" });
      return;
    }
    const taskId = typeof body.task_id === "string" ? body.task_id : "";
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!taskId || !prompt) {
      sendJson(res, 400, { error: "task_id_and_prompt_required" });
      return;
    }
    const mode = typeof body.mode === "string" ? body.mode : "execute";
    if (registry.isRunning(taskId)) {
      sendJson(res, 409, { error: "already_running" });
      return;
    }
    if (registry.inFlight >= maxConcurrent) {
      sendJson(res, 429, { error: "at_capacity" });
      return;
    }
    const runId = `run-${++runCounter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const request: RunRequest = {
      taskId,
      prompt,
      mode,
      systemExtra: typeof body.system_extra === "string" ? body.system_extra : "",
      messageHistory: Array.isArray(body.message_history) ? body.message_history : [],
      workspaceDir: typeof body.workspace_dir === "string" ? body.workspace_dir : undefined,
      persistPrompt: body.persist_prompt !== false,
      profileId: typeof body.profile_id === "string" && body.profile_id ? body.profile_id : undefined,
    };
    const entry = registry.start(runId, request);
    if (!entry) {
      sendJson(res, 409, { error: "already_running" });
      return;
    }
    const task: Task = {
      id: taskId,
      input: {
        prompt: request.prompt,
        system_extra: request.systemExtra,
        message_history: request.messageHistory,
        workspace_dir: request.workspaceDir,
        mode: request.mode,
        profile_id: request.profileId,
      },
    };
    let per: RunFactoryResult | undefined;
    if (deps.runFactory) {
      try {
        per = await deps.runFactory({ taskId, request });
      } catch (err: unknown) {
        registry.finish(runId, "failed", { errorCode: "run_factory_failed" });
        log(`run factory failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 503, { error: "run_factory_failed" });
        return;
      }
    }
    entry.dispose = per?.dispose;
    entry.runtime = runtimeFor(per);
    currentRunId.value = runId;
    const handle = entry.runtime.run(task, entry.controller.signal);
    entry.handle = handle;
    feedFor(runId, taskId);
    consume(handle, entry);
    sendJson(res, 202, { run_id: runId, session_id: runId });
    log(`run ${runId} started for task ${taskId}${per ? " (per-run factory)" : ""}`);
  }

  function feedFor(runId: string, taskId?: string): RunFeed {
    let feed = feeds.get(runId);
    if (!feed) {
      const entry = registry.getByRunId(runId);
      feed = createFeed(taskId ?? entry?.taskId ?? "");
      feeds.set(runId, feed);
    }
    return feed;
  }

  function streamEvents(runId: string, req: IncomingMessage, res: ServerResponse): void {
    const feed = feeds.get(runId);
    if (!feed) {
      sendJson(res, 404, { error: "unknown_run" });
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();
    for (const frame of feed.frames) writeSseFrame(res, frame.event, frame.data);
    if (feed.finished) {
      res.end();
      return;
    }
    const ping = setInterval(() => writeSseFrame(res, "ping", { type: "ping" }), 15000);
    const unsubscribe = feed.subscribe((frame) => {
      if (frame === null) {
        clearInterval(ping);
        res.end();
        return;
      }
      writeSseFrame(res, frame.event, frame.data);
    });
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  /** 服务端自持消费循环：AgentEvent → translate → feed → 终局登记。 */
  function consume(handle: RunHandle, entry: RunEntry): void {
    const feed = feedFor(entry.runId);
    void (async () => {
      let sawDone = false;
      try {
        for await (const ev of handle.events) {
          applyEntryEvent(entry, ev);
          for (const frame of feed.translator.translate(ev)) {
            if (frame.event === "done") sawDone = true;
            feed.push(frame);
          }
        }
      } catch (err: unknown) {
        log(`run ${entry.runId} crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await handle.done;
      } catch {
        /* 崩溃已在上方记录；done 收尾在下方统一补 failed */
      }
      finishFromTranslator(entry, feed, sawDone);
    })();
  }

  function consumeResume(entry: RunEntry, input: unknown): void {
    const feed = feedFor(entry.runId);
    const launch = () => {
      entry.resuming = false;
      let handle: RunHandle;
      try {
        handle = (entry.runtime ?? sharedRuntime).resume(entry.runId, input, entry.controller.signal);
      } catch (err: unknown) {
        log(`resume rejected for ${entry.runId}: ${err instanceof Error ? err.message : String(err)}`);
        registry.finish(entry.runId, "failed", { errorCode: "runtime_error" });
        feed.push({ event: "done", data: { task_id: entry.taskId, status: "failed", result_text: "", error_code: "runtime_error" } });
        feed.close();
        return;
      }
      entry.handle = handle;
      void (async () => {
        let sawDone = false;
        try {
          for await (const ev of handle.events) {
            applyEntryEvent(entry, ev);
            for (const frame of feed.translator.translate(ev)) {
              if (frame.event === "done") sawDone = true;
              feed.push(frame);
            }
          }
        } catch (err: unknown) {
          log(`resume ${entry.runId} crashed: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          await handle.done;
        } catch {
          /* resume 拒绝等错误：下方统一补 failed 终局，SSE 不悬挂 */
        }
        finishFromTranslator(entry, feed, sawDone);
      })();
    };
    const prev = entry.handle;
    if (prev) {
      void prev.done.then(launch, launch);
    } else {
      launch();
    }
  }

  function finishFromTranslator(entry: RunEntry, feed: RunFeed, sawDone: boolean): void {
    if (!feed.translator.done) {
      // 旧 consume 的收尾无权终局的两个窗口：批复受理→resume 起飞（resuming）、
      // 闸门挂起保持开放（gateHeld）。只有后续 consume 的终局帧能收尾。
      if (entry.resuming || entry.gateHeld) return;
      if (entry.status === "awaiting_human" && !entry.controller.signal.aborted) {
        // 确认闸门挂起：runtime 执行段正常结束（awaiting_human 终态），但桥的 run 还活着 ——
        // feed 保持开放，resume 段在同一 feed 上续写，直到真终局。
        entry.gateHeld = true;
        log(`run ${entry.runId} awaiting human (gate suspended; feed held open)`);
        return;
      }
      if (entry.status === "awaiting_human" && entry.controller.signal.aborted) {
        // stop 与门挂起事件乱序到达的竞态：abort 请求已发，但 run 以 awaiting 结束 ——
        // 等价 CLI 停掉停在 AskUserQuestion 的进程，直接登记 cancelled 终局。
        log(`run ${entry.runId} aborted while awaiting; finalizing cancelled`);
        registry.finish(entry.runId, "cancelled", { resultText: "" });
        feed.push({ event: "done", data: { task_id: entry.taskId, status: "cancelled", result_text: "", interrupted: true } });
        feed.close();
        void entry.dispose?.();
        return;
      }
      log(`run ${entry.runId} ended without terminal event; synthesizing failed`);
    }
    const done: DonePayload = feed.translator.done ?? {
      task_id: entry.taskId,
      status: "failed",
      result_text: "",
      error_code: "runtime_error",
    };
    registry.finish(entry.runId, done.status, {
      resultText: done.result_text,
      errorCode: done.error_code,
    });
    // 终局事件由 translate 正常发出时帧已在流里；只有补发/合成路径才需要再 push
    if (!sawDone) feed.push({ event: "done", data: { ...done } });
    feed.close();
    void entry.dispose?.();
    log(`run ${entry.runId} finished: ${done.status}`);
  }

  function applyEntryEvent(entry: RunEntry, ev: AgentEvent): void {
    switch (ev.type) {
      case "human_input_requested": {
        entry.status = "awaiting_human";
        entry.gateSeq = (entry.gateSeq ?? 0) + 1;
        const request_id = `gate-${entry.gateSeq}`;
        entry.pendingGateRequestId = request_id;
        entry.pendingQuestions = { request_id, questions: [{ question: ev.question, kind: "tool_approval" }] };
        // 闸门锁存（对齐编排器）：此后旧 consume 的收尾永远无权终局
        entry.gateHeld = true;
        break;
      }
      case "human_input_received":
        break;
      case "run_completed":
        entry.status = "completed";
        break;
      case "run_failed":
        entry.status = "failed";
        break;
      case "run_cancelled":
        entry.status = "cancelled";
        break;
      default:
        break;
    }
  }

  return {
    server,
    feeds,
    port: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface StartOptions extends BridgeDeps {
  port?: number;
  host?: string;
}

/** 监听并返回实际端口（port=0 由系统分配，测试与生产引导共用）。 */
export function startBridge(opts: StartOptions): Promise<BridgeServer> {
  const bridge = createBridgeServer(opts);
  return new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const addr = bridge.server.address();
      bridge.port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(bridge);
    });
  });
}
