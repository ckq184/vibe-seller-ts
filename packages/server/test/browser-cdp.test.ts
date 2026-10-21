// 路线 2 PRD §4.2 / §六-8：CDP 连接层契约测试。
// 全部内存假件（FakeCdpTransport + 注入 fetchImpl/transportFactory）：零真网、零真 Chrome、
// 零真实端口占用。钉死：命令 id 关联（并发不串/非本连接 id 不误配）、CDP error 抛出、
// 每命令超时、断连作废且绝不自动重试、sessionId 作用域事件分发、Target 方法形状、
// overPort 装配（GET /json/version → webSocketDebuggerUrl → ws 建连）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, createWebSocketTransport, type CdpTransport } from "../src/browser/cdp";

/** 内存假 CdpTransport：捕获 client→server 帧、脚本化 server→client 推送、可模拟断连。 */
class FakeCdpTransport implements CdpTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  private messageCb: ((text: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  clientClosed = false;

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(): void {
    this.clientClosed = true;
  }

  onMessage(cb: (text: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  /** server → client 推一帧（命令响应或事件通知）。 */
  fromServer(msg: unknown): void {
    this.messageCb?.(JSON.stringify(msg));
  }

  /** 模拟远端断连（ws close）。 */
  drop(): void {
    this.closeCb?.();
  }

  lastSent(): Record<string, unknown> {
    return this.sent[this.sent.length - 1]!;
  }
}

interface Harness {
  conn: CdpConnection;
  fake: FakeCdpTransport;
}

/** 经 overPort 注入假 fetch（假 /json/version）与假 transport 建连，全内存零真网。 */
async function makeConn(opts: { commandTimeoutMs?: number } = {}): Promise<Harness> {
  const fake = new FakeCdpTransport();
  const conn = await CdpConnection.overPort(9222, {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }))) as typeof fetch,
    transportFactory: async () => fake,
    commandTimeoutMs: opts.commandTimeoutMs,
  });
  return { conn, fake };
}

describe("CdpConnection.send：命令关联与错误", () => {
  it("并发两条命令各自拿到自己的响应（请求 id 自增关联，不串）", async () => {
    const { conn, fake } = await makeConn();
    const p1 = conn.send("Page.navigate", { url: "https://a.example" });
    const p2 = conn.send("Runtime.evaluate", { expression: "1+1" });
    expect(fake.sent.length).toBe(2);
    const m1 = fake.sent[0]!;
    const m2 = fake.sent[1]!;
    expect(m1["id"]).not.toBe(m2["id"]);
    expect(m1["method"]).toBe("Page.navigate");
    expect(m2["method"]).toBe("Runtime.evaluate");
    fake.fromServer({ id: m2["id"], result: { value: 2 } });
    fake.fromServer({ id: m1["id"], result: { frameId: "f1" } });
    expect(await p1).toEqual({ frameId: "f1" });
    expect(await p2).toEqual({ value: 2 });
  });

  it("非本连接在途 id 的消息不误配：未知 id 被忽略，在途命令等到自己 id 的响应", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.send("Runtime.evaluate", { expression: "1" });
    const myId = fake.lastSent()["id"];
    fake.fromServer({ id: (myId as number) + 100, result: { hijacked: true } });
    fake.fromServer({ id: myId, result: { value: 42 } });
    expect(await p).toEqual({ value: 42 });
  });

  it("CDP error 响应 → throw 且消息含 method 与 CDP error message", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.send("Page.navigate", { url: "about:blank" });
    fake.fromServer({ id: fake.lastSent()["id"], error: { code: -32602, message: "Cannot navigate to invalid URL" } });
    await expect(p).rejects.toThrow(/Page\.navigate/);
    await expect(p).rejects.toThrow(/Cannot navigate to invalid URL/);
  });

  it("命令超时 → throw 含 method；迟到响应不得复活已超时命令；绝不自动重试", async () => {
    const { conn, fake } = await makeConn({ commandTimeoutMs: 20 });
    const p = conn.send("Target.attachToTarget", { targetId: "t1" });
    await expect(p).rejects.toThrow(/Target\.attachToTarget/);
    await expect(p).rejects.toThrow(/timeout/i);
    fake.fromServer({ id: fake.sent[0]!["id"], result: { sessionId: "late" } });
    await expect(p).rejects.toThrow(/timeout/i);
    expect(fake.sent.length).toBe(1); // 只发过一帧：超时后无重发（绝不自动重试铁律）
  });

  it("带 sessionId 时命令帧携带 sessionId", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.send("Page.enable", undefined, { sessionId: "sess-9" });
    const sent = fake.lastSent();
    expect(sent["sessionId"]).toBe("sess-9");
    fake.fromServer({ id: sent["id"], result: {} });
    await p;
  });
});

