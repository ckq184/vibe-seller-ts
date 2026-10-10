// 路线 2 PRD §4.1/§4.3/§4.4/§五/§六：browse 工具执行器契约测试（T3）。
// 全内存假件：真 CdpConnection + 内存假传输（脚本化响应/事件/挂起/断连）+ 假 starter
//（记录 ensure 调用与 headless 值、固定端口）+ 真实 sqlite tmp 库（seed 任务/店铺/会话行）。
// 零真网、零真 Chrome。钉死：会话解析（store 绑定 / _web / ziniao 守卫 / 未绑定）、
// navigate 全链与 load 超时、连接复用与断连重建、tabs 语义、tab LRU（12 上限、活跃不关、
// 最后一个不关）、read/eval 截断、act 各动作命令序列、120s 硬预算超时。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { createWebSocketTransport, type CdpConnectionDeps, type CdpTransport } from "../src/browser/cdp";
import { BROWSE_TOOL_NAMES, BrowseToolkit, resetBrowseStateForTests } from "../src/browser/browse";

// ── 内存假 CDP 服务端（脚本化：按 method 给 result / error / 挂起；可推事件、可断连） ──

interface CdpFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

type Responder = (frame: CdpFrame) => Record<string, unknown>;

class FakeCdpTransport implements CdpTransport {
  readonly sent: CdpFrame[] = [];
  private onMessageCb: ((text: string) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  clientClosed = false;
  constructor(private readonly server: FakeCdpServer) {}
  send(text: string): void {
    const frame = JSON.parse(text) as CdpFrame;
    this.sent.push(frame);
    if (typeof frame.id !== "number") return;
    this.server.respond(frame, this);
  }
  close(): void {
    this.clientClosed = true;
  }
  onMessage(cb: (text: string) => void): void {
    this.onMessageCb = cb;
  }
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }
  onError(_cb: (err: Error) => void): void {
    /* 测试不模拟传输层 error，断连统一走 drop() */
  }
  fromServer(msg: Record<string, unknown>): void {
    this.onMessageCb?.(JSON.stringify(msg));
  }
  /** 模拟远端断连（ws close）。 */
  drop(): void {
    this.onCloseCb?.();
  }
  frames(method: string): CdpFrame[] {
    return this.sent.filter((f) => f.method === method);
  }
  methods(): string[] {
    return this.sent.map((f) => f.method ?? "");
  }
}

class FakeCdpServer {
  readonly fakes: FakeCdpTransport[] = [];
  private readonly responders = new Map<string, Responder>();
  private readonly hangs = new Set<string>();
  private readonly errors = new Map<string, string>();

  /** 当前（最新一条）连接的假传输。 */
  get fake(): FakeCdpTransport {
    const f = this.fakes[this.fakes.length - 1];
    if (!f) throw new Error("test harness: no fake transport created yet");
    return f;
  }
  on(method: string, responder: Responder): void {
    this.responders.set(method, responder);
  }
  onResult(method: string, result: Record<string, unknown>): void {
    this.responders.set(method, () => result);
  }
  onHang(method: string): void {
    this.hangs.add(method);
  }
  onError(method: string, message: string): void {
    this.errors.set(method, message);
  }
  /** 假 CDP server 响应入口（FakeCdpTransport.send 回调；公开供假传输调用）。 */
  respond(frame: CdpFrame, fake: FakeCdpTransport): void {
    const method = frame.method ?? "";
    if (this.hangs.has(method)) return; // 挂起不回：等预算/每命令超时
    if (this.errors.has(method)) {
      fake.fromServer({ id: frame.id, error: { message: this.errors.get(method) } });
      return;
    }
    const responder = this.responders.get(method);
    fake.fromServer({ id: frame.id, result: responder ? responder(frame) : {} });
  }
  /** 推一条事件通知到当前连接。flatten wire 格式：sessionId 在消息**顶层**（与真 Chrome
   * 抓帧一致——旧形状内嵌 params 曾喂中 cdp.ts 只读 params.sessionId 的缺陷，
   * 2026-10-10 真实冒烟暴露后修正；本假件编码即回归镜像）。 */
  fire(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.fake.fromServer(sessionId !== undefined ? { method, params, sessionId } : { method, params });
  }
  readonly transportFactory = async (): Promise<FakeCdpTransport> => {
    const f = new FakeCdpTransport(this);
    this.fakes.push(f);
    return f;
  };
  readonly fetchImpl = (async () =>
    new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }))) as typeof fetch;
}

/** 假 starter：记录 ensure 调用与 headless 值，返回固定端口（真 BrowserStarter 的结构等价物）。 */
class FakeStarter {
  readonly calls: Array<{ method: string; key?: string; headless?: boolean }> = [];
  async ensureStoreChrome(store: { id: string; name: string }, headless: boolean): Promise<{ cdpPort: number }> {
    this.calls.push({ method: "ensureStoreChrome", key: store.id, headless });
    return { cdpPort: 9222 };
  }
  async ensureWebChrome(headless: boolean): Promise<{ cdpPort: number }> {
    this.calls.push({ method: "ensureWebChrome", headless });
    return { cdpPort: 9222 };
  }
}

