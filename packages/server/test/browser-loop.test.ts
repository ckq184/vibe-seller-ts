// 路线 2 PRD §六.2 闭环单链测试（审查修复：建议 1"闭环未作单链走通"的钉子）。
// 同一条链经**同一个原生 ToolPort**（createNativeToolPort）走通：
//   vibe_seller_browser_navigate → vibe_seller_browser_read {mode:"text"}
//   → vibe_seller_write_workspace_file（把 read 到的数据回填 stores/<slug>/LOOP.md）
//   → GET /api/workspace/file（app.request 直读，断言落盘含 read 数据）
//   → vibe_seller_set_task_result（查 tasks.submitted_result 断言）。
// 证明 browse 五工具与既有回填工具经同一 ToolPort 组合工作，而非各自孤立可调。
// 全零真网/零真 Chrome：真 BrowseToolkit + 假 starter（固定端口）+ 内存假 CDP 传输
//（脚本化响应，静态页数据经 Runtime.evaluate 返回值模拟——
// browser-browse.test.ts 同款假件模式）；workspace 写读打真 Hono app（进程内）。
// 本文件同时钉 engine headless 对齐（routes_browser readHeadless 同语义，审查建议 2）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolIntent } from "@vibe/core";
import { createApp, hashPassword, type AppDeps } from "../src/app";
import { openDb, seed } from "../src/db";
import { EventBus } from "../src/bus";
import { createNativeToolPort, mintServiceToken } from "../src/agent/native-tools";
import { defaultEngineFactory } from "../src/agent/engine";
import { BrowseToolkit, resetBrowseStateForTests } from "../src/browser/browse";
import type { BrowserStarter } from "../src/browser/starter";
import type { CdpTransport } from "../src/browser/cdp";
import type { ServerConfig } from "../src/config";

// ── 内存假 CDP 服务端（browser-browse.test.ts 同款脚本化模式的最小集） ──

interface CdpFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

type Responder = (frame: CdpFrame, fake: FakeCdpTransport) => void;

class FakeCdpTransport implements CdpTransport {
  readonly sent: CdpFrame[] = [];
  private onMessageCb: ((text: string) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  constructor(private readonly server: FakeCdpServer) {}
  send(text: string): void {
    const frame = JSON.parse(text) as CdpFrame;
    this.sent.push(frame);
    if (typeof frame.id !== "number") return;
    const responder = this.server.responders.get(frame.method ?? "");
    if (responder) responder(frame, this);
    else this.fromServer({ id: frame.id, result: {} });
  }
  close(): void {}
  onMessage(cb: (text: string) => void): void {
    this.onMessageCb = cb;
  }
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }
  onError(_cb: (err: Error) => void): void {}
  fromServer(msg: Record<string, unknown>): void {
    this.onMessageCb?.(JSON.stringify(msg));
  }
}

