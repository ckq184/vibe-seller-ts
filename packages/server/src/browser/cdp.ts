// 浏览器 CDP 连接层（路线 2 PRD §4.2 裁决：裸 CDP、零新依赖、单客户端无 mux）。
// 语义来源：参考仓库 _reference/vibe-seller-src/app/browser/cdp_mux_proxy.py 的单客户端化
// 简化 + roadmap 路线 2 PRD 裁决——原 1700 行 mux 源于"多个 browser-use daemon 共享一个
// Chrome"，TS 侧每浏览器会话恰好单客户端（工具执行器独占连接），Target/session 所有权
// 路由整体不需要，仅保留：命令 id 关联、sessionId 作用域事件分发、每命令超时、断连作废。
// 铁律（PRD 4.2）：任何失败绝不自动重试已发出的命令（重跑变异命令 = 双击双填）；
// 断连后连接整体作废，由调用方下次走懒恢复。
// 传输层：Node ≥22.5 内建全局 WebSocket（undici）+ fetch（/json/version HTTP 面），
// 不引入 ws / playwright / puppeteer / chrome-remote-interface（宪法第 4 条）。

/** 连接与消息帧的抽象：生产 = 全局 WebSocket；测试 = 内存假传输（可脚本化）。 */
export interface CdpTransport {
  send(text: string): void;
  close(): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

/** 生产传输：浏览器级 ws 端点，open 后 resolve。
 * 不变量（审查 Major1）：构造后**立即**挂 error/close 监听——open 之前触发的 error/close
 * 一律 reject（含原因），保证 overPort 必然 settle（否则 browse 层 per-key connecting 互斥
 * 会永久持有死 promise，该会话键所有后续调用砖化）；open 之后触发沿用回调转发，onError
 * 回调缺省也由内部监听兜住（防 unhandled error 事件崩进程）；settle 后 reject 为 no-op。 */
export function createWebSocketTransport(url: string): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messageCb: { fn: ((text: string) => void) | null } = { fn: null };
    const closeCb: { fn: (() => void) | null } = { fn: null };
    const errorCb: { fn: ((err: Error) => void) | null } = { fn: null };
    let opened = false;
    let settled = false;
    const failBeforeOpen = (why: string): void => {
      if (opened || settled) return; // settle 后 reject 为 no-op
      settled = true;
      reject(new Error(`CDP WebSocket failed before open (${why}): ${url}`));
    };
    ws.addEventListener("message", (ev) => {
      const data: unknown = ev.data;
      // CDP 帧是文本帧（string）；二进制帧防御性解码，不产生静默乱码
      const text = typeof data === "string" ? data : new TextDecoder().decode(data as NodeJS.ArrayBufferView);
      messageCb.fn?.(text);
    });
    ws.addEventListener("close", (ev) => {
      if (!opened) {
        const code = (ev as { code?: unknown } | undefined)?.code;
        failBeforeOpen(`closed${typeof code === "number" ? ` code ${code}` : ""}`);
        return;
      }
      closeCb.fn?.();
    });
    ws.addEventListener("error", (ev) => {
      if (!opened) {
        const detail = (ev as { message?: unknown } | undefined)?.message;
        failBeforeOpen(detail ? `error: ${String(detail)}` : "error");
        return;
      }
      errorCb.fn?.(new Error(`CDP WebSocket error: ${url}`));
    });
    ws.addEventListener("open", () => {
      opened = true;
      resolve({
        send: (text) => ws.send(text),
        close: () => ws.close(),
        onMessage: (cb) => (messageCb.fn = cb),
        onClose: (cb) => (closeCb.fn = cb),
        onError: (cb) => (errorCb.fn = cb),
      });
    });
  });
}

export interface CdpConnectionDeps {
  fetchImpl?: typeof fetch;
  transportFactory?: (url: string) => Promise<CdpTransport>;
  /** 每命令超时缺省 20_000ms（PRD 4.2）；navigate 等载入场景由调用方按命令覆盖。 */
  commandTimeoutMs?: number;
}

/** getTargets 返回的页面型 target。 */
export interface CdpTargetInfo {
  targetId: string;
  url: string;
  title: string;
  attached: boolean;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

interface PendingEntry {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** 单客户端 CDP 连接：命令 id 关联 / sessionId 作用域事件 / 每命令超时 / 断连作废。 */
export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly eventSubs: Array<{ event: string; sessionId?: string; cb: (params: any) => void }> = [];
  private readonly closeCbs: Array<() => void> = [];
  private closedFlag = false;

  private constructor(
    private readonly transport: CdpTransport,
    private readonly commandTimeoutMs: number,
  ) {
    transport.onMessage((text) => this.handleText(text));
    // onClose 与 onError 都作废连接（PRD 4.2：ws 断连/出错 → 该连接作废，下次调用懒恢复）
    transport.onClose(() => this.invalidate());
    transport.onError(() => this.invalidate());
  }