// ── 夹具 ──

function pageInfo(targetId: string, url: string): Record<string, unknown> {
  return { targetId, type: "page", url, title: `T-${targetId}`, attached: false };
}

/** 轮询直到条件成立（事件驱动的 execute 需要，在挂起窗口里推事件）。
 * 条件里的取值（如 server.fake 在首条连接建立前）允许暂时性抛错：视作未就绪继续轮询。 */
async function until(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = cond();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > 2000) throw new Error(`test harness timeout: waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

let dir: string;
let db: import("node:sqlite").DatabaseSync;
let config: ServerConfig;
let server: FakeCdpServer;
let starter: FakeStarter;
let toolkit: BrowseToolkit;

beforeEach(async () => {
  resetBrowseStateForTests();
  dir = await mkdtemp(join(tmpdir(), "vibe-bb-"));
  config = {
    homeDir: dir,
    dataDir: join(dir, "data"),
    dbPath: join(dir, "data", "vibe_seller.db"),
    jwtSecretFile: join(dir, "data", "jwt_secret"),
    port: 0,
    adminEmail: "a@b.c", adminPassword: "admin", adminUsername: "admin",
    version: "t", jwtSecret: "test-secret",
  };
  db = openDb(config);
  seed(db, config, hashPassword);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO stores (id, name, browser_backend, created_at, updated_at) VALUES ('st-ch', 'Chrome店', 'chrome', ?, ?)").run(now, now);
  db.prepare("INSERT INTO stores (id, name, browser_backend, created_at, updated_at) VALUES ('st-zn', '紫鸟店', 'ziniao', ?, ?)").run(now, now);
  db.prepare("INSERT INTO tasks (id, created_by, store_id, title, status, created_at, updated_at) VALUES ('task-1', 'u', 'st-ch', '店铺任务', 'running', ?, ?)").run(now, now);
  db.prepare("INSERT INTO tasks (id, created_by, store_id, title, status, created_at, updated_at) VALUES ('task-z', 'u', 'st-zn', '紫鸟任务', 'running', ?, ?)").run(now, now);
  db.prepare("INSERT INTO tasks (id, created_by, store_id, title, status, created_at, updated_at) VALUES ('task-none', 'u', NULL, '无店任务', 'running', ?, ?)").run(now, now);
  // store 会话行：navigate 落 current_url 的落点
  db.prepare("INSERT INTO browser_sessions (id, store_id, status, started_at, updated_at) VALUES ('sess-st-ch', 'st-ch', 'running', ?, ?)").run(now, now);
  server = new FakeCdpServer();
  starter = new FakeStarter();
  toolkit = makeToolkit("task-1");
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeToolkit(taskId: string, opts: { callBudgetMs?: number; loadTimeoutMs?: number } = {}): BrowseToolkit {
  return new BrowseToolkit(
    { db, starter, headless: () => true },
    taskId,
    {
      callBudgetMs: opts.callBudgetMs ?? 5000,
      loadTimeoutMs: opts.loadTimeoutMs ?? 150, // 测试注入口：生产恒 30s（PRD §二）
      connectionDeps: { fetchImpl: server.fetchImpl, transportFactory: server.transportFactory },
    },
  );
}

/** navigate 到既有 tab 的标准脚本（getTargets 一个 tab / attach sess-1）。 */
function scriptExistingTab(targetId = "t1"): void {
  server.onResult("Target.getTargets", { targetInfos: [pageInfo(targetId, "https://a.example")] });
  server.onResult("Target.attachToTarget", { sessionId: "sess-1" });
}

// ── 会话解析（PRD §4.1 / §5.1 / §5.2） ──

describe("execute：工具名与会话参数面", () => {
  it("未知名 → throw 且不碰 starter / 不建连接", async () => {
    await expect(toolkit.execute("vibe_seller_browser_screenshot", {})).rejects.toThrow(/unknown browse tool/i);
    await expect(toolkit.execute("nonsense", {})).rejects.toThrow(/unknown browse tool/i);
    expect(starter.calls).toEqual([]);
    expect(server.fakes).toEqual([]);
  });

  it("五工具名之外全拒：BROWSE_TOOL_NAMES 恰为五个已知名", () => {
    expect([...BROWSE_TOOL_NAMES].sort()).toEqual([
      "vibe_seller_browser_act",
      "vibe_seller_browser_eval",
      "vibe_seller_browser_navigate",
      "vibe_seller_browser_read",
      "vibe_seller_browser_tabs",
    ]);
  });

  it("session 非法值 → throw Invalid session", async () => {
    await expect(toolkit.execute("vibe_seller_browser_read", { mode: "info", session: "sidetable" })).rejects.toThrow(
      /invalid session/i,
    );
    expect(starter.calls).toEqual([]);
  });
});

describe("navigate：会话解析守卫", () => {
  it("任务未绑定店铺（session=store 缺省）→ throw 说明须绑定或改 session:'web'，不碰 starter", async () => {
    const tk = makeToolkit("task-none");
    await expect(tk.execute("vibe_seller_browser_navigate", { url: "https://x.example" })).rejects.toThrow(
      /no bound store|session/,
    );
    expect(starter.calls).toEqual([]);
    expect(server.fakes).toEqual([]);
  });

  it("ziniao 后端店铺 → 结构化错误（反检测浏览器不支持，仅 chrome 后端与 web 会话）", async () => {
    const tk = makeToolkit("task-z");
    await expect(tk.execute("vibe_seller_browser_navigate", { url: "https://x.example" })).rejects.toThrow(
      /ziniao/i,
    );
    await expect(tk.execute("vibe_seller_browser_navigate", { url: "https://x.example" })).rejects.toThrow(
      /web session|chrome/i,
    );
    expect(starter.calls).toEqual([]);
    expect(server.fakes).toEqual([]);
  });

  it("店铺不存在（tasks.store_id 悬空）→ throw", async () => {
    db.prepare("INSERT INTO tasks (id, created_by, store_id, title, status, created_at, updated_at) VALUES ('task-ghost', 'u', 'st-nope', '幽灵任务', 'running', ?, ?)").run(
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const tk = makeToolkit("task-ghost");
    await expect(tk.execute("vibe_seller_browser_navigate", { url: "https://x.example" })).rejects.toThrow(
      /does not exist/i,
    );
    expect(starter.calls).toEqual([]);
  });
});

// ── navigate（PRD §二 / §4.4 / §5.2 scheme 守卫） ──

describe("navigate", () => {
  it("新 tab 全链：createTarget→attach(flatten)→Page.enable→navigate→load 事件→evaluate href/title；返回形状与 starter 记录；store 会话落 current_url", async () => {
    server.onResult("Target.getTargets", { targetInfos: [] });
    server.onResult("Target.createTarget", { targetId: "t-new" });
    server.onResult("Target.attachToTarget", { sessionId: "sess-1" });
    server.on("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ href: "https://x.example/", title: "X Title" }) } }));

    const p = toolkit.execute("vibe_seller_browser_navigate", { url: "https://x.example" });
    await until(() => server.fake.frames("Page.navigate").length === 1, "Page.navigate frame");
    server.fire("Page.loadEventFired", {}, "sess-1");
    const r = (await p) as { tab_id: string; url: string; title: string; load_state: string };

    expect(r).toEqual({ tab_id: "t-new", url: "https://x.example/", title: "X Title", load_state: "loaded" });
    expect(server.fake.methods()).toEqual([
      "Target.getTargets",
      "Target.createTarget",
      "Target.attachToTarget",
      "Page.enable",
      "Page.navigate",
      "Runtime.evaluate",
    ]);
    expect(server.fake.sent[1]!.method).toBe("Target.createTarget");
    expect(server.fake.sent[1]!.params).toEqual({ url: "https://x.example" }); // 新开 tab 带目标 url
    expect(server.fake.sent[2]!.params).toEqual({ targetId: "t-new", flatten: true });
    expect(server.fake.sent[3]!.method).toBe("Page.enable");
    expect(server.fake.sent[3]!.sessionId).toBe("sess-1");
    expect(server.fake.sent[4]!.params).toEqual({ url: "https://x.example" });
    expect(server.fake.sent[4]!.sessionId).toBe("sess-1");
    expect(server.fake.sent[5]!.params).toMatchObject({ returnByValue: true });
    // 每次 execute 都过 starter（lastUsedAt touch 语义的 T2/T4 行为面前提）
    expect(starter.calls).toEqual([{ method: "ensureStoreChrome", key: "st-ch", headless: true }]);
    // store 会话 navigate 成功后落 current_url + updated_at
    const row = db.prepare("SELECT current_url FROM browser_sessions WHERE store_id = 'st-ch'").get() as {
      current_url: string | null;
    };
    expect(row.current_url).toBe("https://x.example/");
  });

  it("load 事件超时 → 不 throw，返回 load_state:'timeout'", async () => {
    server.onResult("Target.getTargets", { targetInfos: [] });
    server.onResult("Target.createTarget", { targetId: "t-new" });
    server.onResult("Target.attachToTarget", { sessionId: "sess-1" });
    server.on("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ href: "https://x.example/", title: "" }) } }));
    // 不推 load 事件：harness loadTimeoutMs=150ms 后放行
    const r = (await toolkit.execute("vibe_seller_browser_navigate", { url: "https://x.example" })) as {
      load_state: string;
    };
    expect(r.load_state).toBe("timeout");
  });

  it("scheme 非 http/https → throw（file:// 不进导航），且不碰 starter / 不发任何 CDP 帧", async () => {
    await expect(toolkit.execute("vibe_seller_browser_navigate", { url: "file:///C:/Windows/win.ini" })).rejects.toThrow(
      /http/i,
    );
    await expect(toolkit.execute("vibe_seller_browser_navigate", { url: "chrome://settings" })).rejects.toThrow(/http/i);
    await expect(toolkit.execute("vibe_seller_browser_navigate", {})).rejects.toThrow(/url/i);
    expect(starter.calls).toEqual([]);
    expect(server.fakes).toEqual([]);
  });

  it("session:'web' → ensureWebChrome（key '_web' 语义），不落任何 current_url 行", async () => {
    scriptExistingTab();
    server.on("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ href: "https://w.example/", title: "W" }) } }));
    const p = toolkit.execute("vibe_seller_browser_navigate", { url: "https://w.example", session: "web" });
    await until(() => server.fake.frames("Page.navigate").length === 1, "Page.navigate frame");
    server.fire("Page.loadEventFired", {}, "sess-1");
    await p;
    expect(starter.calls).toEqual([{ method: "ensureWebChrome", headless: true }]);
    const row = db.prepare("SELECT current_url FROM browser_sessions WHERE store_id = 'st-ch'").get() as {
      current_url: string | null;
    };
    expect(row.current_url).toBeNull(); // web 会话不写 store 行
  });
});

// ── 连接表：复用与断连重建（PRD §4.2 懒恢复） ──

describe("连接复用与重连", () => {
  beforeEach(() => {
    scriptExistingTab();
    server.on("Runtime.evaluate", (f) => ({
      result: { value: (f.params as { expression: string }).expression === "1+1" ? 2 : null },
    }));
  });

  it("两次调用 transportFactory 只建一次连（连接表复用），但每次执行都过 starter", async () => {
    const r1 = (await toolkit.execute("vibe_seller_browser_eval", { expression: "1+1" })) as { text: string };
    const r2 = (await toolkit.execute("vibe_seller_browser_eval", { expression: "1+1" })) as { text: string };
    expect(r1.text).toBe("2");
    expect(r2.text).toBe("2");
    expect(server.fakes.length).toBe(1); // 一条 CDP 连接复用
    expect(starter.calls.length).toBe(2); // 每次 execute 都 ensure（touch lastUsedAt）
    expect(server.fake.frames("Target.attachToTarget").length).toBe(1); // sessionId per-target 缓存
  });

  it("断连（ws close）后下次调用懒恢复：旧连接作废、新连接重建（attach 重挂），绝不复用死连接", async () => {
    await toolkit.execute("vibe_seller_browser_eval", { expression: "1+1" });
    expect(server.fakes.length).toBe(1);
    server.fake.drop(); // 模拟 ws 断连 → 连接作废 + 逐出连接表
    const r2 = (await toolkit.execute("vibe_seller_browser_eval", { expression: "1+1" })) as { text: string };
    expect(r2.text).toBe("2");
    expect(server.fakes.length).toBe(2); // 重建
    expect(server.fake.frames("Target.attachToTarget").length).toBe(1); // 新连接上重新 attach
    expect(server.fake.methods()).toEqual(["Target.getTargets", "Target.attachToTarget", "Runtime.evaluate"]);
  });
});

// ── tabs（PRD §二：list/switch/close，永不关最后一个） ──

describe("tabs", () => {
  it("list：页型 targets 带 active 标记", async () => {
    scriptExistingTab("ta");
    server.onResult("Target.getTargets", {
      targetInfos: [pageInfo("ta", "https://a.example"), pageInfo("tb", "https://b.example")],
    });
    await toolkit.execute("vibe_seller_browser_navigate", { url: "https://a.example" }); // 置活跃 ta
    const r = (await toolkit.execute("vibe_seller_browser_tabs", { action: "list" })) as {
      ok: boolean;
      tabs: Array<{ tab_id: string; url: string; title: string; active: boolean }>;
    };
    expect(r.ok).toBe(true);
    expect(r.tabs).toEqual([
      { tab_id: "ta", url: "https://a.example", title: "T-ta", active: true },
      { tab_id: "tb", url: "https://b.example", title: "T-tb", active: false },
    ]);
  });

  it("switch：置活跃；未知 tab_id → throw", async () => {
    server.onResult("Target.getTargets", {
      targetInfos: [pageInfo("ta", "https://a.example"), pageInfo("tb", "https://b.example")],
    });
    server.onResult("Target.attachToTarget", { sessionId: "sess-1" });
    server.on("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ href: "https://a.example/", title: "A" }) } }));
    await toolkit.execute("vibe_seller_browser_navigate", { url: "https://a.example" });

    const sw = (await toolkit.execute("vibe_seller_browser_tabs", { action: "switch", tab_id: "tb" })) as {
      ok: boolean;
      active_tab_id: string;
    };
    expect(sw).toEqual({ ok: true, active_tab_id: "tb" });
    const list = (await toolkit.execute("vibe_seller_browser_tabs", { action: "list" })) as {
      tabs: Array<{ tab_id: string; active: boolean }>;
    };
    expect(list.tabs.find((t) => t.tab_id === "tb")?.active).toBe(true);
    expect(list.tabs.find((t) => t.tab_id === "ta")?.active).toBe(false);

    await expect(toolkit.execute("vibe_seller_browser_tabs", { action: "switch", tab_id: "tz" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("close：仅剩一个页型 tab → throw（拒绝关最后一个），不发 closeTarget", async () => {
    server.onResult("Target.getTargets", { targetInfos: [pageInfo("only", "https://a.example")] });
    await expect(toolkit.execute("vibe_seller_browser_tabs", { action: "close", tab_id: "only" })).rejects.toThrow(
      /last tab/i,
    );
    expect(server.fake.frames("Target.closeTarget")).toEqual([]);
  });

  it("close 非活跃 tab 成功；活跃 tab 被关时活跃顺延到最近未用 tab", async () => {
    server.onResult("Target.getTargets", {
      targetInfos: [pageInfo("ta", "https://a.example"), pageInfo("tb", "https://b.example")],
    });
    server.onResult("Target.attachToTarget", { sessionId: "sess-1" });
    server.on("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ href: "https://a.example/", title: "A" }) } }));
    await toolkit.execute("vibe_seller_browser_navigate", { url: "https://a.example" }); // 活跃 ta

    // 关非活跃 tb
    const r1 = (await toolkit.execute("vibe_seller_browser_tabs", { action: "close", tab_id: "tb" })) as {
      ok: boolean;
      closed_tab_id: string;
      active_tab_id: string | null;
    };
    expect(r1.ok).toBe(true);
    expect(r1.closed_tab_id).toBe("tb");
    expect(r1.active_tab_id).toBe("ta"); // 活跃不受影响
    expect(server.fake.frames("Target.closeTarget")[0]!.params).toEqual({ targetId: "tb" });

    // 关活跃 ta → 活跃顺延到剩余 tab
    server.onResult("Target.getTargets", { targetInfos: [pageInfo("ta", "https://a.example"), pageInfo("tb", "https://b.example")] });
    const r2 = (await toolkit.execute("vibe_seller_browser_tabs", { action: "close", tab_id: "ta" })) as {
      closed_tab_id: string;
      active_tab_id: string | null;
    };
    expect(r2.closed_tab_id).toBe("ta");
    expect(r2.active_tab_id).toBe("tb");
  });
});

// ── tab LRU（PRD §4.3：12 上限、关最久未用非活跃、永不关最后一个/活跃） ──

describe("tab LRU：第 13 个 tab 触发关闭", () => {
  it("新开第 13 个 tab → closeTarget 收到 LRU 最旧的非活跃 targetId；活跃（即使最旧）不被关", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => pageInfo(`t${String(i + 1).padStart(2, "0")}`, `https://x/${i + 1}`));
    let list = [...twelve];
    server.on("Target.getTargets", () => ({ targetInfos: list }));
    server.onResult("Target.attachToTarget", { sessionId: "sess-1" });
    server.on("Runtime.evaluate", (f) => {
      const expr = (f.params as { expression: string }).expression;
      if (expr.includes("location.href")) return { result: { value: JSON.stringify({ href: "https://x.example/", title: "T" }) } };
      return { result: { value: "body" } };
    });

    // 1) navigate：活跃 = t01（touch t01 → LRU 最新）
    const p1 = toolkit.execute("vibe_seller_browser_navigate", { url: "https://x.example" });
    await until(() => server.fake.frames("Page.navigate").length === 1, "first navigate");
    server.fire("Page.loadEventFired", {}, "sess-1");
    await p1;

    // 2) read 显式寻址 t05 → touch t05（比 t01 更新；t01 成为 LRU 最旧但它是活跃）
    await toolkit.execute("vibe_seller_browser_read", { mode: "text", tab_id: "t05" });

    // 3) new_tab 第 13 个 → LRU 顺序：t01(活跃,最旧) < t05 < t13 < t02..t04,t06..t12(未跟踪,ts=0)
    //    最旧非活跃 = t05 → 关 t05；t01 活跃豁免（此刻活跃仍指 t01）；t13 新开不关
    server.onResult("Target.createTarget", { targetId: "t13" });
    list = [...twelve, pageInfo("t13", "about:blank")];
    const p2 = toolkit.execute("vibe_seller_browser_navigate", { url: "https://x.example/new", new_tab: true });
    await until(() => server.fake.frames("Target.closeTarget").length === 1, "closeTarget frame");
    // 脚本化 target 列表同步关闭结果（tabs list 走同一脚本）
    const closedId = String((server.fake.frames("Target.closeTarget")[0]!.params as { targetId: string }).targetId);
    list = list.filter((t) => t.targetId !== closedId);
    await until(() => server.fake.frames("Page.navigate").length === 2, "second navigate");
    server.fire("Page.loadEventFired", {}, "sess-1");
    const r2 = (await p2) as { tab_id: string };

    expect(closedId).toBe("t05"); // LRU 最旧的非活跃
    expect(server.fake.frames("Target.closeTarget").length).toBe(1);
    expect(r2.tab_id).toBe("t13"); // 新 tab 活着且活跃
    const listed = (await toolkit.execute("vibe_seller_browser_tabs", { action: "list" })) as {
      tabs: Array<{ tab_id: string; active: boolean }>;
    };
    expect(listed.tabs.length).toBe(12); // 关回上限内
    expect(listed.tabs.find((t) => t.tab_id === "t13")?.active).toBe(true);
    expect(listed.tabs.find((t) => t.tab_id === "t01")?.active).toBe(false); // 活跃已让位给新 tab
  });
});

