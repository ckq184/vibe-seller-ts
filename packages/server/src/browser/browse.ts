// browse 工具执行器（路线 2 PRD §二/§4.1-4.4/§五）：会话解析（taskId→store / _web、ziniao 守卫）、
// 模块级连接表（key→CdpConnection）、per-key tab 状态（activeTargetId + LRU，上限 12）、
// 五工具（navigate/tabs/read/act/eval）语义。
// 语义来源：docs/route2-browser-tools-prd.md + 参考仓库 _reference/vibe-seller-src/app/browser/
// wrapper.py 与 cdp_mux_proxy.py 的单客户端化——原 1700 行 mux 源于"多个 daemon 共享一个 Chrome"，
// TS 侧每浏览器会话恰好单客户端（本执行器独占连接），mux / wrapper 生成 / daemon 整体不需要。
// 铁律（PRD §4.2）："绝不自动重试已发出的变异命令"由两层共同保证——连接层断连即整体作废
//（cdp.ts），调用纪律层本文件任何失败一律 throw 交由上层转 error status，绝不原地重发。
// 安全面：连接 URL/端口只来自 starter（服务端），工具参数面没有它们；不加 URL 白名单
//（PRD §七.8），仅保留 scheme 守卫（§5.2：file://、chrome:// 不进导航）。
// 零新依赖（宪法第 4 条）：CDP 走内建 CdpConnection（Node 全局 WebSocket + fetch）。

import type { DatabaseSync } from "node:sqlite";
import { CdpConnection, type CdpConnectionDeps, type CdpTargetInfo } from "./cdp";

// ── 公开面 ──

/** 五个 browse 原生工具名（T4 注册/可见性面的名称来源）。 */
export const BROWSE_TOOL_NAMES = [
  "vibe_seller_browser_navigate",
  "vibe_seller_browser_tabs",
  "vibe_seller_browser_read",
  "vibe_seller_browser_act",
  "vibe_seller_browser_eval",
] as const;

export type BrowseToolName = (typeof BROWSE_TOOL_NAMES)[number];

function isBrowseToolName(name: string): name is BrowseToolName {
  return (BROWSE_TOOL_NAMES as readonly string[]).includes(name);
}

/** starter 的最小结构面（生产传 BrowserStarter；测试注假 starter）。 */
export interface BrowseStarterPort {
  ensureStoreChrome(store: { id: string; name: string }, headless: boolean): Promise<{ cdpPort: number }>;
  ensureWebChrome(headless: boolean): Promise<{ cdpPort: number }>;
}

export interface BrowseToolkitDeps {
  db: DatabaseSync;
  starter: BrowseStarterPort;
  headless: () => boolean;
}

export interface BrowseToolkitOpts {
  /** 单次工具调用硬预算，缺省 120_000ms（PRD §4.2，原版 wrapper alarm 120s 语义）。 */
  callBudgetMs?: number;
  // —— 以下仅测试注入口（生产不传）——
  /** CdpConnection.overPort 注入（假 fetch / 假传输），零真网测试。 */
  connectionDeps?: CdpConnectionDeps;
  /** navigate 载入等待上限（生产恒 30_000ms，PRD §二）。 */
  loadTimeoutMs?: number;
}

// ── 模块级状态（key = store_id 或 '_web'，进程内共享；PRD §4.1 连接表 / §4.3 tab 态） ──

const WEB_KEY = "_web";
const DEFAULT_BUDGET_MS = 120_000;
const LOAD_TIMEOUT_MS = 30_000;
const TAB_CAP = 12; // 原版 VIBE_TAB_CAP
const WAIT_CAP_MS = 120_000;
const WAIT_POLL_MS = 250;
const EVAL_TEXT_DEFAULT = 20_000;
const EVAL_TEXT_CAP = 100_000;
const READ_TEXT_DEFAULT = 8_000;
const READ_TEXT_CAP = 50_000;
const READ_HTML_DEFAULT = 20_000;
const READ_HTML_CAP = 100_000;

/** 会话 key → CDP 连接；断连 onClose 自动逐出（懒恢复：下次调用重建）。 */
const connections = new Map<string, CdpConnection>();
/** 会话 key → 建连所用端口（端口漂移 = 浏览器被拉新 → 旧连接作废重连）。 */
const portsByKey = new Map<string, number>();
/** per-key 建连互斥（CDP browser 级端点单客户端，避免同 key 双连）。 */
const connecting = new Map<string, Promise<CdpConnection>>();

