import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vibe/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@vibe/runtime": fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    // 套件是真 HTTP + 真文件系统 I/O（桥/编排器/调度器），Windows 上 12 路文件并行
    // 会把 gate-resume 的时序窗口压出偶发。压到 4 路：总时长可控，顺序敏感性消失。
    fileParallelism: true,
    maxWorkers: 4,
    server: {
      deps: {
        // node:sqlite 是 Node 24 内置模块；vite 依赖预打包不识别该导出，显式外置
        external: [/^node:/],
      },
    },
  },
});
