// 工作区 AI 助手（app/ai/workspace_assistant.py 的等价物）：
// 每用户一个会话键 __ws_assistant_<uid>__，消息走 SSE（ws_assistant_message /
// ws_assistant_done），不落库、无任务记录。
//
// 与原实现的语义差异（沿用 Phase 3 已裁决的会话语径）：
//  - 原实现靠 CLI 子进程 stdin 注入实现"向运行中的会话追加消息"；TS runtime 的 run
//    是一次性 episode，故"运行中再来一条"排队，本轮结束后以"新 run + 完整消息历史"
//    交接（与桥上 fresh-run + message_history 同款取舍）。
//  - 确认闸门不挂助手：构建 runtime 时不装 gates（等价原 bypassPermissions +
//    控制请求自动 allow）。

import { join } from "node:path";
import { AgentRuntime, JsonlRunLog, MemorySessionStore, type RunHandle } from "@vibe/runtime";
import { createTranslator, defaultBudget, type RunFactoryResult } from "@vibe/bridge";
import type { EngineFactory } from "../agent/orchestrator";
import type { ServerConfig } from "../config";
import { storeSlug } from "./storeData";

interface AssistantDeps {
  config: ServerConfig;
  bus: { emit: (type: string, data: Record<string, unknown>) => void };
  engineFactory: EngineFactory;
}

interface SessionState {
  running: boolean;
  abort?: AbortController;
  /** 运行中收到的后续消息；本轮 done 后逐条起新 run。 */
  queue: string[];
  /** 待跑轮次使用的 profile（后到覆盖先到）。 */
  queuedProfile?: string;
  queuedSystemPrompt?: string;
}