class FakeCdpServer {
  readonly fakes: FakeCdpTransport[] = [];
  readonly responders = new Map<string, Responder>();
  on(method: string, responder: Responder): void {
    this.responders.set(method, responder);
  }
  /** 应答命令并（可选）紧随推一条事件（flatten：sessionId 在消息顶层）。 */
  resultThenEvent(method: string, result: Record<string, unknown>, event?: { method: string; sessionId?: string }): void {
    this.on(method, (frame, fake) => {
      fake.fromServer({ id: frame.id, result });
      if (event) fake.fromServer(event.sessionId !== undefined ? { method: event.method, params: {}, sessionId: event.sessionId } : { method: event.method, params: {} });
    });
  }
  readonly transportFactory = async (): Promise<FakeCdpTransport> => {
    const f = new FakeCdpTransport(this);
    this.fakes.push(f);
    return f;
  };
  readonly fetchImpl = (async () =>
    new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/fake" }))) as typeof fetch;
}

/** 假 starter：记录 ensure 调用，返回固定端口（真 BrowserStarter 的结构等价物）。 */
class FakeStarter {
  readonly calls: Array<{ method: string; key?: string; headless: boolean }> = [];
  async ensureStoreChrome(store: { id: string; name: string }, headless: boolean): Promise<{ cdpPort: number }> {
    this.calls.push({ method: "ensureStoreChrome", key: store.id, headless });
    return { cdpPort: 9223 };
  }
  async ensureWebChrome(headless: boolean): Promise<{ cdpPort: number }> {
    this.calls.push({ method: "ensureWebChrome", headless });
    return { cdpPort: 9223 };
  }
}

/** 记录 headless 入参后即停（engine headless 测试用：不给真端口，避免任何 CDP 走下去）。 */
class RecordingStarter {
  readonly headlessSeen: boolean[] = [];
  async ensureStoreChrome(_store: { id: string; name: string }, headless: boolean): Promise<{ cdpPort: number }> {
    this.headlessSeen.push(headless);
    throw new Error("recording-starter-stop");
  }
  async ensureWebChrome(headless: boolean): Promise<{ cdpPort: number }> {
    this.headlessSeen.push(headless);
    throw new Error("recording-starter-stop");
  }
}

// ── 夹具（native-tools.test.ts 的 config/app 组织） ──

const LOOP_STORE_ID = "st-loop";
const LOOP_STORE_SLUG = "loop-store"; // name "Loop Store" 的 ASCII 归约（storeSlug 同款规则）
const LOOP_TASK_ID = "task-loop";
const LOOP_URL = "https://seller.example/orders";
/** 静态页数据（脚本化 Runtime.evaluate 返回值模拟，PRD §六.2"注入式假 CDP"级）。 */
const PAGE_TEXT = "Pending Shipment 3 orders\nORD-2026-1010  buyer: acme  total: $58.90\nORD-2026-1011  buyer: globex total: $120.00";
const LOOP_PATH = `stores/${LOOP_STORE_SLUG}/LOOP.md`;

let dir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let db: import("node:sqlite").DatabaseSync;
let cfg: ServerConfig;
let server: FakeCdpServer;
let starter: FakeStarter;
let authToken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibe-loop-"));
  cfg = {
    homeDir: dir,
    dataDir: dir,
    dbPath: join(dir, "vibe_seller.db"),
    jwtSecretFile: join(dir, "jwt_secret"),
    port: 0,
    adminEmail: "admin@vibe-seller.local",
    adminPassword: "admin",
    adminUsername: "admin",
    version: "0.1.0-test",
    jwtSecret: "test-secret",
  };
  db = openDb(cfg);
  seed(db, cfg, hashPassword);
  deps = { config: cfg, jwtSecret: "test-secret", db, bus: new EventBus() };
  app = createApp(deps);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO stores (id, name, browser_backend, created_at, updated_at) VALUES (?, 'Loop Store', 'chrome', ?, ?)").run(
    LOOP_STORE_ID,
    now,
    now,
  );
  db.prepare(
    "INSERT INTO tasks (id, created_by, store_id, title, status, created_at, updated_at) VALUES (?, 'u', ?, 'Loop 任务', 'running', ?, ?)",
  ).run(LOOP_TASK_ID, LOOP_STORE_ID, now, now);
  authToken = mintServiceToken(db, "test-secret");
});

afterAll(async () => {
  deps.db.close(); // Windows：句柄未释放时 rm 会 EBUSY
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetBrowseStateForTests();
  server = new FakeCdpServer();
  starter = new FakeStarter();
});

afterEach(() => {
  for (const f of server.fakes) f.close();
});

function makeBrowseToolkit(): BrowseToolkit {
  return new BrowseToolkit(
    { db, starter, headless: () => false },
    LOOP_TASK_ID,
    { callBudgetMs: 5000, loadTimeoutMs: 2000, connectionDeps: { fetchImpl: server.fetchImpl, transportFactory: server.transportFactory } },
  );
}

const exec = async (port: ReturnType<typeof makePort>, name: string, args: Record<string, unknown>) =>
  port.execute({ name, arguments: args } as ToolIntent, new AbortController().signal);

function makePort(browse: BrowseToolkit) {
  return createNativeToolPort({ app, taskId: LOOP_TASK_ID, authToken, browse });
}

/** navigate 脚本：空 target 列表 → createTarget → attach → navigate（应答即推 load 事件）。 */
function scriptNavigate(): void {
  server.resultThenEvent("Target.getTargets", { targetInfos: [] });
  server.resultThenEvent("Target.createTarget", { targetId: "t-loop" });
  server.resultThenEvent("Target.attachToTarget", { sessionId: "sess-loop" });
  server.resultThenEvent("Page.enable", {});
  server.resultThenEvent("Page.navigate", {}, { method: "Page.loadEventFired", sessionId: "sess-loop" });
  // Runtime.evaluate 的真 CDP 响应形状：result 内再嵌 result:{value}（cdp.ts evalJs 读
  // res.result.value；browser-browse.test.ts 同款）
  server.on("Runtime.evaluate", (frame, fake) => {
    const expr = (frame.params as { expression: string }).expression;
    if (expr.includes("location.href")) {
      fake.fromServer({ id: frame.id, result: { result: { value: JSON.stringify({ href: LOOP_URL, title: "Order List" }) } } });
      return;
    }
    if (expr.includes("innerText")) {
      fake.fromServer({ id: frame.id, result: { result: { value: PAGE_TEXT } } });
      return;
    }
    fake.fromServer({ id: frame.id, result: {} });
  });
}

// ── PRD §六.2：闭环单链（同一个原生 ToolPort 组合 browse 与既有回填工具） ──