interface TabState {
  activeTargetId: string | null;
  /** LRU：Map 插入序 = 最久未用在前；值 = 最近使用时刻。 */
  lru: Map<string, number>;
}
const tabStates = new Map<string, TabState>();

/** target → sessionId 缓存，挂在连接实例上（WeakMap）：断连重建后自然失效重挂。 */
const sessionCache = new WeakMap<CdpConnection, Map<string, string>>();

/** 测试隔离口：清空模块级连接表与 tab 状态（先关连接，触发逐出回调无副作用）。 */
export function resetBrowseStateForTests(): void {
  for (const conn of connections.values()) conn.close();
  connections.clear();
  portsByKey.clear();
  connecting.clear();
  tabStates.clear();
}

// ── 连接表与 tab 状态 helpers ──

function tabStateOf(key: string): TabState {
  let s = tabStates.get(key);
  if (!s) {
    s = { activeTargetId: null, lru: new Map() };
    tabStates.set(key, s);
  }
  return s;
}

function touchTab(key: string, targetId: string): void {
  const s = tabStateOf(key);
  s.lru.delete(targetId); // 删除再插入 = 移到 LRU 尾（最新）
  s.lru.set(targetId, Date.now());
}

async function getConnection(key: string, port: number, deps?: CdpConnectionDeps): Promise<CdpConnection> {
  const existing = connections.get(key);
  if (existing && !existing.isClosed && portsByKey.get(key) === port) return existing;
  if (existing && !existing.isClosed) existing.close(); // 端口已变：旧端点连接整体作废
  const inFlight = connecting.get(key);
  if (inFlight) return inFlight;
  const p = CdpConnection.overPort(port, deps)
    .then((conn) => {
      // 断连即逐出（仅当连接表仍持有本条——新连接可能已顶替）
      conn.onClose(() => {
        if (connections.get(key) === conn) connections.delete(key);
      });
      connections.set(key, conn);
      portsByKey.set(key, port);
      return conn;
    })
    .finally(() => {
      connecting.delete(key);
    });
  connecting.set(key, p);
  return p;
}

async function attachToTab(conn: CdpConnection, targetId: string): Promise<string> {
  let cache = sessionCache.get(conn);
  if (!cache) {
    cache = new Map();
    sessionCache.set(conn, cache);
  }
  const hit = cache.get(targetId);
  if (hit !== undefined) return hit;
  const sessionId = await conn.attachToTarget(targetId);
  cache.set(targetId, sessionId);
  return sessionId;
}

/** 会话内默认寻址（PRD §4.3）：活跃 tab 仍存在 → 用它；否则取第一个页型；空 → 新开
 *（createUrl 给定时带着目标 url 开，对齐"无活跃 tab → createTarget(url)"，缺省 about:blank）。 */
async function resolveTab(conn: CdpConnection, key: string, createUrl?: string): Promise<{ targetId: string; targets: CdpTargetInfo[] }> {
  const state = tabStateOf(key);
  const targets = await conn.getTargets();
  if (state.activeTargetId && targets.some((t) => t.targetId === state.activeTargetId)) {
    touchTab(key, state.activeTargetId);
    return { targetId: state.activeTargetId, targets };
  }
  if (targets.length > 0) {
    const first = targets[0]!;
    state.activeTargetId = first.targetId;
    touchTab(key, first.targetId);
    return { targetId: first.targetId, targets };
  }
  const tid = await conn.createTarget(createUrl); // 永不关最后一个：浏览器至少保一个页型 tab
  state.activeTargetId = tid;
  touchTab(key, tid);
  return { targetId: tid, targets };
}

/** 显式寻址（read/act/eval 可选 tab_id）：只作用于本次调用，不改活跃（PRD §4.3/§九.1）。 */
async function resolveTargetId(
  conn: CdpConnection,
  key: string,
  args: Record<string, unknown>,
): Promise<{ targetId: string; targets: CdpTargetInfo[] }> {
  const explicit = args["tab_id"];
  if (explicit === undefined || explicit === null || explicit === "") return resolveTab(conn, key);
  if (typeof explicit !== "string") throw new Error(`tab_id must be a string (got ${typeof explicit}).`);
  const targets = await conn.getTargets();
  if (!targets.some((t) => t.targetId === explicit)) {
    throw new Error(`tab_id "${explicit}" not found among page tabs; use the tabs tool with action "list".`);
  }
  touchTab(key, explicit);
  return { targetId: explicit, targets };
}