describe("CdpConnection：关闭与断连", () => {
  it("close 后 send → throw 含 'CDP connection closed'", async () => {
    const { conn } = await makeConn();
    conn.close();
    await expect(conn.send("Page.enable")).rejects.toThrow("CDP connection closed");
  });

  it("close() 触发 onClose 回调、isClosed 翻转，且幂等不重复触发", async () => {
    const { conn } = await makeConn();
    const observed: boolean[] = [];
    conn.onClose(() => observed.push(conn.isClosed));
    conn.close();
    expect(observed).toEqual([true]);
    expect(conn.isClosed).toBe(true);
    conn.close();
    expect(observed.length).toBe(1);
  });

  it("远端断连 → 在途命令拒绝含 'CDP connection closed'、连接作废、绝不重发", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.send("Page.navigate", { url: "https://x.example" });
    expect(fake.sent.length).toBe(1);
    fake.drop();
    await expect(p).rejects.toThrow("CDP connection closed");
    expect(conn.isClosed).toBe(true);
    await expect(conn.send("Page.enable")).rejects.toThrow("CDP connection closed");
    expect(fake.sent.length).toBe(1); // 断连后未自动重发（下次调用由调用方懒恢复）
  });
});

describe("CdpConnection：事件分发", () => {
  it("flatten 事件按消息**顶层** sessionId 匹配（真 Chrome wire 格式）：无 sessionId 订阅收所有同名事件；带 sessionId 只收匹配的", async () => {
    const { conn, fake } = await makeConn();
    const all: unknown[] = [];
    const scoped: unknown[] = [];
    conn.on("Page.loadEventFired", (p) => all.push(p));
    conn.on("Page.loadEventFired", (p) => scoped.push(p), { sessionId: "s1" });
    // wire 格式由真实冒烟抓帧钉死（2026-10-10）：flatten 模式下事件的 sessionId 在消息
    // **顶层**，与命令帧同位；params 内不含。假件必须镜像该形状（本用例即回归断言：
    // 旧实现只读 params.sessionId，曾致带 sessionId 订阅在真 Chrome 上永不触发）。
    fake.fromServer({ method: "Page.loadEventFired", params: { frameId: "f2" }, sessionId: "s2" });
    fake.fromServer({ method: "Page.loadEventFired", params: {}, sessionId: "s1" });
    fake.fromServer({ method: "Page.loadEventFired", params: {} }); // 浏览器级事件（无会话）
    fake.fromServer({ method: "Other.event", params: {}, sessionId: "s1" });
    expect(all.length).toBe(3); // 三个同名事件全收，Other.event 不收
    expect(scoped).toEqual([{}]); // 只收顶层 sessionId=s1 的那帧；s2/无会话不收
  });

  it("params 内嵌 sessionId 兼容路径仅防御（真 Chrome 恒为顶层，见上用例）", async () => {
    const { conn, fake } = await makeConn();
    const scoped: unknown[] = [];
    conn.on("Page.loadEventFired", (p) => scoped.push(p), { sessionId: "s1" });
    fake.fromServer({ method: "Page.loadEventFired", params: { sessionId: "s1" } });
    expect(scoped).toEqual([{ sessionId: "s1" }]);
    fake.fromServer({ method: "Page.loadEventFired", params: { sessionId: "s2" } });
    expect(scoped).toEqual([{ sessionId: "s1" }]); // 不匹配不收
  });

  it("off 注销后不再分发", async () => {
    const { conn, fake } = await makeConn();
    const got: unknown[] = [];
    const cb = (p: unknown): void => {
      got.push(p);
    };
    conn.on("Page.frameNavigated", cb);
    conn.off("Page.frameNavigated", cb);
    fake.fromServer({ method: "Page.frameNavigated", params: { frame: {} } });
    expect(got).toEqual([]);
  });
});

