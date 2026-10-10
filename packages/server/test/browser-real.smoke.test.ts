// 路线 2 PRD §8.3 / §六.11：真实浏览器按需冒烟（真 Chrome，headless）。
//
// 启动方式（本机需有 Chrome；零外网依赖——页面来自本地 node:http 静态服务）：
//   VIBE_BROWSER_SMOKE=1 npx vitest run packages/server/test/browser-real.smoke.test.ts
// 未设置 VIBE_BROWSER_SMOKE（或本机找不到 Chrome 可执行文件）时整组自动跳过——
// 非绕过：导航→读取→act→eval 的闭环逻辑已被 browser-browse.test.ts 的假 CDP 级测试
// 钉死，本冒烟只证明"真 Chrome 链路"（spawn → CDP ws → 真页面 DOM）打得通。
//
// 单用例端到端：tmp home + tmp sqlite（openDb/seed，chrome 后端店铺 + 绑定任务的
// task）→ 本地静态页（标题/标记文本/#btn 点击计数并改写 #out）→ 真 BrowserStarter
// 懒启动 headless Chrome → BrowseToolkit 走 navigate→read→act(click)→eval→回填
//（把 read 到的数据 + eval 结果 node:fs 直写 tmp home 下 stores/<slug>/SMOKE_RESULT.md
// ——workspace 回填的完整语义已由 write_workspace_file 既有测试钉死，此处只证
// "读到的数据能落盘"）。冷启动竞态按 PRD §5.2 处理：Chrome 开 CDP 端口约需 2s+，
// 首次调用允许一次连接错误，peekCdpPort 只读轮询待端口开后走第二次调用懒恢复。
// 清理：从 browser_sessions 读 chrome_pid 杀浏览器（Windows 下主进程死则渲染进程
// 随之退出）→ 关 http server → rm tmp 目录；全程容错（进程可能已退）。

import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, seed } from "../src/db";
import { hashPassword } from "../src/app";
import type { ServerConfig } from "../src/config";
import { BrowserStarter } from "../src/browser/starter";
import { BrowseToolkit, resetBrowseStateForTests } from "../src/browser/browse";

// ── Chrome 探测（starter.ts findChromeExecutable 同款顺序；找不到 → skip 而非 fail） ──

