// bridge.mjs 构建脚本：CJS 格式会丢 import.meta.url（pi-coding-agent 依赖它），
// 因此用 ESM + createRequire banner（让 CJS 依赖能 require 内置模块）。
import { build } from "esbuild";

await build({
  entryPoints: ["packages/bridge/src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "packages/bridge/dist/bridge.mjs",
  banner: {
    // 别名避开 esbuild 为各模块自身注入的 createRequire import（避免重复声明）
    js: "import { createRequire as bridgeCreateRequire } from 'module'; const require = bridgeCreateRequire(import.meta.url);",
  },
});
console.log("bridge.mjs built");