/** tab LRU（PRD §4.3）：新开 tab 后页型数超 12 → 关最久未用的非活跃；永不关最后一个页型 tab。 */
async function enforceTabCap(conn: CdpConnection, key: string): Promise<void> {
  const state = tabStateOf(key);
  const targets = await conn.getTargets();
  const live = new Set(targets.map((t) => t.targetId));
  for (const tid of [...state.lru.keys()]) {
    if (!live.has(tid)) state.lru.delete(tid); // 外部已关的 tab 清出 LRU
  }
  for (const t of targets) {
    if (!state.lru.has(t.targetId)) state.lru.set(t.targetId, 0); // 未知 tab 视作最旧候选
  }
  let alive = targets.length;
  for (const [tid] of [...state.lru]) {
    if (alive <= TAB_CAP || alive <= 1) break; // 永不关最后一个页型 tab
    if (tid === state.activeTargetId) continue; // 活跃豁免（即使它 LRU 最旧）
    await conn.closeTarget(tid);
    state.lru.delete(tid);
    alive -= 1;
  }
}

// ── evaluate 与截断 helpers ──

interface EvalOutcome {
  value: unknown;
  /** CDP 结果对象里是否带 value 键（undefined / 不可序列化时缺省）。 */
  hasValue: boolean;
  description?: string;
}

/** Runtime.evaluate（一律 returnByValue:true；awaitPromise:true 兼容异步表达式）。 */
async function evalJs(conn: CdpConnection, sessionId: string, expression: string): Promise<EvalOutcome> {
  const res = (await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, { sessionId })) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string; message?: string } };
  } | null;
  if (res?.exceptionDetails) {
    const d = res.exceptionDetails;
    const text = d.exception?.description ?? d.exception?.message ?? d.text ?? "unknown page exception";
    throw new Error(`eval failed: ${text}`);
  }
  const r = res?.result;
  return { value: r?.value, hasValue: r != null && "value" in r, description: r?.description };
}

interface TruncatedText {
  text: string;
  truncated: boolean;
  total_length: number;
}

function truncateString(text: string, maxChars: number): TruncatedText {
  if (text.length <= maxChars) return { text, truncated: false, total_length: text.length };
  return { text: text.slice(0, maxChars), truncated: true, total_length: text.length };
}

/** max_chars 归一：缺省值 / 上限截断（防上下文爆炸，PRD §二）。 */
function maxCharsOf(args: Record<string, unknown>, def: number, cap: number): number {
  const n = args["max_chars"];
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), cap);
}

function selectorOf(args: Record<string, unknown>): string | null {
  const s = args["selector"];
  return typeof s === "string" && s.length > 0 ? s : null;
}

function requireSelector(args: Record<string, unknown>, action: string): string {
  const s = selectorOf(args);
  if (!s) throw new Error(`act ${action} requires selector (string).`);
  return s;
}

/** 页面内取元素中心点：scrollIntoView 居中 + getBoundingClientRect（坐标点击单处实现）。 */
async function centerOf(conn: CdpConnection, sessionId: string, action: string, selector: string): Promise<{ x: number; y: number }> {
  const expression = `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); var r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
  const out = await evalJs(conn, sessionId, expression);
  const v = out.value as { x?: unknown; y?: unknown } | null;
  if (v == null || typeof v.x !== "number" || typeof v.y !== "number") {
    throw new Error(`act ${action} failed: no element matches selector ${JSON.stringify(selector)}.`);
  }
  return { x: v.x, y: v.y };
}

/** press 支持键的小映射表（key/code/windowsVirtualKeyCode/text）。 */
const KEY_SPECS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 硬预算（PRD §4.2）：到点即拒绝；底层操作无法取消，但绝不重试，由上层转 error status。 */
function withBudget<T>(budgetMs: number, name: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Browse tool call "${name}" exceeded its ${budgetMs}ms hard budget (default 120s); the call was aborted, not retried.`));
    }, budgetMs);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ── 执行器 ──