// ── read（PRD §二：info/text/html + max_chars 截断） ──

describe("read", () => {
  function scriptEvaluate(opts: { body: string; selectorValue: string | null; html: string }): void {
    scriptExistingTab();
    server.on("Runtime.evaluate", (f) => {
      const expr = (f.params as { expression: string }).expression;
      if (expr.includes("outerHTML")) return { result: { value: opts.html } };
      if (expr.includes("querySelector")) {
        return opts.selectorValue === null ? { result: {} } : { result: { value: opts.selectorValue } };
      }
      return { result: { value: opts.body } };
    });
  }

  it("info：{tab_id,url,title}，不发起任何 evaluate", async () => {
    scriptExistingTab("t9");
    const r = (await toolkit.execute("vibe_seller_browser_read", { mode: "info" })) as {
      tab_id: string;
      url: string;
      title: string;
    };
    expect(r).toEqual({ tab_id: "t9", url: "https://a.example", title: "T-t9" });
    expect(server.fake.frames("Runtime.evaluate")).toEqual([]);
  });

  it("text：无 selector 取 body innerText；超 max_chars → 切片 + truncated + total_length", async () => {
    scriptEvaluate({ body: "x".repeat(50), selectorValue: "sel", html: "<p/>" });
    const r = (await toolkit.execute("vibe_seller_browser_read", { mode: "text", max_chars: 10 })) as {
      text: string;
      truncated: boolean;
      total_length: number;
    };
    expect(r).toEqual({ text: "x".repeat(10), truncated: true, total_length: 50 });
  });

  it("text：selector 命中取 innerText；selector 不存在 → throw 含 selector", async () => {
    scriptEvaluate({ body: "body", selectorValue: "¥1.00", html: "" });
    const r = (await toolkit.execute("vibe_seller_browser_read", { mode: "text", selector: "#price" })) as { text: string };
    expect(r.text).toBe("¥1.00");
    const expr = server.fake.frames("Runtime.evaluate")[0]!.params as { expression: string };
    expect(expr.expression).toContain('document.querySelector("#price")');

    scriptEvaluate({ body: "body", selectorValue: null, html: "" });
    await expect(toolkit.execute("vibe_seller_browser_read", { mode: "text", selector: "#gone" })).rejects.toThrow(
      /#gone/,
    );
  });

  it("html：取 outerHTML 且走同一 selector 通道；截断语义一致", async () => {
    scriptEvaluate({ body: "", selectorValue: "<div>x</div>", html: "<div>x</div>" });
    const r = (await toolkit.execute("vibe_seller_browser_read", { mode: "html", selector: ".a", max_chars: 4 })) as {
      text: string;
      truncated: boolean;
      total_length: number;
    };
    expect(r).toEqual({ text: "<div", truncated: true, total_length: 12 });
  });
});