  /** 经 GET http://127.0.0.1:<port>/json/version（2s 探活超时，同 starter.ts cdpAlive）取
   * 浏览器级 webSocketDebuggerUrl 后建连。所有失败路径都包可操作前缀
   * "browser session not ready on port <port>: <原因>"（审查 Major1：agent 拿到的
   * 永远是含端口与语义的错误，而非裸 fetch failed）。 */
  static async overPort(port: number, deps: CdpConnectionDeps = {}): Promise<CdpConnection> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`browser session not ready on port ${port}: CDP /json/version unreachable (${reason})`);
    }
    if (!resp.ok) throw new Error(`browser session not ready on port ${port}: CDP /json/version HTTP ${resp.status}`);
    const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
    const wsUrl = info.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error(`browser session not ready on port ${port}: CDP /json/version 未返回 webSocketDebuggerUrl`);
    let transport: CdpTransport;
    try {
      transport = await (deps.transportFactory ?? createWebSocketTransport)(wsUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`browser session not ready on port ${port}: WebSocket 建连失败 (${reason})`);
    }
    return new CdpConnection(transport, deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  }

  /** 发送一条 CDP 命令并等响应。任何失败（超时/error/断连）绝不自动重试——调用方铁律：
   * 已发出的变异命令重跑 = 双击双填，只能报告失败，恢复决策在调用方。 */
  send(method: string, params?: object, opts: { sessionId?: string; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closedFlag) {
      return Promise.reject(new Error(`CDP connection closed: cannot send ${method}`));
    }
    const id = ++this.nextId;
    const frame: Record<string, unknown> = { id, method };
    if (params !== undefined) frame.params = params;
    if (opts.sessionId !== undefined) frame.sessionId = opts.sessionId;
    const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      try {
        this.transport.send(JSON.stringify(frame));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`CDP send failed for ${method}: ${(err as Error).message}`));
      }
    });
  }

  /** flatten 模式 attach：返回 sessionId，后续命令经 send opts.sessionId 作用域到该 tab。 */
  async attachToTarget(targetId: string): Promise<string> {
    const result = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    return result.sessionId;
  }

  /** 新建 tab（缺省 about:blank——Chrome 至少要有一个页面），返回 targetId。 */
  async createTarget(url?: string): Promise<string> {
    const result = (await this.send("Target.createTarget", { url: url ?? "about:blank" })) as { targetId: string };
    return result.targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId });
  }

  /** 浏览器内所有 type === "page" 的 target。 */
  async getTargets(): Promise<CdpTargetInfo[]> {
    const result = (await this.send("Target.getTargets")) as { targetInfos?: Array<Record<string, unknown>> };
    return (result.targetInfos ?? [])
      .filter((t) => t["type"] === "page")
      .map((t) => ({
        targetId: t["targetId"] as string,
        url: t["url"] as string,
        title: t["title"] as string,
        attached: t["attached"] as boolean,
      }));
  }

  /** 订阅事件。不带 sessionId 收所有同名事件；带 sessionId 只收负载内嵌 sessionId 匹配的
   * （flatten 模式下 attachedToTarget 与页面级事件负载均含 sessionId 字段）。 */
  on(event: string, cb: (params: any) => void, opts?: { sessionId?: string }): void {
    this.eventSubs.push({ event, sessionId: opts?.sessionId, cb });
  }

  /** 注销订阅（event + cb + sessionId 三者精确匹配）。 */
  off(event: string, cb: (params: any) => void, opts?: { sessionId?: string }): void {
    const sessionId = opts?.sessionId;
    const idx = this.eventSubs.findIndex((s) => s.event === event && s.cb === cb && s.sessionId === sessionId);
    if (idx >= 0) this.eventSubs.splice(idx, 1);
  }

  /** 连接关闭回调（主动 close 或断连作废均触发；幂等只触发一次）。 */
  onClose(cb: () => void): void {
    if (this.closedFlag) {
      cb();
      return;
    }
    this.closeCbs.push(cb);
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  /** 主动关闭：关 ws、拒绝在途与后续 send、触发 onClose 回调（幂等）。 */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true; // 先置位：transport.close 触发的同步回调不再二次 settle
    try {
      this.transport.close();
    } catch {
      // 关闭失败不影响作废语义
    }
    this.settle();
  }

  private invalidate(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.settle();
  }

  /** 作废收尾：拒绝所有在途命令（绝不重试）+ 触发 onClose 回调。 */
  private settle(): void {
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`CDP connection closed: ${entry.method} 未获响应`));
    }
    this.pending.clear();
    for (const cb of [...this.closeCbs]) cb();
  }

  private handleText(text: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown; sessionId?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return; // 非法帧：忽略，不误配、不抛出
    }
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // 非本连接在途 id（迟到/外来帧）：不误配
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error != null) {
        const err = msg.error as { message?: string; data?: string };
        entry.reject(new Error(`CDP error in ${entry.method}: ${err.message ?? "unknown"}${err.data ? ` (${err.data})` : ""}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      this.dispatchEvent(msg.method, msg.params, msg.sessionId);
    }
  }

  /** 事件会话归属匹配。flatten wire 格式（真实 Chrome 抓帧钉死，2026-10-10 冒烟暴露）：
   * 事件的 sessionId 在消息**顶层**、与命令帧同位，params 内不含——旧实现只读
   * params.sessionId 曾致带 sessionId 订阅在真 Chrome 上永不触发（navigate 恒
   * load_state:"timeout"）。顶层优先；params 内嵌仅为防御性兼容读取（真端点不产生）。 */
  private dispatchEvent(method: string, params: unknown, eventSessionId: unknown): void {
    const sid = eventSessionId !== undefined ? eventSessionId : (params as { sessionId?: unknown } | null)?.sessionId;
    for (const sub of [...this.eventSubs]) {
      if (sub.event !== method) continue;
      if (sub.sessionId !== undefined && sub.sessionId !== sid) continue;
      sub.cb(params);
    }
  }
}
