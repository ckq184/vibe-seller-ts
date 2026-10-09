// 批次 4.7.3 前端零改动 e2e（PRD §5）；5.3 起驱动 vendor 进本仓的 frontend/
// 构建产物（FRONTEND_DIST 默认 = <repoRoot>/frontend/dist，e2e/server.ts）。
// 真 Chrome（channel:'chrome'，失败退化 Playwright chromium，均不可用则显式
// skip）驱动原 React 19 前端打 TS server 真端口。
//
// 五步断言全部以用户可见结果为准（元素出现 / 接口 200），选择器走语义角色 /
// text / placeholder（en locale），不对前端内部实现做脆弱断言（前端唯一允许的
// 稳定锚点是 i18n 文案本身）。
//
// 红线：
//   - 运行时零新依赖：playwright 仅 devDependency；本套件不进默认 vitest
//    （文件名 *.e2e.ts 不匹配 vitest include 的 packages/**/*.test.ts）。
//   - 零真网：浏览器侧拦截一切非 127.0.0.1 请求（前端内置 posthog →
//     t.vibe-sellers.com 一律 abort）；服务端遥测被 NODE_ENV=test 门控
//    （playwright.config.ts）不建客户端。
//   - 前端零改动：5.3 起语义 = vendor 树与参考仓库哈希清单逐一 diff 为空
//    （packages/server/test/frontend-vendor.test.ts 机器门禁）；构建产物
//    frontend/dist 允许重建。server 对该目录只读。
//
// 注意：不使用 Playwright 内置 browser/context/page fixture——它们会拉起
// Playwright 自带 chromium（本仓库不下载浏览器，必失败）；context/page 一律
// 从 beforeAll 自建的浏览器实例手动派生。
//
// 跳过条件（PRD §5.2）：dist 缺失 / 浏览器全不可用 → skip 并输出明确原因。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { FRONTEND_DIST, startE2eServer, type E2eServer } from "./server";
import * as telemetry from "../src/telemetry/core";

// en locale 文案锚点（frontend/src/i18n/locales/en/translation.json，vendor 源）。
const en = {
  identifierPlaceholder: "Username or email",
  passwordPlaceholder: "Enter your password",
  signIn: "Sign In",
  allStores: "All Stores",
  settings: "Settings",
  generalTab: "General",
  privacy: "Privacy",
  telemetryTitle: "Anonymous usage telemetry",
};