describe("CdpConnection：Target 方法", () => {
  it("attachToTarget 发送 {targetId, flatten: true} 并返回响应里的 sessionId", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.attachToTarget("t-abc");
    const sent = fake.lastSent();
    expect(sent["method"]).toBe("Target.attachToTarget");
    expect(sent["params"]).toEqual({ targetId: "t-abc", flatten: true });
    fake.fromServer({ id: sent["id"], result: { sessionId: "sess-1" } });
    expect(await p).toBe("sess-1");
  });

  it("createTarget 缺省 url 为 about:blank 并返回 targetId", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.createTarget();
    const sent = fake.lastSent();
    expect(sent["method"]).toBe("Target.createTarget");
    expect(sent["params"]).toEqual({ url: "about:blank" });
    fake.fromServer({ id: sent["id"], result: { targetId: "t-new" } });
    expect(await p).toBe("t-new");
  });

  it("closeTarget 发送 Target.closeTarget {targetId}", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.closeTarget("t-old");
    const sent = fake.lastSent();
    expect(sent["method"]).toBe("Target.closeTarget");
    expect(sent["params"]).toEqual({ targetId: "t-old" });
    fake.fromServer({ id: sent["id"], result: {} });
    await p;
  });

  it("getTargets 只返回 type === 'page' 的 {targetId,url,title,attached}", async () => {
    const { conn, fake } = await makeConn();
    const p = conn.getTargets();
    const sent = fake.lastSent();
    expect(sent["method"]).toBe("Target.getTargets");
    fake.fromServer({
      id: sent["id"],
      result: {
        targetInfos: [
          { targetId: "a", type: "page", url: "https://x", title: "X", attached: true },
          { targetId: "b", type: "iframe", url: "about:blank", title: "", attached: false },
          { targetId: "c", type: "page", url: "https://y", title: "Y", attached: false },
        ],
      },
    });
    expect(await p).toEqual([
      { targetId: "a", url: "https://x", title: "X", attached: true },
      { targetId: "c", url: "https://y", title: "Y", attached: false },
    ]);
  });
});

describe("CdpConnection.overPort：装配", () => {
  it("先 GET /json/version，再用其 webSocketDebuggerUrl 经 transportFactory 建连", async () => {
    const factoryUrls: string[] = [];
    let fetchedUrl = "";
    const conn = await CdpConnection.overPort(9223, {
      fetchImpl: (async (url: string) => {
        fetchedUrl = url;
        return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/guid" }));
      }) as typeof fetch,
      transportFactory: async (url) => {
        factoryUrls.push(url);
        return new FakeCdpTransport();
      },
    });
    expect(fetchedUrl).toBe("http://127.0.0.1:9223/json/version");
    expect(factoryUrls).toEqual(["ws://127.0.0.1:9223/devtools/browser/guid"]);
    expect(conn.isClosed).toBe(false);
  });

  it("/json/version 非 ok → throw 且不建 ws", async () => {
    const factoryUrls: string[] = [];
    await expect(
      CdpConnection.overPort(9224, {
        fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
        transportFactory: async (url) => {
          factoryUrls.push(url);
          return new FakeCdpTransport();
        },
      }),
    ).rejects.toThrow(/json\/version/);
    expect(factoryUrls).toEqual([]);
  });

  it("/json/version 缺 webSocketDebuggerUrl → throw", async () => {
    await expect(
      CdpConnection.overPort(9225, {
        fetchImpl: (async () => new Response(JSON.stringify({ Browser: "chrome/x" }))) as typeof fetch,
        transportFactory: async () => new FakeCdpTransport(),
      }),
    ).rejects.toThrow(/webSocketDebuggerUrl/);
  });

  it("overPort 失败文案可操作（审查 Major1）：所有失败路径都带 'browser session not ready on port <port>' 前缀", async () => {
    // 非 ok：前缀 + 端口 + /json/version 语义（原断言保留）
    await expect(
      CdpConnection.overPort(9224, {
        fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
        transportFactory: async () => new FakeCdpTransport(),
      }),
    ).rejects.toThrow(/browser session not ready on port 9224/);
    // 缺 webSocketDebuggerUrl：同前缀
    await expect(
      CdpConnection.overPort(9225, {
        fetchImpl: (async () => new Response(JSON.stringify({ Browser: "chrome/x" }))) as typeof fetch,
        transportFactory: async () => new FakeCdpTransport(),
      }),
    ).rejects.toThrow(/browser session not ready on port 9225/);
    // fetch 本身失败（端口上无监听 = 连接拒绝/超时的真实形态）：同前缀 + 原因
    await expect(
      CdpConnection.overPort(9226, {
        fetchImpl: (async () => {
          throw new Error("fetch failed (ECONNREFUSED)");
        }) as typeof fetch,
        transportFactory: async () => new FakeCdpTransport(),
      }),
    ).rejects.toThrow(/browser session not ready on port 9226.*ECONNREFUSED/s);
    // 建连（transportFactory）失败：同前缀 + 原因
    await expect(
      CdpConnection.overPort(9227, {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9227/devtools/browser/g" }))) as typeof fetch,
        transportFactory: async () => {
          throw new Error("upgrade rejected");
        },
      }),
    ).rejects.toThrow(/browser session not ready on port 9227.*upgrade rejected/s);
  });

  it("/json/version HTTP 200 但 body 非 JSON → 同前缀 + 非 JSON 语义（路线4 S10b / 路线2 台账 #11）", async () => {
    await expect(
      CdpConnection.overPort(9228, {
        fetchImpl: (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch,
        transportFactory: async () => new FakeCdpTransport(),
      }),
    ).rejects.toThrow(/browser session not ready on port 9228.*非 JSON/s);
  });

  it("/json/version HTTP 200 但 body 为 JSON null → 同前缀，不抛裸 TypeError（路线4 审查 M4）", async () => {
    await expect(
      CdpConnection.overPort(9229, {
        fetchImpl: (async () => new Response("null", { status: 200 })) as typeof fetch,
        transportFactory: async () => new FakeCdpTransport(),
      }),
    ).rejects.toThrow(/browser session not ready on port 9229/);
  });
});

// ── createWebSocketTransport：open 前失败必须 settle（审查 Major1：会话键防砖化）──
// 假 WebSocket（stub 全局，零真网）：镜像真实 ws 的异步事件时序——生产代码在构造后同步
// 挂监听是前提，事件在微任务里才触发（连接拒绝 / upgrade 拒绝都发生在 open 之前的异步窗口）。
// 修复前：error/close 监听把事件转发给尚未注册（null）的回调 → promise 永不 settle
// → browse 层 per-key connecting 互斥永久持有死 promise → 该会话键所有后续调用砖化。
// 探针：Promise.race 短超时——修复前 probe === "pending"（不 settle），修复后必为 rejected。

class StubWebSocket {
  /** 每个测试注入的脚本：拿到实例后在微任务里 fire 事件（异步时序镜像真实 ws）。 */
  static script: ((ws: StubWebSocket) => void) | null = null;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(_url: string) {
    queueMicrotask(() => StubWebSocket.script?.(this));
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  send(): void {
    /* 测试不发送 */
  }
  close(): void {
    /* 测试不关闭 */
  }
  fire(type: string, ev: unknown = {}): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev);
  }
}

