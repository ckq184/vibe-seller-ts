// 范围检查脚本测试（宪法门禁②，PRD 路线3 §3.1 / 验收条件 1–7 / Task 1）。
//
// 两层：
//   纯函数单测——glob 语义逐条（验收 6）、parseArgs 用法错误、-z porcelain 解析
//   （rename 双侧、?? 未跟踪、D 删除、中文路径）；
//   集成场景——os.tmpdir 下 git init 临时仓真实制造改动，spawnSync 同步驱动
//   （不依赖异步时序，容忍 Windows 速度）。临时仓用 local config 内联身份并关
//   autocrlf/gpgsign，不依赖全局 git 配置。
//
// 已实测钉住（git 2.55 windows）：-z 的 rename 条目为 "XY 新路径\0旧路径\0"；
// status/diff 输出路径恒为仓库根相对，与 cwd 无关。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  collectChangedFiles,
  globToRegExp,
  matchScope,
  parseArgs,
  parseStatusZ,
} from "./check-scope.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-scope.mjs");

// ── 工具 ──

const tmpDirs = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败(exit=${r.status}): ${r.stderr}`);
  return r.stdout;
}

function mkTemp(withGit) {
  const dir = mkdtempSync(join(tmpdir(), "check-scope-test-"));
  tmpDirs.push(dir);
  if (withGit) {
    git(dir, "init", "-q");
    // 身份/行为全部 local config 内联：不依赖全局 user.email；autocrlf=false 钉死
    // 换行（Windows 全局 autocrlf=true 会往 status 里混换行差异）；gpgsign=false 防
    // 全局签名配置拖慢或失败提交。
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "commit.gpgsign", "false");
  }
  return dir;
}

function write(dir, relPath, content = "x\n") {
  const p = join(dir, ...relPath.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// 直 spawn（node + 参数数组，不经 shell）：scope 模式含 ** 免引号转义
function runCli(cwd, ...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
}

// ── glob 语义（验收 6）──

describe("matchScope/globToRegExp：scope glob 语义（验收 6）", () => {
  it("** 跨目录段（含 /）", () => {
    expect(matchScope("scripts/a.mjs", ["scripts/**"])).toBe(true);
    expect(matchScope("scripts/sub/deep/b.mjs", ["scripts/**"])).toBe(true);
    expect(matchScope("a/x/y/b", ["a/**/b"])).toBe(true);
    expect(matchScope("scriptsx/a.mjs", ["scripts/**"])).toBe(false);
  });

  it("* 单段内任意字符，不跨 /", () => {
    expect(matchScope("docs/a.md", ["docs/*.md"])).toBe(true);
    expect(matchScope("docs/sub/a.md", ["docs/*.md"])).toBe(false);
    expect(matchScope("docs/a.md.bak", ["docs/*.md"])).toBe(false);
  });

  it("? 恰好一个字符，不跨 /", () => {
    expect(matchScope("a/bc", ["a/b?"])).toBe(true);
    expect(matchScope("a/bcd", ["a/b?"])).toBe(false);
    expect(matchScope("a/b/c", ["a/b?"])).toBe(false);
  });

  it("无通配符：精确路径相等", () => {
    expect(matchScope("README.md", ["README.md"])).toBe(true);
    expect(matchScope("README.md.bak", ["README.md"])).toBe(false);
  });

  it("无通配符：目录前缀匹配整棵子树", () => {
    expect(matchScope("scripts", ["scripts"])).toBe(true);
    expect(matchScope("scripts/a.mjs", ["scripts"])).toBe(true);
    expect(matchScope("scripts/sub/b.mjs", ["scripts"])).toBe(true);
    expect(matchScope("scriptsx/a.mjs", ["scripts"])).toBe(false);
  });

  it("反斜杠归一为正斜杠后匹配", () => {
    expect(matchScope("scripts\\sub\\a.mjs", ["scripts/**"])).toBe(true);
    expect(matchScope("scripts\\sub\\a.mjs", ["scripts/sub/a.mjs"])).toBe(true);
  });

  it("多模式命中任一即可，全不命中才越界", () => {
    const scopes = ["scripts/**", "docs/*.md"];
    expect(matchScope("scripts/a.mjs", scopes)).toBe(true);
    expect(matchScope("docs/x.md", scopes)).toBe(true);
    expect(matchScope("packages/a.ts", scopes)).toBe(false);
  });

  it("字面字符不按正则元字符解释", () => {
    expect(matchScope("a+b.ts", ["a+b.ts"])).toBe(true);
    expect(matchScope("ab.ts", ["a+b.ts"])).toBe(false);
    expect(matchScope("aXb.ts", ["a?b.ts"])).toBe(true);
  });

  it("globToRegExp 产物为全串锚定", () => {
    expect(globToRegExp("a/*").test("a/b/c")).toBe(false);
    expect(globToRegExp("a/**").test("a/b/c")).toBe(true);
    expect(globToRegExp("a").test("ab")).toBe(false);
  });
});

// ── CLI 参数 ──

describe("parseArgs：--scope 必填（可重复+逗号分隔），--base 可选", () => {
  it("单个 --scope", () => {
    expect(parseArgs(["--scope", "scripts/**"])).toEqual({ scopes: ["scripts/**"], base: null });
  });

  it("逗号分隔拆分", () => {
    expect(parseArgs(["--scope", "a,b,c"])).toEqual({ scopes: ["a", "b", "c"], base: null });
  });

  it("--scope 可重复，与逗号分隔叠加", () => {
    expect(parseArgs(["--scope", "a,b", "--scope", "c"])).toEqual({
      scopes: ["a", "b", "c"],
      base: null,
    });
  });

  it("--base 透传", () => {
    expect(parseArgs(["--scope", "a", "--base", "HEAD~1"])).toEqual({ scopes: ["a"], base: "HEAD~1" });
  });

  it("缺 --scope → 用法错误", () => {
    expect(() => parseArgs([])).toThrow(/--scope/);
    expect(() => parseArgs(["--base", "x"])).toThrow(/--scope/);
  });

  it("--scope 值为空字符串/逗号全空 → 用法错误（PRD 异常流程 3）", () => {
    expect(() => parseArgs(["--scope", ""])).toThrow(/--scope/);
    expect(() => parseArgs(["--scope", ", , "])).toThrow(/--scope/);
  });

  it("非法参数 / --scope 缺值 → 用法错误", () => {
    expect(() => parseArgs(["--scope", "a", "--json"])).toThrow(/非法/);
    expect(() => parseArgs(["positional"])).toThrow(/非法/);
    expect(() => parseArgs(["--scope"])).toThrow(/--scope/);
  });
});

// ── porcelain -z 解析 ──

describe("parseStatusZ：porcelain -z 解析", () => {
  it("?? 未跟踪条目", () => {
    expect(parseStatusZ("?? docs/new.md\0")).toEqual(["docs/new.md"]);
  });

  it("M / D / A 常规 XY 状态", () => {
    expect(parseStatusZ("M  a.ts\0 D b.ts\0A  c.ts\0")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("rename 双侧收录（-z 实测格式：XY 新路径\\0旧路径\\0）", () => {
    expect(parseStatusZ("R  new.txt\0old.txt\0")).toEqual(["old.txt", "new.txt"]);
    expect(parseStatusZ("RM renamed.md\0orig.md\0")).toEqual(["orig.md", "renamed.md"]);
  });

  it("core.quotepath=off：中文路径原样保留", () => {
    expect(parseStatusZ("?? 文档/中文 文件.md\0")).toEqual(["文档/中文 文件.md"]);
  });

  it("反斜杠防御性归一为正斜杠", () => {
    expect(parseStatusZ("M  scripts\\a.mjs\0")).toEqual(["scripts/a.mjs"]);
  });

  it("空输出 → 空数组", () => {
    expect(parseStatusZ("")).toEqual([]);
  });
});

// ── collectChangedFiles（临时仓集成）──

describe("collectChangedFiles：git 变更收集（临时仓）", () => {
  it("工作区变更含未跟踪；--base 叠加已提交 diff 并去重并集", () => {
    const dir = mkTemp(true);
    write(dir, "tracked.txt", "v1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    const base = git(dir, "rev-parse", "HEAD").trim();

    // 已提交一段：tracked.txt 改 v2（进 <base>..HEAD）
    write(dir, "tracked.txt", "v2\n");
    git(dir, "commit", "-aqm", "v2");
    // 工作区：tracked.txt 再改 v3（同时出现在 status 与 <base>..HEAD → 须去重成一条）
    // + 新未跟踪文件
    write(dir, "tracked.txt", "v3\n");
    write(dir, "new.md", "u\n");

    const files = collectChangedFiles({ cwd: dir, base });
    expect(files).toContain("tracked.txt");
    expect(files).toContain("new.md");
    expect(files.filter((f) => f === "tracked.txt")).toHaveLength(1);
  });

  it("缺省 base：仅工作区变更", () => {
    const dir = mkTemp(true);
    write(dir, "a.txt", "v1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    write(dir, "a.txt", "v2\n");
    expect(collectChangedFiles({ cwd: dir })).toEqual(["a.txt"]);
  });

  it("git 失败（非法 base ref）→ 抛错（由 main 转退出码 2）", () => {
    const dir = mkTemp(true);
    expect(() => collectChangedFiles({ cwd: dir, base: "no-such-ref" })).toThrow(/diff/);
  });
});

// ── CLI 集成（验收 1–5、7）──

describe("CLI 集成：临时 git 仓真实改动", () => {
  it("验收 1：变更全在 scripts/** 内 → 退出 0 并报告命中数", () => {
    const dir = mkTemp(true);
    write(dir, "scripts/.keep", "\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    write(dir, "scripts/a.mjs", "x\n");
    const r = runCli(dir, "--scope", "scripts/**");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("变更文件 1 个");
  });

  it("验收 2：存在 scope 外变更 → 退出 1 且 stdout 逐行列出全部越界文件", () => {
    const dir = mkTemp(true);
    write(dir, "scripts/.keep", "\n");
    write(dir, "packages/x.ts", "\n");
    write(dir, "docs/.keep", "\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    write(dir, "packages/x.ts", "a\n");
    write(dir, "docs/y.md", "b\n");
    const r = runCli(dir, "--scope", "scripts/**");
    expect(r.status).toBe(1);
    const outLines = r.stdout.split(/\r?\n/).filter((l) => l.includes("越界"));
    expect(outLines.some((l) => l.includes("packages/x.ts"))).toBe(true);
    expect(outLines.some((l) => l.includes("docs/y.md"))).toBe(true);
  });

  it("验收 3：变更集为空 → 退出 1，提示 --base 与未提交改动两种修正", () => {
    const dir = mkTemp(true);
    write(dir, "a.txt", "\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    const r = runCli(dir, "--scope", "**");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--base");
    expect(r.stderr).toContain("未提交");
  });

  it("验收 4：--base 时已提交变更（<base>..HEAD）与工作区未提交变更合并判定", () => {
    const dir = mkTemp(true);
    write(dir, "scripts/.keep", "\n");
    write(dir, "committed.txt", "v1\n");
    write(dir, "worktree.txt", "v1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    const base = git(dir, "rev-parse", "HEAD").trim();
    write(dir, "committed.txt", "v2\n");
    git(dir, "commit", "-aqm", "committed change");
    write(dir, "worktree.txt", "v2\n");

    // scope 只声明未动的 scripts/**：已提交的 committed.txt 与未提交的 worktree.txt 都须判越界
    const fail = runCli(dir, "--scope", "scripts/**", "--base", base);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("committed.txt");
    expect(fail.stdout).toContain("worktree.txt");

    // scope 覆盖全部变更 → 通过
    const pass = runCli(
      dir,
      "--scope", "scripts/**",
      "--scope", "committed.txt,worktree.txt",
      "--base", base,
    );
    expect(pass.status).toBe(0);
  });

  it("验收 5：未跟踪文件（??）参与判定", () => {
    const dir = mkTemp(true);
    write(dir, "docs/.keep", "\n");
    write(dir, "scripts/.keep", "\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    write(dir, "docs/leak.md", "u\n"); // 未跟踪且越界
    write(dir, "scripts/new.mjs", "u\n"); // 未跟踪但在范围内
    const fail = runCli(dir, "--scope", "scripts/**");
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("docs/leak.md");
    const pass = runCli(dir, "--scope", "scripts/**", "--scope", "docs/**");
    expect(pass.status).toBe(0);
  });

  it("验收 7：真实 rename 的 old/new 两侧都参与判定", () => {
    const dir = mkTemp(true);
    write(dir, "old.txt", "v\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    git(dir, "mv", "old.txt", "new.txt");
    // 只声明旧名 → 新名越界
    const oldOnly = runCli(dir, "--scope", "old.txt");
    expect(oldOnly.status).toBe(1);
    expect(oldOnly.stdout).toContain("new.txt");
    // 只声明新名 → 旧名越界
    const newOnly = runCli(dir, "--scope", "new.txt");
    expect(newOnly.status).toBe(1);
    expect(newOnly.stdout).toContain("old.txt");
    // 两侧都声明 → 通过
    const both = runCli(dir, "--scope", "old.txt,new.txt");
    expect(both.status).toBe(0);
  });
});

// ── 用法 / 运行错误 → 退出 2 ──

describe("CLI 集成：用法或运行错误退出 2", () => {
  it("缺 --scope → 退出 2 并提示用法", () => {
    const dir = mkTemp(true);
    const r = runCli(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--scope");
  });

  it("非 git 仓库 → 退出 2", () => {
    const dir = mkTemp(false);
    const r = runCli(dir, "--scope", "**");
    expect(r.status).toBe(2);
    expect(r.stderr).not.toBe("");
  });

  it("--base 非法 ref（git 命令失败）→ 退出 2", () => {
    const dir = mkTemp(true);
    const r = runCli(dir, "--scope", "**", "--base", "no-such-ref");
    expect(r.status).toBe(2);
  });
});
