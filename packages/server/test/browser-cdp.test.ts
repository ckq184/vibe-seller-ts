// 路线 2 PRD §4.2 / §六-8：CDP 连接层契约测试。
// 全部内存假件（FakeCdpTransport + 注入 fetchImpl/transportFactory）：零真网、零真 Chrome、
// 零真实端口占用。钉死：命令 id 关联（并发不串/非本连接 id 不误配）、CDP error 抛出、
// 每命令超时、断连作废且绝不自动重试、sessionId 作用域事件分发、Target 方法形状、
// overPort 装配（GET /json/version → webSocketDebuggerUrl → ws 建连）。

import { describe, expect, it } from "vitest";
import { CdpConnection, type CdpTransport } from "../src/browser/cdp";

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
});
