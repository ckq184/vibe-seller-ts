// 正式 server bundle（分发形态）：esbuild 单文件 → dist/server.mjs。
// 与 scripts/dev-start.mjs（5.2 临时 bundle，真依赖 external 留在本仓 node_modules
// 解析）的关键差异：release 树里没有 node_modules，必须全量内联（npm 真依赖 +
// @vibe/* TS 源一起打进单文件）；node:* 内置（含 node:sqlite）由 platform:"node"
// 自动 external，运行时用捆绑 node.exe 的内置实现（PRD §5.1 预裁决，≥22.5）。
//
// 遥测根包定位：telemetry/core.ts 从 bundle 真实位置逐级向上找 name ===
// "vibe-seller-ts" 的 package.json——dist/ 在仓库内，向上即本仓根 package.json；
// release/vibe-seller-ts/ 由 package 脚本随包放一份同 name/version 的 package.json
// （等价原 importlib.metadata 安装元数据），见 scripts/package-release.mjs。
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages", "server", "src", "main.ts");
const outfile = join(root, "dist", "server.mjs");

mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.5", // 分发底线 = 捆绑 node 版本要求（node:sqlite 首次可用版本）
  // 全量内联：不设 packages:"external"，npm 真依赖（hono/@hono/node-server/
  // bcryptjs/@earendil-works/* 等，均为纯 JS ESM）随 bundle 走，release 树零
  // node_modules。node:* 前缀内置模块由 esbuild 自动保持 external。
  //
  // CJS 依赖的动态 require 修复（实测 cross-spawn 运行时 require("child_process")）：
  // ESM 输出里 esbuild 的 __require shim 对 external 的动态 require 直接抛
  // "Dynamic require of ... is not supported"——shim 首选作用域里的 require，
  // banner 用 createRequire 造一个真 require 即可（esbuild#566 的标准做法，
  // 等价 CJS 语义：从 bundle 真实位置解析，release 树内置模块照常解析）。
  banner: {
    // 标识符用bundle 独有前缀：依赖树里已有顶层 `import { createRequire }`
    // （实测 jiti），banner 逐字注入在重命名之后，撞名即 SyntaxError。
    js: "import { createRequire as __vibeCreateRequire } from 'node:module';\nconst require = __vibeCreateRequire(import.meta.url);",
  },
  outfile,
  logLevel: "warning",
  sourcemap: false,
  minify: false,
});
console.log(`[build-server] bundle 写出：${outfile}`);