// ── eval（PRD §二：returnByValue JSON 结果 + 截断 + 逃生舱语义） ──

describe("eval", () => {
  beforeEach(() => {
    scriptExistingTab();
  });

  it("普通值：JSON 序列化为 text，truncated=false", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: { a: 1, b: "x" } } }));
    const r = (await toolkit.execute("vibe_seller_browser_eval", { expression: "({a:1,b:'x'})" })) as {
      text: string;
      truncated: boolean;
      total_length: number;
    };
    expect(r).toEqual({ text: '{"a":1,"b":"x"}', truncated: false, total_length: 15 });
    const frame = server.fake.frames("Runtime.evaluate")[0]!;
    expect(frame.params).toMatchObject({ returnByValue: true, awaitPromise: true, expression: "({a:1,b:'x'})" });
  });

  it("exceptionDetails → throw 含异常文案", async () => {
    server.on("Runtime.evaluate", () => ({
      result: {},
      exceptionDetails: { exception: { description: "ReferenceError: boom is not defined" } },
    }));
    await expect(toolkit.execute("vibe_seller_browser_eval", { expression: "boom" })).rejects.toThrow(
      /boom is not defined/,
    );
  });

  it("超长结果按 max_chars 切片 + truncated/total_length（切的是 JSON 序列化文本）", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: "y".repeat(100) } }));
    const full = JSON.stringify("y".repeat(100)); // 含首尾引号
    const r = (await toolkit.execute("vibe_seller_browser_eval", { expression: "'y'.repeat(100)", max_chars: 10 })) as {
      text: string;
      truncated: boolean;
      total_length: number;
    };
    expect(r).toEqual({ text: full.slice(0, 10), truncated: true, total_length: full.length });
  });

  it("不可序列化（无 value 有 description）→ 返回 {text: description}", async () => {
    server.on("Runtime.evaluate", () => ({ result: { type: "function", description: "function foo() {…}" } }));
    const r = (await toolkit.execute("vibe_seller_browser_eval", { expression: "foo" })) as {
      text: string;
      truncated: boolean;
    };
    expect(r.text).toBe("function foo() {…}");
    expect(r.truncated).toBe(false);
  });
});

