// vendor-frontend.mjs 的 --check 独立性测试（路线 4 T2 / G3）。
//
// --check 只比对本仓 frontend/ 与哈希清单，用不到来源目录；来源（参考仓库）缺失的
// 机器（换机 / CI）上 vendor:check 与 npm run package 也必须能过。只跑 --check：
// 复制模式会改写 frontend/（零改动红线），测试里绝不触发。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "vendor-frontend.mjs");

const tmpDirs = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("vendor-frontend --check", () => {
  it("来源目录不存在时 --check 仍按清单校验通过（不依赖参考仓库）", () => {
    const parent = mkdtempSync(join(tmpdir(), "vendor-check-test-"));
    tmpDirs.push(parent);
    const missingSource = join(parent, "no-such-frontend"); // 只建父目录，来源本身不存在
    const r = spawnSync(process.execPath, [scriptPath, "--check", "--source", missingSource], { encoding: "utf8" });
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("check OK");
  });
});