async function settleProbe(p: Promise<unknown>, withinMs: number): Promise<string> {
  return Promise.race([
    p.then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    ),
    new Promise<string>((r) => setTimeout(() => r("pending"), withinMs)),
  ]);
}

describe("createWebSocketTransport：open 前失败必须 settle（审查 Major1）", () => {
  afterEach(() => {
    StubWebSocket.script = null;
    vi.unstubAllGlobals();
  });

  it("open 前 error（连接拒绝镜像）→ promise reject（不永久挂起），原因含 url 与事件细节", async () => {
    StubWebSocket.script = (ws) => ws.fire("error", { message: "ECONNREFUSED" });
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    const probe = await settleProbe(createWebSocketTransport("ws://127.0.0.1:9299/devtools/browser/x"), 500);
    expect(probe).toMatch(/^rejected/);
    expect(probe).toContain("ws://127.0.0.1:9299");
    expect(probe).toContain("ECONNREFUSED");
  });

  it("open 前 close（无 error 先行，如 upgrade 被拒即断）→ 同样 reject 而非挂起", async () => {
    StubWebSocket.script = (ws) => ws.fire("close", { code: 1006 });
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    const probe = await settleProbe(createWebSocketTransport("ws://127.0.0.1:9298/devtools/browser/x"), 500);
    expect(probe).toMatch(/^rejected/);
  });

  it("open 后 error → 沿用现行为转发 onError；未注册 onError 时 error 事件也被内部监听兜住（不崩进程）", async () => {
    const made: StubWebSocket[] = [];
    StubWebSocket.script = (ws) => {
      made.push(ws);
      ws.fire("open");
    };
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    // 已注册 onError：open 后 error 走回调转发（连接层作废语义的输入源，现行为保持）
    const withCb = await createWebSocketTransport("ws://127.0.0.1:9297/devtools/browser/a");
    const seen: Error[] = [];
    withCb.onError((e) => seen.push(e));
    made[0]!.fire("error", { message: "boom after open" });
    expect(seen.length).toBe(1);
    // 未注册 onError 的传输：error 事件由内部监听兜住，不得抛 unhandled error 崩进程
    await createWebSocketTransport("ws://127.0.0.1:9297/devtools/browser/b");
    made[1]!.fire("error", { message: "no listener" });
  });

  it("overPort 走真实 createWebSocketTransport + open 前失败 → reject 'browser session not ready on port <port>'（不挂起）", async () => {
    StubWebSocket.script = (ws) => ws.fire("error", { message: "connection refused" });
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
    const probe = await settleProbe(
      CdpConnection.overPort(9296, {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9296/devtools/browser/g" }))) as typeof fetch,
        // 不注 transportFactory：走真实 createWebSocketTransport（命中 stub 的 open 前失败）
      }),
      500,
    );
    expect(probe).toMatch(/^rejected: browser session not ready on port 9296/);
  });
});