// ── act（PRD §4.4 动作语义；命令序列与参数形状） ──

describe("act", () => {
  beforeEach(() => {
    scriptExistingTab();
  });

  it("click：rect evaluate（scrollIntoView+中心点）→ mouseMoved+Pressed+Released（left, clickCount 1, 中心坐标）", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: { x: 60, y: 45 } } }));
    const r = (await toolkit.execute("vibe_seller_browser_act", { action: "click", selector: "#btn" })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const expr = (server.fake.frames("Runtime.evaluate")[0]!.params as { expression: string }).expression;
    expect(expr).toContain('document.querySelector("#btn")');
    expect(expr).toContain("scrollIntoView");
    const mouses = server.fake.frames("Input.dispatchMouseEvent");
    expect(mouses.map((m) => String((m.params as { type: string }).type))).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(mouses[1]!.params).toMatchObject({ x: 60, y: 45, button: "left", clickCount: 1 });
    expect(mouses[2]!.params).toMatchObject({ x: 60, y: 45, button: "left", clickCount: 1 });
  });

  it("hover：仅一发 mouseMoved", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: { x: 10, y: 20 } } }));
    await toolkit.execute("vibe_seller_browser_act", { action: "hover", selector: "#menu" });
    const mouses = server.fake.frames("Input.dispatchMouseEvent");
    expect(mouses.length).toBe(1);
    expect(mouses[0]!.params).toMatchObject({ type: "mouseMoved", x: 10, y: 20 });
  });

  it("元素找不到 → throw 含 action 与 selector", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: null } }));
    await expect(toolkit.execute("vibe_seller_browser_act", { action: "click", selector: "#nope" })).rejects.toThrow(
      /click.*#nope/,
    );
  });

  it("type：selector 先走 click 路径聚焦，再 Input.insertText；无 selector 直接 insertText", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: { x: 5, y: 6 } } }));
    await toolkit.execute("vibe_seller_browser_act", { action: "type", selector: "#q", text: "hello" });
    expect(server.fake.frames("Input.dispatchMouseEvent").length).toBe(3); // click 聚焦路径
    const insert = server.fake.frames("Input.insertText");
    expect(insert.length).toBe(1);
    expect(insert[0]!.params).toEqual({ text: "hello" });

    await toolkit.execute("vibe_seller_browser_act", { action: "type", text: "raw" });
    expect(server.fake.frames("Input.insertText")[1]!.params).toEqual({ text: "raw" });
  });

  it("press Enter：rawKeyDown+keyUp 两发，windowsVirtualKeyCode 13 + text \\r；未知键 throw 列出支持的键", async () => {
    await toolkit.execute("vibe_seller_browser_act", { action: "press", key: "Enter" });
    const keys = server.fake.frames("Input.dispatchKeyEvent");
    expect(keys.map((k) => String((k.params as { type: string }).type))).toEqual(["rawKeyDown", "keyUp"]);
    expect(keys[0]!.params).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(keys[1]!.params).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

    await expect(toolkit.execute("vibe_seller_browser_act", { action: "press", key: "F13" })).rejects.toThrow(
      /F13.*Enter|supported/i,
    );
  });

  it("select：原生 setter 表达式（value JSON 转义 + input/change 事件）→ 返回新值", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: { value: "w" } } }));
    const r = (await toolkit.execute("vibe_seller_browser_act", { action: "select", selector: "#s", value: 'he"llo' })) as {
      value: unknown;
    };
    expect(r.value).toBe("w");
    const expr = (server.fake.frames("Runtime.evaluate")[0]!.params as { expression: string }).expression;
    expect(expr).toContain(JSON.stringify('he"llo')); // value 经 JSON.stringify 转义进表达式
    expect(expr).toContain('getOwnPropertyDescriptor');
    expect(expr).toContain('new Event("input"');
    expect(expr).toContain('new Event("change"');
  });

  it("scroll：mouseWheel 于视口中心，缺省 dy=600；dx/dy 可覆盖", async () => {
    server.on("Runtime.evaluate", () => ({ result: { value: { x: 400, y: 300 } } }));
    await toolkit.execute("vibe_seller_browser_act", { action: "scroll" });
    let wheel = server.fake.frames("Input.dispatchMouseEvent");
    expect(wheel[0]!.params).toMatchObject({ type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 600 });

    await toolkit.execute("vibe_seller_browser_act", { action: "scroll", dx: -120, dy: 0 });
    wheel = server.fake.frames("Input.dispatchMouseEvent");
    expect(wheel[1]!.params).toMatchObject({ type: "mouseWheel", deltaX: -120, deltaY: 0 });
  });

  it("wait：selector 命中 → found:true；超时（timeout_ms 注入小值）→ found:false，不 throw", async () => {
    let hit = true;
    server.on("Runtime.evaluate", () => ({ result: { value: hit } }));
    const okR = (await toolkit.execute("vibe_seller_browser_act", {
      action: "wait",
      selector: "#late",
      timeout_ms: 2000,
    })) as { found: boolean; elapsed_ms: number };
    expect(okR.found).toBe(true);
    expect(typeof okR.elapsed_ms).toBe("number");

    hit = false;
    const start = Date.now();
    const missR = (await toolkit.execute("vibe_seller_browser_act", {
      action: "wait",
      selector: "#never",
      timeout_ms: 80,
    })) as { found: boolean; elapsed_ms: number };
    expect(missR.found).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000); // 注入小值真的生效
  });

  it("wait：无 selector 纯延时，返回 elapsed_ms", async () => {
    const r = (await toolkit.execute("vibe_seller_browser_act", { action: "wait", ms: 20 })) as {
      found?: boolean;
      elapsed_ms: number;
    };
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(10);
    expect(server.fake.frames("Runtime.evaluate")).toEqual([]);
  });

  it("未知 action → throw（参数面校验，不碰 starter）", async () => {
    await expect(toolkit.execute("vibe_seller_browser_act", { action: "screenshot" })).rejects.toThrow(/action/i);
    expect(starter.calls).toEqual([]);
  });
});

