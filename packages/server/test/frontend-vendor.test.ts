// vendor 前端零改动红线的机器门禁（PRD §5.3）：frontend/ 树与哈希清单
// （scripts/frontend-vendor-manifest.json，由 scripts/vendor-frontend.mjs 从
// 参考仓库字节级复制时生成）必须逐一 sha256 一致。清单外多文件 / 缺文件 /
// 内容改动任一命中即失败——"需要改前端 = 回参考仓库改后重新 vendor" 的
// 架构决定靠这里强制，不靠人记住。
// 注意：frontend/dist（构建产物，允许随时重建）与 frontend/node_modules 不在
// 清单内，校验时排除。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const frontendDir = join(repoRoot, "frontend");
const manifestPath = join(repoRoot, "scripts", "frontend-vendor-manifest.json");
const EXCLUDED = new Set(["node_modules", "dist"]);

function hashTree(dir: string, relPrefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      if (EXCLUDED.has(name)) continue;
      Object.assign(files, hashTree(full, rel));
    } else {
      files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  }
  return files;
}

describe("vendor 前端零改动红线（哈希清单）", () => {
  it("frontend/ 存在且清单在库", () => {
    expect(existsSync(frontendDir), "frontend/ 不存在——先跑 npm run vendor").toBe(true);
    expect(existsSync(manifestPath), "vendor 清单不存在——先跑 npm run vendor").toBe(true);
  });

  it("frontend/ 树与清单逐文件 sha256 一致（vendor 后零改动）", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      source: string;
      fileCount: number;
      files: Record<string, string>;
    };
    const actual = hashTree(frontendDir);
    const missing = Object.keys(manifest.files).filter((rel) => !(rel in actual));
    const extra = Object.keys(actual).filter((rel) => !(rel in manifest.files));
    const changed = Object.keys(manifest.files).filter(
      (rel) => rel in actual && manifest.files[rel] !== actual[rel],
    );
    const problems = [
      ...missing.map((rel) => `缺失: ${rel}`),
      ...extra.map((rel) => `多出(不在清单内): ${rel}`),
      ...changed.map((rel) => `内容被改动: ${rel}`),
    ];
    expect(problems, "vendor 前端被改动——回参考仓库改后重新 npm run vendor").toEqual([]);
    expect(Object.keys(actual).length).toBe(manifest.fileCount);
  });
});