/** browse 五工具执行器：每 run 一个实例（taskId 定会话解析），连接/tab 态为模块级共享。 */
export class BrowseToolkit {
  private readonly budgetMs: number;
  private readonly loadMs: number;
  private readonly connDeps: CdpConnectionDeps | undefined;

  constructor(
    private readonly deps: BrowseToolkitDeps,
    private readonly taskId: string,
    opts: BrowseToolkitOpts = {},
  ) {
    this.budgetMs = opts.callBudgetMs ?? DEFAULT_BUDGET_MS;
    this.loadMs = opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.connDeps = opts.connectionDeps;
  }

  /** 唯一入口：仅接受五个已知名；整体套硬预算；失败一律 throw（上层 catch 转 error status）。 */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isBrowseToolName(name)) {
      throw new Error(`Unknown browse tool: ${JSON.stringify(name)}. Supported: ${BROWSE_TOOL_NAMES.join(", ")}`);
    }
    const safeArgs = args ?? {};
    return withBudget(this.budgetMs, name, () => this.dispatch(name, safeArgs));
  }

  private async dispatch(name: BrowseToolName, args: Record<string, unknown>): Promise<unknown> {
    this.validateArgs(name, args); // 参数面校验先行：绝不为此碰 starter / 发 CDP 帧
    const session = await this.resolveSession(args);
    const conn = await getConnection(session.key, session.port, this.connDeps);
    switch (name) {
      case "vibe_seller_browser_navigate":
        return this.navigate(conn, session.key, args);
      case "vibe_seller_browser_tabs":
        return this.tabs(conn, session.key, args);
      case "vibe_seller_browser_read":
        return this.read(conn, session.key, args);
      case "vibe_seller_browser_act":
        return this.act(conn, session.key, args);
      case "vibe_seller_browser_eval":
        return this.evalTool(conn, session.key, args);
    }
  }

  /** 参数面校验（scheme 守卫等，PRD §5.2）：失败不产生任何外部副作用。 */
  private validateArgs(name: BrowseToolName, args: Record<string, unknown>): void {
    switch (name) {
      case "vibe_seller_browser_navigate": {
        if (typeof args["url"] !== "string" || (args["url"] as string).length === 0) {
          throw new Error("navigate requires url (non-empty string).");
        }
        if (!/^https?:\/\//.test(args["url"] as string)) {
          throw new Error(
            `navigate refused: url scheme must be http:// or https:// (got ${JSON.stringify(args["url"])}); file:// and chrome:// URLs are not allowed.`,
          );
        }
        return;
      }
      case "vibe_seller_browser_tabs": {
        const a = args["action"];
        if (a !== "list" && a !== "switch" && a !== "close") {
          throw new Error(`tabs requires action "list" | "switch" | "close" (got ${JSON.stringify(a)}).`);
        }
        return;
      }
      case "vibe_seller_browser_read": {
        const m = args["mode"];
        if (m !== "info" && m !== "text" && m !== "html") {
          throw new Error(`read requires mode "info" | "text" | "html" (got ${JSON.stringify(m)}).`);
        }
        return;
      }
      case "vibe_seller_browser_act": {
        const supported = ["click", "hover", "type", "press", "select", "scroll", "wait"] as const;
        if (!(supported as readonly string[]).includes(args["action"] as string)) {
          throw new Error(`act requires one action of: ${supported.join("/")} (got ${JSON.stringify(args["action"])}).`);
        }
        return;
      }
      case "vibe_seller_browser_eval": {
        if (typeof args["expression"] !== "string" || (args["expression"] as string).length === 0) {
          throw new Error("eval requires expression (non-empty string).");
        }
        return;
      }
    }
  }

  /** 会话解析（PRD §4.1，服务端解析——agent 永不传 URL/端口）。 */
  private async resolveSession(args: Record<string, unknown>): Promise<{ key: string; port: number }> {
    const session = args["session"] === undefined ? "store" : args["session"];
    if (session !== "store" && session !== "web") {
      throw new Error(`Invalid session ${JSON.stringify(session)}: expected "store" or "web".`);
    }
    if (session === "web") {
      const { cdpPort } = await this.deps.starter.ensureWebChrome(this.deps.headless());
      return { key: WEB_KEY, port: cdpPort };
    }
    const taskRow = this.deps.db.prepare("SELECT store_id FROM tasks WHERE id = ?").get(this.taskId) as
      | { store_id: string | null }
      | undefined;
    if (!taskRow || taskRow.store_id == null) {
      throw new Error(`Task ${this.taskId} has no bound store; bind a store to the task or pass session:"web".`);
    }
    const storeRow = this.deps.db.prepare("SELECT id, name, browser_backend FROM stores WHERE id = ?").get(taskRow.store_id) as
      | { id: string; name: string; browser_backend: string | null }
      | undefined;
    if (!storeRow) {
      throw new Error(`Store ${taskRow.store_id} (bound to task ${this.taskId}) does not exist.`);
    }
    if (storeRow.browser_backend === "ziniao") {
      // PRD §5.1 边界裁决：结构化错误，绝不 spawn 无登录态替代 Chrome（会静默产出错误数据）
      throw new Error(
        `Store "${storeRow.name}" uses the ziniao anti-detect browser backend, which browser tools do not support; CDP direct connect covers chrome-backend stores and the web session only.`,
      );
    }
    const { cdpPort } = await this.deps.starter.ensureStoreChrome({ id: storeRow.id, name: storeRow.name }, this.deps.headless());
    return { key: storeRow.id, port: cdpPort };
  }

  // ── 1. navigate ──

  private async navigate(conn: CdpConnection, key: string, args: Record<string, unknown>): Promise<unknown> {
    const url = args["url"] as string;
    const state = tabStateOf(key);
    let targetId: string;
    if (args["new_tab"] === true) {
      targetId = await conn.createTarget(url);
      touchTab(key, targetId); // 新 tab 先进 LRU 最新位：cap 关闭永不波及刚开的 tab
      await enforceTabCap(conn, key); // 此刻活跃仍指旧 tab——"活跃不被关"豁免有真实语义
      state.activeTargetId = targetId; // cap 收拾完再切活跃
    } else {
      targetId = (await resolveTab(conn, key, url)).targetId; // 无活跃 tab 时带着 url 新开（PRD §二）
    }
    const sessionId = await attachToTab(conn, targetId);
    await conn.send("Page.enable", undefined, { sessionId });
    // 先订阅再发导航（快页面的 load 事件不早于订阅丢失）；至多 loadMs（30s）——超时不 throw
    let loaded = false;
    let settleLoad: () => void = () => {};
    const loadP = new Promise<void>((r) => (settleLoad = r));
    const onLoad = (): void => {
      loaded = true;
      settleLoad();
    };
    conn.on("Page.loadEventFired", onLoad, { sessionId });
    const loadTimer = setTimeout(() => settleLoad(), this.loadMs);
    try {
      await conn.send("Page.navigate", { url }, { sessionId }); // CDP error（如非法 URL）照常 throw
      await loadP;
    } finally {
      clearTimeout(loadTimer);
      conn.off("Page.loadEventFired", onLoad, { sessionId });
    }
    // 载入后取 location.href + document.title（经 JSON.stringify 协议返回，PRD §二）
    let finalUrl = url;
    let title = "";
    try {
      const out = await evalJs(conn, sessionId, "JSON.stringify({ href: location.href, title: document.title })");
      if (typeof out.value === "string") {
        const parsed = JSON.parse(out.value) as { href?: unknown; title?: unknown };
        if (typeof parsed.href === "string") finalUrl = parsed.href;
        if (typeof parsed.title === "string") title = parsed.title;
      }
    } catch {
      // href/title 取不到不致命（如 load 超时的慢页面）：返回请求 url 与空 title
    }
    if (key !== WEB_KEY) {
      // store 会话 navigate 成功后落 current_url（列已存在，纯 UPDATE，无 schema 变更，PRD §4.3）
      this.deps.db
        .prepare("UPDATE browser_sessions SET current_url = ?, updated_at = ? WHERE store_id = ?")
        .run(finalUrl, new Date().toISOString(), key);
    }
    return { tab_id: targetId, url: finalUrl, title, load_state: loaded ? "loaded" : "timeout" };
  }

  // ── 2. tabs ──

  private async tabs(conn: CdpConnection, key: string, args: Record<string, unknown>): Promise<unknown> {
    const action = args["action"] as string;
    const state = tabStateOf(key);
    if (action === "list") {
      const targets = await conn.getTargets();
      return {
        ok: true,
        tabs: targets.map((t) => ({
          tab_id: t.targetId,
          url: t.url,
          title: t.title,
          active: t.targetId === state.activeTargetId,
        })),
      };
    }
    if (action === "switch") {
      const tabId = args["tab_id"];
      if (typeof tabId !== "string" || tabId.length === 0) throw new Error('tabs switch requires tab_id (string).');
      const targets = await conn.getTargets();
      if (!targets.some((t) => t.targetId === tabId)) {
        throw new Error(`tab_id "${tabId}" not found among page tabs; use action "list".`);
      }
      state.activeTargetId = tabId;
      touchTab(key, tabId);
      return { ok: true, active_tab_id: tabId };
    }
    // close（校验面保证 action 只剩 close）
    const targets = await conn.getTargets();
    if (targets.length <= 1) {
      throw new Error("refuse to close the last tab: a browser session must keep at least one page tab.");
    }
    const tabId = typeof args["tab_id"] === "string" && args["tab_id"] !== "" ? (args["tab_id"] as string) : state.activeTargetId;
    if (!tabId || !targets.some((t) => t.targetId === tabId)) {
      throw new Error(`tab_id ${JSON.stringify(tabId ?? null)} not found among page tabs; use action "list".`);
    }
    await conn.closeTarget(tabId);
    state.lru.delete(tabId);
    if (state.activeTargetId !== tabId) {
      return { ok: true, closed_tab_id: tabId, active_tab_id: state.activeTargetId };
    }
    // 关的是活跃 tab：活跃顺延到最近未用的剩余 tab（LRU 尾先看），退化取列表第一个
    const remaining = targets.filter((t) => t.targetId !== tabId);
    let pick: string | null = null;
    for (const tid of [...state.lru.keys()].reverse()) {
      if (remaining.some((t) => t.targetId === tid)) {
        pick = tid;
        break;
      }
    }
    const newActive = pick ?? remaining[0]?.targetId ?? null;
    state.activeTargetId = newActive;
    if (newActive) touchTab(key, newActive);
    return { ok: true, closed_tab_id: tabId, active_tab_id: newActive };
  }

  // ── 3. read ──

  private async read(conn: CdpConnection, key: string, args: Record<string, unknown>): Promise<unknown> {
    const mode = args["mode"] as string;
    const { targetId, targets } = await resolveTargetId(conn, key, args);
    if (mode === "info") {
      const t = targets.find((x) => x.targetId === targetId);
      return { tab_id: targetId, url: t?.url ?? "", title: t?.title ?? "" };
    }
    const sessionId = await attachToTab(conn, targetId);
    const selector = selectorOf(args);
    const expression =
      mode === "text"
        ? selector
          ? `document.querySelector(${JSON.stringify(selector)})?.innerText`
          : 'document.body?.innerText ?? ""'
        : selector
          ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML`
          : 'document.body?.outerHTML ?? ""';
    const out = await evalJs(conn, sessionId, expression);
    if (out.value == null) {
      throw new Error(`read ${mode} failed: no element matches selector ${JSON.stringify(selector ?? "")}.`);
    }
    const maxChars =
      mode === "text" ? maxCharsOf(args, READ_TEXT_DEFAULT, READ_TEXT_CAP) : maxCharsOf(args, READ_HTML_DEFAULT, READ_HTML_CAP);
    return truncateString(String(out.value), maxChars);
  }

  // ── 4. act（单动作，一次一个工作单元） ──

  private async act(conn: CdpConnection, key: string, args: Record<string, unknown>): Promise<unknown> {
    const action = args["action"] as string;
    const { targetId } = await resolveTargetId(conn, key, args);
    const sessionId = await attachToTab(conn, targetId);
    switch (action) {
      case "click":
      case "hover": {
        const { x, y } = await centerOf(conn, sessionId, action, requireSelector(args, action));
        await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { sessionId });
        if (action === "hover") return { ok: true, action, x, y };
        await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, { sessionId });
        await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, { sessionId });
        return { ok: true, action, x, y };
      }
      case "type": {
        const text = args["text"];
        if (typeof text !== "string") throw new Error("act type requires text (string).");
        const selector = selectorOf(args);
        if (selector) {
          // 聚焦目标走 click 同路径（PRD §4.4）
          const { x, y } = await centerOf(conn, sessionId, action, selector);
          await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { sessionId });
          await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, { sessionId });
          await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, { sessionId });
        }
        await conn.send("Input.insertText", { text }, { sessionId });
        return { ok: true, action, length: text.length };
      }
      case "press": {
        const k = typeof args["key"] === "string" ? (args["key"] as string) : "";
        const spec = KEY_SPECS[k];
        if (!spec) {
          throw new Error(`press: unsupported key ${JSON.stringify(k)}. Supported keys: ${Object.keys(KEY_SPECS).join(", ")}.`);
        }
        const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, ...(spec.text ? { text: spec.text } : {}) };
        await conn.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, { sessionId });
        await conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, { sessionId });
        return { ok: true, action, key: k };
      }
      case "select": {
        const selector = requireSelector(args, "select");
        const value = args["value"];
        if (typeof value !== "string") throw new Error("act select requires value (string).");
        // 原生 setter 赋值 + input/change 事件派发（React 受控组件兼容，PRD §4.4）
        const expression = `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value") || Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value"); if (!desc || !desc.set) return null; desc.set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { value: el.value }; })()`;
        const out = await evalJs(conn, sessionId, expression);
        if (out.value == null) {
          throw new Error(`act select failed: no element matches selector ${JSON.stringify(selector)}.`);
        }
        return { ok: true, action, value: (out.value as { value?: unknown }).value };
      }
      case "scroll": {
        const dx = typeof args["dx"] === "number" ? (args["dx"] as number) : 0;
        const dy = typeof args["dy"] === "number" ? (args["dy"] as number) : 600;
        const out = await evalJs(conn, sessionId, "({ x: window.innerWidth / 2, y: window.innerHeight / 2 })");
        const c = (out.value ?? {}) as { x?: unknown; y?: unknown };
        const x = typeof c.x === "number" ? c.x : 0;
        const y = typeof c.y === "number" ? c.y : 0;
        await conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy }, { sessionId });
        return { ok: true, action, deltaX: dx, deltaY: dy };
      }
      default:
        return this.wait(conn, sessionId, args); // "wait"
    }
  }

  /** wait：selector → 每 250ms evaluate 探测非空（上限 min(timeout_ms ?? ms ?? 10s, 120s)）；
   * 无 selector → 纯延时 ms（≤120s）。从不 throw 超时（found:false 表达）。 */
  private async wait(conn: CdpConnection, sessionId: string, args: Record<string, unknown>): Promise<unknown> {
    const num = (k: string): number | null => {
      const v = args[k];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const started = Date.now();
    const selector = selectorOf(args);
    if (!selector) {
      const ms = Math.min(num("ms") ?? 0, WAIT_CAP_MS);
      if (ms > 0) await delay(ms);
      return { ok: true, action: "wait", elapsed_ms: Date.now() - started };
    }
    const cap = Math.min(num("timeout_ms") ?? num("ms") ?? 10_000, WAIT_CAP_MS);
    const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
    for (;;) {
      const out = await evalJs(conn, sessionId, expression);
      if (out.value === true) return { ok: true, action: "wait", found: true, elapsed_ms: Date.now() - started };
      const elapsed = Date.now() - started;
      const remaining = cap - elapsed;
      if (remaining <= 0) return { ok: true, action: "wait", found: false, elapsed_ms: elapsed };
      await delay(Math.min(WAIT_POLL_MS, remaining));
    }
  }

  // ── 5. eval ──

  private async evalTool(conn: CdpConnection, key: string, args: Record<string, unknown>): Promise<unknown> {
    const expression = args["expression"] as string;
    const { targetId } = await resolveTargetId(conn, key, args);
    const sessionId = await attachToTab(conn, targetId);
    const out = await evalJs(conn, sessionId, expression);
    if (!out.hasValue) {
      // 不可序列化（函数/Symbol 等）：value 键缺省但有 description → 退化为文本
      return { text: out.description ?? "undefined", truncated: false };
    }
    return truncateString(JSON.stringify(out.value ?? null), maxCharsOf(args, EVAL_TEXT_DEFAULT, EVAL_TEXT_CAP));
  }
}