// ── 硬预算（PRD §4.2：单次工具调用 120s；测试注入极小值） ──

describe("callBudgetMs 硬预算", () => {
  it("挂起响应 + 极小预算 → throw 含 budget 字样，不无限等待", async () => {
    const tk = makeToolkit("task-1", { callBudgetMs: 40 });
    scriptExistingTab();
    server.onHang("Runtime.evaluate");
    await expect(tk.execute("vibe_seller_browser_eval", { expression: "while(true){}" })).rejects.toThrow(/budget/i);
    server.fake.drop(); // 卫生：清挂在途命令
  });
});

// ── 参数面校验（不发 CDP 帧、不碰 starter） ──

describe("参数面校验", () => {
  it("read 非法 mode / tabs 非法 action / eval 空 expression → throw", async () => {
    await expect(toolkit.execute("vibe_seller_browser_read", { mode: "screenshot" })).rejects.toThrow(/mode/i);
    await expect(toolkit.execute("vibe_seller_browser_tabs", { action: "new" })).rejects.toThrow(/action/i);
    await expect(toolkit.execute("vibe_seller_browser_eval", {})).rejects.toThrow(/expression/i);
    expect(starter.calls).toEqual([]);
    expect(server.fakes).toEqual([]);
  });

  it("显式 tab_id 不在页型列表 → throw", async () => {
    scriptExistingTab();
    await expect(toolkit.execute("vibe_seller_browser_read", { mode: "info", tab_id: "t-ghost" })).rejects.toThrow(
      /t-ghost/,
    );
  });
});