test.describe("前端零改动 e2e（vendor 前端构建产物 × TS server 真端口）", () => {
  let server: E2eServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let skipReason = "";

  test.beforeAll(async () => {
    if (!existsSync(join(FRONTEND_DIST, "index.html"))) {
      skipReason = `frontend dist 不存在：${FRONTEND_DIST}（PRD §5 跳过条件 1）`;
      return;
    }
    server = await startE2eServer();
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true }); // 系统 Chrome，免下载浏览器
    } catch (chromeErr) {
      try {
        browser = await chromium.launch({ headless: true }); // 退化：Playwright 自带 chromium
      } catch (chromiumErr) {
        skipReason =
          `系统 Chrome 与 Playwright chromium 均不可用（PRD §5 跳过条件 2）：` +
          `chrome=${(chromeErr as Error).message.split("\n")[0]}; ` +
          `chromium=${(chromiumErr as Error).message.split("\n")[0]}`;
      }
    }
  });

  test.afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  // 每个用例独立 context（手动派生，不碰内置 fixture）：置 skip 条件 +
  // 零真网拦截（外呼只放行 127.0.0.1）。
  test.beforeEach(async () => {
    test.skip(!browser || !server, skipReason || "browser/server unavailable");
    context = await browser!.newContext();
    await context.route(/^https?:\/\//, (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === "127.0.0.1") return route.continue();
      return route.abort(); // 前端 posthog → t.vibe-sellers.com 等外呼一律拦
    });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context?.close();
    context = null;
    page = null;
  });

  /** 服务端状态轮询（进程内 db / telemetry 单例，浏览器异步上报有延迟）。 */
  async function waitForServerState(desc: string, probe: () => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (probe()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`服务端断言超时（${timeoutMs}ms）：${desc}`);
  }

  /** UI 登录流：表单填 admin 凭据提交 → 侧栏用户标识出现（登录成功的稳定特征）。 */
  async function login(pg: Page): Promise<void> {
    await pg.goto(`${server!.baseUrl}/`);
    await pg.getByPlaceholder(en.identifierPlaceholder).fill(server!.adminUsername);
    await pg.getByPlaceholder(en.passwordPlaceholder).fill(server!.adminPassword);
    await pg.getByRole("button", { name: en.signIn }).click();
    await expect(pg.getByText("admin (admin)")).toBeVisible();
  }

  test("a. `/` 回 index.html 且 JS/CSS 资产 200；深链直接打开也由 SPA fallback 接住", async () => {
    const pg = page!;
    // 服务端：/ 返回 index.html
    const index = await pg.request.get(`${server!.baseUrl}/`);
    expect(index.status()).toBe(200);
    expect(index.headers()["content-type"]).toContain("text/html");
    const html = await index.text();
    expect(html).toContain('<div id="root">');
    // 打包资产（index.html 引用的 js + css）逐个 200 且 content-type 正确
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) {
      const res = await pg.request.get(`${server!.baseUrl}${asset}`);
      expect(res.status(), asset).toBe(200);
      expect(res.headers()["content-type"], asset).toMatch(/text\/javascript|text\/css/);
    }
    // 服务端：任意深链回 index.html（SPA fallback）；/api/ 未知路径仍 404 JSON
    const deep = await pg.request.get(`${server!.baseUrl}/settings/general`);
    expect(deep.status()).toBe(200);
    expect(deep.headers()["content-type"]).toContain("text/html");
    expect(await deep.text()).toContain('<div id="root">');
    const apiMiss = await pg.request.get(`${server!.baseUrl}/api/no-such-route`);
    expect(apiMiss.status()).toBe(404);
    // 浏览器：直接打开深链 → SPA 真渲染出登录页（不是 404 / 白屏）
    await pg.goto(`${server!.baseUrl}/settings/general`);
    await expect(pg).toHaveTitle("Vibe Seller");
    await expect(pg.getByPlaceholder(en.identifierPlaceholder)).toBeVisible();
  });

  test("b. 登录流：表单提交 admin 凭据 → 进入主界面", async () => {
    const pg = page!;
    await pg.goto(`${server!.baseUrl}/`);
    await expect(pg.getByRole("heading", { name: "Vibe Seller" })).toBeVisible(); // 登录页
    await pg.getByPlaceholder(en.identifierPlaceholder).fill(server!.adminUsername);
    await pg.getByPlaceholder(en.passwordPlaceholder).fill(server!.adminPassword);
    await pg.getByRole("button", { name: en.signIn }).click();
    // 登录后的稳定特征：侧栏用户标识 + 全部店铺任务面板 + /tasks 路由
    await expect(pg.getByText("admin (admin)")).toBeVisible();
    await expect(pg.getByRole("heading", { name: en.allStores })).toBeVisible();
    await expect(pg).toHaveURL(/\/tasks$/);
  });

  test("c. 数据面：店铺列表渲染真实后端数据（API 建店 → UI 可见可点进店）", async () => {
    const pg = page!;
    await login(pg);
    const storeName = `E2E 店铺 ${Date.now()}`;
    // API 种子（与 UI createStore 同端点同 payload；page.request 与浏览器共享 cookie）
    const created = await pg.request.post(`${server!.baseUrl}/api/stores`, {
      data: { name: storeName, browser_backend: "chrome" },
    });
    expect(created.status()).toBe(200);
    const store = (await created.json()) as { id: string; name: string };
    expect(store.id).toBeTruthy();
    // 用户可见 1：侧栏店铺列表出现该店（loadStores 真调 GET /api/stores）
    await pg.reload();
    const storeButton = pg.getByRole("button", { name: storeName });
    await expect(storeButton).toBeVisible();
    // 用户可见 2：点进店铺 → 店铺任务面板标题 = 店铺名（GET /api/tasks?store_id=…）
    await storeButton.click();
    await expect(pg.getByRole("heading", { name: storeName })).toBeVisible();
    await expect(pg).toHaveURL(new RegExp(`/stores/${store.id}$`));
  });

  test("d. 设置页：telemetry 开关可交互并写库；语言切换触发 /api/telemetry/locale", async () => {
    const pg = page!;
    await login(pg);
    // 顶栏齿轮（accessible name 来自 title="Settings"，admin 可见）→ 设置页 → General
    await pg.getByRole("button", { name: en.settings }).click();
    await pg.getByRole("button", { name: en.generalTab }).click();
    await expect(pg.getByRole("heading", { name: en.privacy })).toBeVisible();
    await expect(pg.getByText(en.telemetryTitle)).toBeVisible();

    // telemetry 开关：settings 无行 → 默认开；点击关 → PUT /api/settings →
    // 服务端 app_settings 行变 'false'（进程内 db 断言收到写）。
    // 点 label（真实用户点的是可见滑块，label 原生转发到 checkbox）。
    const telemetryRow = pg.locator("div.p-3.bg-gray-50", { hasText: en.telemetryTitle });
    const toggle = telemetryRow.getByRole("checkbox");
    await expect(toggle).toBeChecked();
    await telemetryRow.locator("label").click();
    await expect(toggle).not.toBeChecked(); // 用户可见：开关停在关
    await waitForServerState("app_settings.telemetry_enabled === 'false'", () => {
      const row = server!.db.prepare("SELECT value FROM app_settings WHERE key = 'telemetry_enabled'").get() as
        | { value: string }
        | undefined;
      return row?.value === "false";
    });

    // 语言切换 en→zh→en：按钮 accessible name = 可见文本（en 下显"中文"，
    // zh 下显"EN"），i18n 初始化与每次切换都会 POST /api/telemetry/locale，
    // 服务端 app_locale 跟随。
    const zhButton = pg.getByRole("button", { name: "中文", exact: true });
    await expect(zhButton).toBeVisible();
    await zhButton.click(); // → zh
    const enButton = pg.getByRole("button", { name: "EN", exact: true });
    await expect(enButton).toHaveText("EN"); // 用户可见：界面已切中文（按钮自显 EN）
    await waitForServerState(
      "telemetry.baseProperties().app_locale === 'zh'",
      () => telemetry.baseProperties().app_locale === "zh",
    );
    await enButton.click(); // → en
    await expect(pg.getByRole("button", { name: "中文", exact: true })).toBeVisible();
    await waitForServerState(
      "telemetry.baseProperties().app_locale === 'en'",
      () => telemetry.baseProperties().app_locale === "en",
    );
  });

  test("e. SSE：页面建立 /api/sse 订阅（服务端订阅者 ≥1），广播一条事件页面不崩", async () => {
    const pg = page!;
    await login(pg);
    // 服务端断言：浏览器的 EventSource 已被 bus 记为订阅者
    await waitForServerState("bus.subscriberCount() >= 1", () => server!.bus.subscriberCount() >= 1);
    // 触发一条广播（ping：前端 onmessage 明确忽略该类型）→ 页面仍可用（无崩溃/白屏）
    server!.bus.emit("ping", {});
    await expect(pg.getByText("admin (admin)")).toBeVisible();
    await expect(pg.getByRole("heading", { name: en.allStores })).toBeVisible();
  });
});