export class WorkspaceAssistantManager {
  static MAX_CONCURRENT = 2;
  private readonly sessions = new Map<string, SessionState>();
  private readonly histories = new Map<string, { role: string; content: string }[]>();
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: AssistantDeps) {}

  private sessionKey(userId: string): string {
    return `__ws_assistant_${userId}__`;
  }

  isRunning(userId: string): boolean {
    return this.sessions.get(this.sessionKey(userId))?.running ?? false;
  }

  /** 发消息：运行中则排队（原实现 stdin 注入的等价物），否则起新 run。恒 true=受理。
   * 与原实现一致：请求只等到并发槽位（后台流式），不等到本轮跑完。 */
  async sendOrStart(userId: string, message: string, profileId: string, systemPrompt: string): Promise<boolean> {
    const key = this.sessionKey(userId);
    const history = this.histories.get(key) ?? [];
    history.push({ role: "user", content: message });
    this.histories.set(key, history);

    let state = this.sessions.get(key);
    if (!state) {
      state = { running: false, queue: [] };
      this.sessions.set(key, state);
    }
    if (state.running) {
      state.queue.push(message);
      state.queuedProfile = profileId;
      state.queuedSystemPrompt = systemPrompt;
      return true;
    }
    // running 同步置位：并发第二条消息进来时看到的是"运行中"而入队，不双启
    state.running = true;
    void this.startTurn(key, userId, message, profileId, systemPrompt);
    return true;
  }

  /** 停当前轮：abort → run_cancelled → done(interrupted)；队列随之清空。 */
  stop(userId: string): boolean {
    const key = this.sessionKey(userId);
    const state = this.sessions.get(key);
    if (!state?.running) return false;
    state.abort?.abort();
    state.queue = [];
    return true;
  }

  clearHistory(userId: string): void {
    this.histories.delete(this.sessionKey(userId));
  }

  private async acquire(): Promise<void> {
    if (this.active < WorkspaceAssistantManager.MAX_CONCURRENT) {
      this.active += 1;
      return;
    }
    await new Promise<void>((release) => this.waiters.push(release));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async startTurn(key: string, userId: string, message: string, profileId: string, systemPrompt: string): Promise<void> {
    const state = this.sessions.get(key)!;
    await this.acquire();
    const abort = new AbortController();
    state.abort = abort;

    try {
      await this.driveTurn(key, message, profileId, systemPrompt, abort);
    } catch (err) {
      console.error(`[vibe-assistant] turn error for ${key}:`, err);
      this.deps.bus.emit("ws_assistant_message", { session_key: key, role: "system", content: `Agent error: ${err instanceof Error ? err.message : err}` });
      this.deps.bus.emit("ws_assistant_done", { session_key: key, return_code: -1 });
    } finally {
      this.release();
      state.abort = undefined;
      // 收尾：本轮结束，若队列有消息则以累积历史起新 run（fresh run + history 交接）
      const next = state.queue.shift();
      const hasNext = Boolean(next) && !abort.signal.aborted;
      state.running = hasNext;
      if (next && hasNext) {
        void this.startTurn(key, userId, next!, state.queuedProfile ?? profileId, state.queuedSystemPrompt ?? systemPrompt);
      }
    }
  }

  private async driveTurn(key: string, message: string, profileId: string, systemPrompt: string, abort: AbortController): Promise<void> {
    const history = (this.histories.get(key) ?? []).slice(0, -1); // 末条即本轮 prompt
    const per: RunFactoryResult = await this.deps.engineFactory({ taskId: key, profileId });

    const runId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const runtime = new AgentRuntime({
      core: { step: async () => ({ kind: "respond", content: "" }) },
      runLog: new JsonlRunLog(join(this.deps.config.dataDir, "ts-runs")),
      sessions: new MemorySessionStore(),
      budget: defaultBudget(),
      engine: per.engine,
      tools: per.tools,
      // 无 gates：助手绕过确认闸门（原实现 bypassPermissions 同义）
      newRunId: () => runId,
    });

    const prompt = [systemPrompt, ...history.map((m) => `${m.role}: ${m.content}`), message].filter(Boolean).join("\n\n");
    const handle: RunHandle = runtime.run({ id: key, input: { prompt, mode: "chat", profile_id: profileId } }, abort.signal);

    const translator = createTranslator(key);
    try {
      for await (const ev of handle.events) {
        for (const frame of translator.translate(ev)) {
          if (frame.event === "message") {
            this.deps.bus.emit("ws_assistant_message", { session_key: key, role: frame.data.role, content: frame.data.content });
          } else if (frame.event === "done") {
            const status = frame.data.status as string;
            const interrupted = frame.data.interrupted === true;
            const returnCode = status === "completed" || status === "partial" ? 0 : interrupted ? -1 : 1;
            this.deps.bus.emit("ws_assistant_done", {
              session_key: key,
              return_code: returnCode,
              ...(interrupted ? { interrupted: true } : {}),
            });
          }
          // questions/status 帧：助手无批复端点、无 resume——不透出
        }
      }
      await handle.done;
    } catch (err) {
      console.error(`[vibe-assistant] run ${runId} crashed:`, err);
      this.deps.bus.emit("ws_assistant_message", { session_key: key, role: "system", content: `Agent error: ${err instanceof Error ? err.message : err}` });
      this.deps.bus.emit("ws_assistant_done", { session_key: key, return_code: -1 });
      return;
    }

    // run 结束即把本轮的 assistant 产出记入历史（用 result 文本），供下轮交接
    const done = translator.done;
    if (done && (done.status === "completed" || done.status === "partial") && done.result_text) {
      (this.histories.get(key) ?? []).push({ role: "assistant", content: done.result_text });
    }
  }
}

export function buildWorkspaceAssistantSystemPrompt(stores: { name: string; id: string; browser_backend?: string | null }[], WORKSPACE_ASSISTANT_PROMPT: string): string {
  let storesList: string;
  if (stores.length > 0) {
    storesList = stores
      .map((s) => {
        const slug = storeSlug(s.name, s.id);
        const backend = s.browser_backend || "chrome";
        return `- **${s.name}** (slug: \`${slug}\`, backend: ${backend})`;
      })
      .join("\n");
  } else {
    storesList = "_No stores configured yet._";
  }
  return WORKSPACE_ASSISTANT_PROMPT.replace("{stores_list}", storesList);
}
