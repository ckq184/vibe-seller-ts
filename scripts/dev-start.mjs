// 本机开发启动脚手架（npm start 的入口；零新依赖、零源码改动）。
// 分发形态是 Phase 5.3 的单文件 bundle（scripts/build.mjs），届时替换本脚手架。
//
// 为什么不是 PRD §4.3 预裁决的 `node --experimental-strip-types packages/server/src/main.ts`：
// 实测 Node 24.19 三处硬阻塞（除改源码外无解）——
//   1. strip/transform 模式不做扩展名解析：源树是无扩展名相对导入
//      （tsconfig moduleResolution: "Bundler"）→ 第一个 import 即 ERR_MODULE_NOT_FOUND；
//   2. strip-only 模式不支持构造器参数属性（types.ts、session.ts 等 10+ 处）→
//      ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；
//   3. transform 模式不省略"以值形式导入的纯类型"（runtime.ts 的 AgentEvent 等）→
//      "does not provide an export named"。
// 因此用仓库既有 devDependency esbuild（原 bridge:build 的同款管线：ESM、真依赖
// external、@vibe/* TS 源内联）打成临时 bundle 后**进程内 import**——单进程，
// SIGINT/SIGTERM 语义与直跑一致。产物落在 gitignore 的 packages/server/dist/。
import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 开发形态前端目录：config.frontendDist 只从 FRONTEND_DIST / VIBE_TS_ROOT 环境变量
// 解析（packages/server/src/config.ts），e2e（e2e/server.ts）与发布包
// （package-release.mjs 生成的 start.bat / smoke-package.mjs）各自设置，唯独
// npm start 链路无人设置 → SPA 托管关闭，所有非 /api 路径 404（{"detail":"Not Found"}）。
// 这里按 e2e 同款缺省补齐；dist 是 gitignored 构建产物，缺失时只告警不阻断（API 照常可用）。
process.env.FRONTEND_DIST ??= join(root, "frontend", "dist");
if (!existsSync(join(process.env.FRONTEND_DIST, "index.html"))) {
  console.warn(
    `[dev-start] frontend dist not found: ${process.env.FRONTEND_DIST} — UI will 404. Run "npm run vendor" to fetch it.`,
  );
}
const entry = join(root, "packages", "server", "src", "main.ts");
const outfile = join(root, "packages", "server", "dist", "dev-main.mjs");

mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // 真依赖（node_modules，均为正式 ESM 包）留在运行时解析；@vibe/* 不在其中——
  // 它们的 exports 指向 TS 源，必须内联由 esbuild 编译（packages:"external" 会把
  // 它们一起放走，node 加载 TS 源即 ERR_MODULE_NOT_FOUND，故用显式白名单）。
  external: ["hono", "@hono/*", "bcryptjs", "@earendil-works/*"],
  outfile,
  logLevel: "warning",
});

// main.ts 的自启守卫 = "本模块是 node 入口"（import.meta.url === argv[1] 的 file URL）。
// 进程内 import bundle 时把 argv[1] 指向 bundle，守卫照常成立；vitest/e2e 的普通
// import（argv[1] 是测试器）不触发自启，行为与直跑 main.ts 完全一致。
process.argv[1] = outfile;
await import(pathToFileURL(outfile).href);