// ── 首次建连 open 前失败 → 快速失败 + 下次调用重建（审查 Major1：会话键防砖化）──
// 端到端镜像生产路径：第一次 transportFactory 调用走**真实** createWebSocketTransport
//（stub 全局 WebSocket：微任务里 fire error、永不 open——连接拒绝的真实形态），修复前该
// promise 永不 settle → per-key connecting 互斥永久持有死 promise → 本 key 所有后续调用
// 每次烧满硬预算且无恢复路径。探针证明：失败要"快速"（大预算也不得烧满）且下一次调用
//（工厂恢复）能重建连接——不许可死 promise 残留。

class PreOpenErrorWebSocket {
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(_url: string) {
    queueMicrotask(() => {
      for (const cb of this.listeners.get("error") ?? []) cb({ message: "ECONNREFUSED" });
    });
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  send(): void {
    /* open 前失败，永不发送 */
  }
  close(): void {
    /* 测试不关闭 */
  }
}

describe("建连失败恢复（会话键防砖化）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("第一次建连 open 前失败 → 快速 throw（大预算不烧满）；第二次工厂恢复成功且连接表干净", async () => {
    vi.stubGlobal("WebSocket", PreOpenErrorWebSocket as unknown as typeof WebSocket);
    scriptExistingTab();
    server.on("Runtime.evaluate", () => ({ result: { value: 2 } }));
    let factoryCalls = 0;
    const deps: CdpConnectionDeps = {
      fetchImpl: server.fetchImpl,
      transportFactory: (url) => {
        factoryCalls += 1;
        if (factoryCalls === 1) return createWebSocketTransport(url); // 真实生产路径 + open 前失败
        return server.transportFactory(); // 第二次起工厂"恢复"（零参假件，结构面兼容注入）
      },
    };
    // 大预算（60s）注入：失败必须发生在微任务级，绝不烧满预算
    const tk = new BrowseToolkit(
      { db, starter, headless: () => true },
      "task-1",
      { callBudgetMs: 60_000, loadTimeoutMs: 150, connectionDeps: deps },
    );

    const start = Date.now();
    const probe = await Promise.race([
      tk.execute("vibe_seller_browser_eval", { expression: "1+1" }).then(
        () => "resolved" as const,
        (e: Error) => `rejected: ${e.message}` as const,
      ),
      new Promise<string>((r) => setTimeout(() => r("pending"), 1200)),
    ]);
    expect(probe).toMatch(/^rejected: browser session not ready on port 9222/); // 可操作文案（非裸 fetch failed）
    expect(Date.now() - start).toBeLessThan(5000); // 快速失败：未烧满 60s 预算

    // 第二次调用（工厂已恢复）：成功建连，死 promise 无残留（connecting 已清）
    const r = (await tk.execute("vibe_seller_browser_eval", { expression: "1+1" })) as { text: string };
    expect(r.text).toBe("2");
    // 连接表干净：恢复后恰好一条真连接，且第三次调用复用它（不再重建）
    expect(server.fakes.length).toBe(1);
    const r3 = (await tk.execute("vibe_seller_browser_eval", { expression: "1+1" })) as { text: string };
    expect(r3.text).toBe("2");
    expect(server.fakes.length).toBe(1);
    expect(factoryCalls).toBe(2);
  });
});