describe("闭环单链：navigate → read → write_workspace_file → GET 回读 → set_task_result", () => {
  it("browse 取数与既有回填经同一 ToolPort 走通全链；落盘与 submitted_result 都含 read 数据", async () => {
    scriptNavigate();
    const port = makePort(makeBrowseToolkit());

    // 1) navigate（browse 工具）
    const nav = await exec(port, "vibe_seller_browser_navigate", { url: LOOP_URL });
    expect(nav.status).toBe("success");
    expect(nav.result).toEqual({ tab_id: "t-loop", url: LOOP_URL, title: "Order List", load_state: "loaded" });
    // 会话解析经 starter 懒启动（服务端解析 store，agent 不传端点）
    expect(starter.calls).toEqual([{ method: "ensureStoreChrome", key: LOOP_STORE_ID, headless: false }]);

    // 2) read {mode:"text"}（browse 工具，同一条 CDP 连接复用）
    const read = await exec(port, "vibe_seller_browser_read", { mode: "text" });
    expect(read.status).toBe("success");
    const readResult = read.result as { text: string; truncated: boolean };
    expect(readResult.text).toContain("ORD-2026-1010");
    expect(server.fakes.length).toBe(1); // navigate/read 复用一条连接（连接表）

    // 3) 既有 write_workspace_file 回填（同一 ToolPort 的 HTTP 自调工具）
    const content = `# Loop 采集\n\n${readResult.text}\n`;
    const write = await exec(port, "vibe_seller_write_workspace_file", { path: LOOP_PATH, content });
    expect(write.status).toBe("success");
    expect(write.result).toEqual({ path: LOOP_PATH, status: "ok" });

    // 4) GET /api/workspace/file 直读落盘：内容含 read 到的数据
    const res = await app.request(`/api/workspace/file?path=${LOOP_PATH}`, { method: "GET", headers: { cookie: `auth_token=${authToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe(LOOP_PATH);
    expect(body.content).toContain("ORD-2026-1010");
    expect(body.content).toContain("ORD-2026-1011");

    // 5) set_task_result（同一 ToolPort 收尾）
    const resultText = `loop done: collected 2 orders from ${LOOP_URL}`;
    const submit = await exec(port, "vibe_seller_set_task_result", { result: resultText });
    expect(submit.status).toBe("success");
    expect(submit.result).toEqual({ ok: true, task_id: LOOP_TASK_ID, status: "running", resolved_from_file: false });

    // 6) tasks.submitted_result 断言
    const row = db.prepare("SELECT submitted_result FROM tasks WHERE id = ?").get(LOOP_TASK_ID) as {
      submitted_result: string | null;
    };
    expect(row.submitted_result).toBe(resultText);
  });
});

// ── engine headless 对齐（审查建议 2：routes_browser.ts readHeadless 同语义）──
// routes_browser.ts 的 readHeadless：CI=true 强制 headless；否则读 browser_headless 设置
// 缺省 false。engine.ts 的 BrowseToolkit headless 闭包此前缺 CI 强制分支——本组用例钉
// 三态：CI=true → 恒 true；无 CI → 设置缺省 false；无 CI 且设置 true → true。

describe("defaultEngineFactory browse headless 对齐（CI 强制分支）", () => {
  const setHeadlessSetting = (value: string): void => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('browser_headless', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  };

  /** 组装工厂 → dispatch 一次 navigate → RecordingStarter 记下 headless 即抛停。 */
  async function navigateHeadless(): Promise<boolean[]> {
    const rec = new RecordingStarter();
    const factory = defaultEngineFactory({ VIBE_BRIDGE_API_KEY: "test-key" }, cfg, {
      db,
      app,
      jwtSecret: "test-secret",
      starter: rec as unknown as BrowserStarter,
    });
    const per = await factory({ taskId: LOOP_TASK_ID, profileId: "default" });
    const r = await per.tools.execute({ name: "vibe_seller_browser_navigate", arguments: { url: "https://x.example" } } as ToolIntent, new AbortController().signal);
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("recording-starter-stop"); // 停在 starter 记录点，零 spawn
    return rec.headlessSeen;
  }

  const withCi = async (ci: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env["CI"];
    if (ci === undefined) delete process.env["CI"];
    else process.env["CI"] = ci;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env["CI"];
      else process.env["CI"] = prev;
    }
  };

  it("CI=true → headless 恒 true（设置 browser_headless=false 也不例外）", async () => {
    setHeadlessSetting("false");
    await withCi("true", async () => {
      expect(await navigateHeadless()).toEqual([true]);
    });
  });

  it("无 CI → 读设置缺省 false", async () => {
    setHeadlessSetting("false");
    await withCi(undefined, async () => {
      expect(await navigateHeadless()).toEqual([false]);
    });
  });

  it("无 CI 且 browser_headless=true → true", async () => {
    setHeadlessSetting("true");
    try {
      await withCi(undefined, async () => {
        expect(await navigateHeadless()).toEqual([true]);
      });
    } finally {
      setHeadlessSetting("false"); // 卫生：不留设置影响同文件其他用例
    }
  });
});
