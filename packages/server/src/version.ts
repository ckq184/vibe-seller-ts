// 已安装包版本的单一事实源（app/version.py 的移植）：叶子模块，只用 node 内置模块，
// /api/health、/api/version、/api/system/info（经 config.version）与遥测 app_version
// 都从这里取，互不 import 应用图。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 对齐原 APP_VERSION = importlib.metadata.version('vibe-seller')（pyproject 单一事实
// 源，缺失即安装损坏、响亮报错不做静默兜底）；TS 侧预裁决取仓库根 package.json 的
// version。定位不能写死上溯级数：源码树里本文件是 <root>/packages/server/src/
//（3 级），打成 bundle（scripts/dev-start.mjs、5.3 的 dist/server.mjs）后深度会变——
// 从本文件真实位置逐级向上找 name === "vibe-seller-ts" 的 package.json，找不到按
// 原哲学响亮报错（等价 importlib.metadata.version 缺失）。
function findRootPackageJson(startFile: string): string {
  let dir = dirname(startFile);
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      if ((JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === "vibe-seller-ts") return candidate;
    } catch {
      /* 无 package.json / 非 JSON：继续向上 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("vibe-seller-ts 根 package.json 未找到：安装损坏（原 importlib.metadata.version 缺失同款响亮失败）");
}

export const APP_VERSION: string = (
  JSON.parse(readFileSync(findRootPackageJson(fileURLToPath(import.meta.url)), "utf8")) as { version: string }
).version;
