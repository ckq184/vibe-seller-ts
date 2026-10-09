// 批次 4.7.3 前端零改动 e2e 的 Playwright 配置。
// 与 vitest 套件完全分离：testMatch 只收 *.e2e.ts（vitest include 是
// packages/**/*.test.ts，互不重叠）；单 worker 串行，server 由 e2e 内部
// 以真端口拉起（packages/server/e2e/server.ts），不用 webServer 常驻进程——
// 服务端断言（bus 订阅数 / db 行 / telemetry locale）需要进程内引用。

import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// e2e 属测试 runner 环境：显式置 NODE_ENV=test，让 server 遥测 init 被
// runningUnderTestRunner 门控拦下（telemetry/core.ts，与 vitest 同一门控语义）
// ——服务端零外呼，配合浏览器侧的外部请求拦截共同守住零真网红线。
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

export default defineConfig({
  testDir: "./packages/server/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1, // server/browser 为模块级单例，必须单 worker 串行
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // 失败现场（error-context 等）写到系统临时目录，不在共享仓库里留 untracked 文件
  outputDir: join(tmpdir(), "vibe-e2e-results"),
  use: { actionTimeout: 15_000, navigationTimeout: 20_000 },
});