function probeChromePath(): string | null {
  const override = process.env["VIBE_CHROME_PATH"];
  if (override && existsSync(override)) return override;
  if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]]) {
      if (!base) continue;
      for (const rel of [["Google", "Chrome", "Application", "chrome.exe"], ["Chromium", "Application", "chrome.exe"]]) {
        const candidate = join(base, ...rel);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
  if (process.platform === "darwin") {
    const p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return existsSync(p) ? p : null;
  }
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of ["google-chrome", "chromium"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const chromePath = probeChromePath();

// ── 本地静态页（node:http，127.0.0.1 随机端口，零外网） ──

const MARKER = "ROUTE2_SMOKE_MARKER_8842";
const PAGE_TITLE = "VIBE_SMOKE_PAGE";

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body>
  <h1>${MARKER}</h1>
  <button id="btn">click me</button>
  <div id="out">not-clicked</div>
  <script>
    document.getElementById("btn").addEventListener("click", function () {
      window.clicked = (window.clicked || 0) + 1;
      document.getElementById("out").innerText = "clicked-" + window.clicked;
    });
  </script>
</body></html>`;

function startPageServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (port) resolve({ server, port });
      else reject(new Error("no free port for page server"));
    });
  });
}

/** 容错杀 Chrome：process.kill 失败（已退/权限）一律吞掉；等待进程真正退出（Windows
 * 渲染子进程随主进程退出，rm profile 前必须等句柄释放），最多 15s。 */
async function killChromeAndWait(pid: number | null | undefined): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    return; // 已退出
  }
  const deadline = Date.now() + 15_000;
  for (;;) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) return;
    if (Date.now() > deadline) return; // 等不到也放手：rm 用 force，不因清理失败染色用例
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── 夹具（模块级句柄：用例中途失败 afterAll 也要能清干净） ──

let dir: string | null = null;
let db: import("node:sqlite").DatabaseSync | null = null;
let pageServer: Server | null = null;
let chromePid: number | null | undefined;

const STORE_ID = "st-smoke";
const STORE_NAME = "smoke-store"; // 已是 slug 安全字符 → storeSlugOf 原样返回
const TASK_ID = "task-smoke";

afterAll(async () => {
  resetBrowseStateForTests(); // 关 CDP 连接（模块级连接表）
  await killChromeAndWait(chromePid); // browser_sessions.chrome_pid → 杀浏览器
  await new Promise<void>((r) => (pageServer ? pageServer.close(() => r()) : r()));
  try {
    db?.close();
  } catch {
    /* 已关 */
  }
  if (dir) rmSync(dir, { recursive: true, force: true }); // 浏览器死后才 rm（profile 句柄已释放）
});

describe.skipIf(!process.env.VIBE_BROWSER_SMOKE || !chromePath)("真实浏览器冒烟（真 Chrome × navigate→read→act→eval→回填）", () => {
  it(
    "本地静态页全链：导航载入 → 读到标记文本 → 点击计数连点两次 → 回填 SMOKE_RESULT.md 落盘",
    async () => {
      // 1) tmp home + tmp sqlite（chrome 后端店铺 + 绑定任务；status='completed' 不持有浏览器，
      //    绑定仅为 BrowseToolkit 的 taskId→store 解析）
      dir = await mkdtemp(join(tmpdir(), "vibe-browser-smoke-"));
      const config: ServerConfig = {
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
      db.prepare("INSERT INTO stores (id, name, browser_backend, created_at, updated_at) VALUES (?, ?, 'chrome', ?, ?)")
        .run(STORE_ID, STORE_NAME, now, now);
      db.prepare("INSERT INTO tasks (id, created_by, store_id, title, status, created_at, updated_at) VALUES (?, 'u', ?, '冒烟任务', 'completed', ?, ?)")
        .run(TASK_ID, STORE_ID, now, now);

      // 2) 本地静态页
      const page = await startPageServer();
      pageServer = page.server;
      const url = `http://127.0.0.1:${page.port}/`;

      // 3) 真 BrowserStarter（tmp home；headless 在冒烟下强制 true）+ 真 CDP 的 BrowseToolkit
      const starter = new BrowserStarter({ config, db });
      const toolkit = new BrowseToolkit({ db, starter, headless: () => true }, TASK_ID);

      // navigate → load_state "loaded" + title/url 正确。
      // 冷启动竞态（实测，PRD §5.2 明文许可面）：Chrome 从 spawn 到开出 CDP 端口约 2s+，
      // ensureStoreChrome 慢路径 spawn 后即返回 → 首次工具调用的 /json/version 可能
      // ECONNREFUSED，按 §5.2"本次返回连接错误；下次调用懒恢复"处理——用只读的
      // peekCdpPort 轮询等端口真正打开（绝不走 ensure：避免过早重试把未就绪 Chrome
      // kill 重拉的 churn），再走第二次 navigate（快路径 peek 命中 → 复用）。
      type NavResult = { tab_id: string; url: string; title: string; load_state: string };
      let nav: NavResult;
      try {
        nav = (await toolkit.execute("vibe_seller_browser_navigate", { url })) as NavResult;
      } catch (coldStartErr) {
        const msg = String((coldStartErr as Error).message ?? coldStartErr);
        if (!/fetch failed|ECONNREFUSED|json\/version/i.test(msg)) throw coldStartErr;
        const deadline = Date.now() + 30_000;
        let port: number | null = null;
        while (port === null && Date.now() < deadline) {
          port = await starter.peekCdpPort(STORE_ID);
          if (port === null) await new Promise((r) => setTimeout(r, 250));
        }
        if (port === null) throw coldStartErr; // 30s 仍无端口：如实失败
        nav = (await toolkit.execute("vibe_seller_browser_navigate", { url })) as NavResult;
      }

      // 会话行已落（ensureStoreChrome 慢路径写入）：先取 chrome_pid 供清理——
      // 故意放在断言之前，用例中途失败 afterAll 也能杀掉浏览器，不留进程泄漏
      const row = db.prepare("SELECT chrome_pid, cdp_port, status FROM browser_sessions WHERE store_id = ?").get(STORE_ID) as {
        chrome_pid: number | null; cdp_port: number | null; status: string;
      };
      expect(row.status).toBe("running");
      expect(row.cdp_port).toBeGreaterThan(0);
      chromePid = row.chrome_pid;

      expect(nav.load_state).toBe("loaded");
      expect(nav.title).toBe(PAGE_TITLE);
      expect(nav.url).toBe(url);

      // read text → 含标记文本
      const body = (await toolkit.execute("vibe_seller_browser_read", { mode: "text" })) as { text: string };
      expect(body.text).toContain(MARKER);

      // act click → eval window.clicked === 1（eval 返回 JSON 序列化文本）
      await toolkit.execute("vibe_seller_browser_act", { action: "click", selector: "#btn" });
      const c1 = (await toolkit.execute("vibe_seller_browser_eval", { expression: "window.clicked" })) as { text: string };
      expect(c1.text).toBe("1");

      // 点击后 DOM 变化可被 read 读到（PRD §六.7 真实冒烟语义）+ #out 文本翻转
      const out1 = (await toolkit.execute("vibe_seller_browser_read", { mode: "text", selector: "#out" })) as { text: string };
      expect(out1.text).toBe("clicked-1");

      // 再点一次 → 2（同一 tab 状态连续，非新开页面）
      await toolkit.execute("vibe_seller_browser_act", { action: "click", selector: "#btn" });
      const c2 = (await toolkit.execute("vibe_seller_browser_eval", { expression: "window.clicked" })) as { text: string };
      expect(c2.text).toBe("2");

      // 4) 回填腿：read 到的数据 + eval 结果直写 stores/<slug>/SMOKE_RESULT.md 并断言内容
      const resultDir = join(dir, "stores", STORE_NAME);
      mkdirSync(resultDir, { recursive: true });
      const resultPath = join(resultDir, "SMOKE_RESULT.md");
      writeFileSync(
        resultPath,
        [
          "# Route 2 真实浏览器冒烟回填",
          `- url: ${nav.url}`,
          `- title: ${nav.title}`,
          `- read 标记文本: ${MARKER}`,
          `- eval window.clicked: ${c1.text} -> ${c2.text}`,
          `- #out 文本: ${out1.text}`,
          "",
        ].join("\n"),
        "utf8",
      );
      const written = readFileSync(resultPath, "utf8");
      expect(written).toContain(MARKER);
      expect(written).toContain("1 -> 2");
      expect(written).toContain("clicked-1");
    },
    180_000, // 真 Chrome spawn + 页面载入，给足预算（对齐 real-provider.smoke 先例）
  );
});
