// commit-msg hook 测试（宪法门禁③，PRD 路线3 §二③/§三/§五.1-2/4-5/§七 Task T1）。
//
// 四层：
//   纯函数单测——validateCommitMessage 按 §五.1 合法样例（白名单各类型 + scope +
//   豁免三类）与 §五.2 非法样例（未知类型/缺 ": "/空 subject/空消息）逐条钉死；
//   CLI 集成——node commit-msg.mjs <msgfile> 退出码 0/1/2（spawnSync 同步驱动，
//   不依赖异步时序，容忍 Windows 速度）；
//   hook 入口转发——extensionless 文件以 node 直跑（实测：git 2.55 windows 经
//   sh 尊重 #!/usr/bin/env node，Node 24 对 extensionless 入口做 ESM 语法探测）；
//   真仓集成——os.tmpdir 下 git init 临时仓真实 commit（组织方式参照
//   check-scope.test.mjs）：hooksPath 指向本仓 scripts/githooks 绝对路径时
//   合法过/非法拒/Merge 豁免；未装 hooksPath 时 hook 不生效（§五.5 对照）；
//   hooks-install 全链（temp 仓自装，生产形态相对路径）。
//
// 临时仓用 local config 内联身份并关 autocrlf/gpgsign，不依赖全局 git 配置；
// 提交信息一律走 -F 文件（UTF-8），绕开 Windows 命令行中文参数编码变量。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { main, validateCommitMessage } from "./commit-msg.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "commit-msg.mjs");
const hookEntryPath = join(here, "commit-msg");
const installerPath = join(here, "..", "hooks-install.mjs");

// 与 commit-msg.mjs 白名单一致（PRD §三 合法格式正则）
const TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "perf", "build", "ci", "style", "revert"];

// ── 工具（参照 check-scope.test.mjs）──

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

// 不抛版本：读可能未设置的 config 键（git config <key> 未设置时 exit=1，是约定非错误）
function gitSoft(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function readHooksPath(cwd) {
  const r = gitSoft(cwd, "config", "core.hooksPath");
  return r.status === 0 ? r.stdout.trim() : "";
}

function mkTemp(withGit) {
  const dir = mkdtempSync(join(tmpdir(), "commit-msg-test-"));
  tmpDirs.push(dir);
  if (withGit) {
    git(dir, "init", "-q");
    // 身份/行为全部 local config 内联：不依赖全局 user.email；autocrlf=false 钉死
    // 换行；gpgsign=false 防全局签名配置拖慢或失败提交。
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "commit.gpgsign", "false");
  }
  return dir;
}

// 直 spawn（node + 参数数组，不经 shell）：路径含空格/反斜杠免转义
function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

// 写提交信息文件（UTF-8 无 BOM）并用 -F 提交，绕开命令行中文参数编码变量
function commitWithMessage(repoDir, message) {
  const msgFile = join(repoDir, ".git", "hook-test-msg.txt");
  writeFileSync(msgFile, message, "utf8");
  writeFileSync(join(repoDir, "f.txt"), `content-${Math.random()}\n`);
  git(repoDir, "add", "f.txt");
  return spawnSync("git", ["commit", "-F", msgFile], { cwd: repoDir, encoding: "utf8" });
}

// 把 hook 文件复制进 temp 仓（hooks-install 全链用：安装器要求 <root>/scripts/githooks
// 同时存在 REQUIRED_HOOKS 全部文件——门禁④落地后含 pre-commit；pre-commit 运行时
// 还要相对导入 scan-secrets.mjs 与 allowlist，故按"生产形态"一并复制）
function copyHooksInto(repoDir) {
  const target = join(repoDir, "scripts", "githooks");
  mkdirSync(target, { recursive: true });
  for (const name of ["commit-msg", "commit-msg.mjs", "pre-commit", "scan-secrets.mjs", "secret-allowlist.json"]) {
    writeFileSync(join(target, name), readFileSync(join(here, name)));
  }
  return target;
}

// ── 纯函数：合法样例（PRD §五.1）──

describe("validateCommitMessage：合法样例（§五.1）", () => {
  it("白名单每类各一条全过", () => {
    for (const type of TYPES) {
      const r = validateCommitMessage(`${type}: 摘要（${type} 类合法样例）`);
      expect(r, type).toEqual({ ok: true, errors: [] });
    }
  });

  it("带 parenthetical scope（英文/中文/连字符）全过", () => {
    expect(validateCommitMessage("feat(core): 带 scope 的合法样例").ok).toBe(true);
    expect(validateCommitMessage("fix(门禁③): scope 含中文").ok).toBe(true);
    expect(validateCommitMessage("test(hook-msg): scope 含连字符").ok).toBe(true);
  });

  it("subject 可含空格/标点/斜杠/中文", () => {
    expect(validateCommitMessage("fix: 修复冷启动 kill/respawn churn（审查 Major2）").ok).toBe(true);
  });
});

// ── 纯函数：豁免三类（PRD §三）──

describe("validateCommitMessage：豁免（首行匹配即放行）", () => {
  it("Merge 开头（git 自动生成）", () => {
    expect(validateCommitMessage("Merge branch 'feature/x'")).toEqual({ ok: true, errors: [] });
  });

  it("Revert \" 开头（git revert 自动生成）", () => {
    expect(validateCommitMessage('Revert "feat: 旧提交"')).toEqual({ ok: true, errors: [] });
  });

  it("fixup! / squash! 前缀（rebase 中间态）", () => {
    expect(validateCommitMessage("fixup! feat: 中间态").ok).toBe(true);
    expect(validateCommitMessage("squash! fix: 中间态").ok).toBe(true);
  });

  it("前缀精确匹配：相似但不精确的开头不豁免", () => {
    // "Mergeless" 非 `Merge ` 开头、"Reverted" 非 `Revert "` 开头——都要走格式校验并被拒
    expect(validateCommitMessage("Mergeless change").ok).toBe(false);
    expect(validateCommitMessage('Reverted "feat: 旧提交"').ok).toBe(false);
  });
});

// ── 纯函数：非法样例（PRD §五.2）──

describe("validateCommitMessage：非法样例（§五.2）", () => {
  it("未知类型：拒绝且错误信息列出白名单", () => {
    const r = validateCommitMessage("update: 改东西");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    const joined = r.errors.join("\n");
    expect(joined).toContain("白名单");
    expect(joined).toContain(TYPES.join("|"));
  });

  it("类型大小写敏感：Feat 被拒", () => {
    expect(validateCommitMessage("Feat: 大写类型").ok).toBe(false);
  });

  it("缺冒号空格（类型后空格分隔）被拒", () => {
    const r = validateCommitMessage("feat 新功能");
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("冒号");
  });

  it("冒号后缺空格被拒", () => {
    expect(validateCommitMessage("feat:无空格").ok).toBe(false);
  });

  it("空 subject（冒号空格后无内容）被拒且错误信息提及 subject", () => {
    const r = validateCommitMessage("feat: ");
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("subject");
  });

  it("subject 以空白开头被拒", () => {
    expect(validateCommitMessage("feat:  前导双空格").ok).toBe(false);
  });

  it("空消息 / 全空白消息被拒", () => {
    for (const line of ["", "   "]) {
      const r = validateCommitMessage(line);
      expect(r.ok, JSON.stringify(line)).toBe(false);
      expect(r.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("空 scope / scope 未闭合被拒", () => {
    expect(validateCommitMessage("feat(): 空 scope").ok).toBe(false);
    expect(validateCommitMessage("feat(x: 未闭合").ok).toBe(false);
  });
});

// ── CLI：node commit-msg.mjs <msgfile> ──

describe("CLI 集成：node commit-msg.mjs <msgfile>", () => {
  it("合法 message → 退出 0", () => {
    const dir = mkTemp(false);
    const f = join(dir, "msg.txt");
    writeFileSync(f, "feat: 合法提交信息\n\n正文可以随便写。\n");
    const r = runNode(cliPath, [f], dir);
    expect(r.status).toBe(0);
  });

  it("多行 message 只看首行：首行合法、后续行任意 → 退出 0", () => {
    const dir = mkTemp(false);
    const f = join(dir, "msg.txt");
    writeFileSync(f, "fix: 合法首行\n这不是格式的垃圾行！！\n第三行\n");
    const r = runNode(cliPath, [f], dir);
    expect(r.status).toBe(0);
  });

  it("非法 message（未知类型）→ 退出 1 且 stderr 含白名单提示", () => {
    const dir = mkTemp(false);
    const f = join(dir, "msg.txt");
    writeFileSync(f, "update: 不在白名单\n");
    const r = runNode(cliPath, [f], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("白名单");
    expect(r.stderr).toContain("feat");
  });

  it("空文件 → 退出 1 且 stderr 指出空消息", () => {
    const dir = mkTemp(false);
    const f = join(dir, "msg.txt");
    writeFileSync(f, "");
    const r = runNode(cliPath, [f], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("空");
  });

  it("缺 <msgfile> 参数 → 退出 2 并提示用法", () => {
    const r = runNode(cliPath, [], mkTemp(false));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("msgfile");
  });

  it("文件不存在 → 退出 2", () => {
    const dir = mkTemp(false);
    const r = runNode(cliPath, [join(dir, "no-such-file.txt")], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toBe("");
  });

  it("main() 直接调用与 CLI 退出码一致（豁免 Merge → 0）", () => {
    const dir = mkTemp(false);
    const f = join(dir, "msg.txt");
    writeFileSync(f, "Merge branch 'x'\n");
    expect(main([process.execPath, cliPath, f])).toBe(0);
  });
});

// ── hook 入口转发 ──

describe("hook 入口转发（extensionless commit-msg → commit-msg.mjs）", () => {
  it("以 node 直跑入口：合法 → 0、非法 → 1（转发 argv[2] 且按 ESM 解析）", () => {
    const dir = mkTemp(false);
    const ok = join(dir, "ok.txt");
    const bad = join(dir, "bad.txt");
    writeFileSync(ok, "feat: 合法\n");
    writeFileSync(bad, " nonsense message\n");
    expect(runNode(hookEntryPath, [ok], dir).status).toBe(0);
    expect(runNode(hookEntryPath, [bad], dir).status).toBe(1);
  });

  it("hook 文件存在且带 node shebang（git 2.55 windows 实测尊重）", () => {
    expect(existsSync(hookEntryPath)).toBe(true);
    expect(readFileSync(hookEntryPath, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

// ── hooks-install：幂等安装（temp 真仓，PRD §五.5）──

describe("hooks-install：幂等安装（temp 真仓）", () => {
  it("安装 → 退出 0，读回 core.hooksPath=scripts/githooks 并打印确认", () => {
    const dir = mkTemp(true);
    copyHooksInto(dir);
    const r = runNode(installerPath, [], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scripts/githooks");
    expect(readHooksPath(dir)).toBe("scripts/githooks");
  });

  it("重复执行幂等无害：退出 0 且输出已安装", () => {
    const dir = mkTemp(true);
    copyHooksInto(dir);
    expect(runNode(installerPath, [], dir).status).toBe(0);
    const again = runNode(installerPath, [], dir);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("已安装");
    expect(readHooksPath(dir)).toBe("scripts/githooks");
  });

  it("hook 文件缺失（只有 commit-msg、缺 pre-commit）→ 退出 2 且拒绝配置", () => {
    const dir = mkTemp(true);
    copyHooksInto(dir);
    rmSync(join(dir, "scripts", "githooks", "pre-commit"));
    const r = runNode(installerPath, [], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("pre-commit");
    expect(readHooksPath(dir)).toBe("");
  });

  it("非 git 目录 → 退出 2", () => {
    const r = runNode(installerPath, [], mkTemp(false));
    expect(r.status).toBe(2);
  });
});

// ── 真仓集成：hook 真实拦截 git commit（PRD §五.4）──

describe("真仓集成：core.hooksPath 指向本仓 scripts/githooks", () => {
  // 绝对路径指向本仓 githooks（正斜杠形式，git 跨目录引用无歧义）；
  // hook 内部按 import.meta.url 定位 commit-msg.mjs，与 cwd=temp 仓无关。
  const hooksPath = here.replace(/\\/g, "/");

  it("首个 commit 用合法 message 通过（hook 真实执行并放行）", () => {
    const dir = mkTemp(true);
    git(dir, "config", "core.hooksPath", hooksPath);
    const r = commitWithMessage(dir, "feat: 临时仓合法首提交\n");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("白名单");
  }, 30_000);

  it("非法 message → git commit 非零退出，输出含白名单字样", () => {
    const dir = mkTemp(true);
    git(dir, "config", "core.hooksPath", hooksPath);
    const r = commitWithMessage(dir, "bad message 不合格式\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("白名单");
  }, 30_000);

  it("Merge 开头的 message 豁免通过", () => {
    const dir = mkTemp(true);
    git(dir, "config", "core.hooksPath", hooksPath);
    const r = commitWithMessage(dir, "Merge branch 'x'\n");
    expect(r.status).toBe(0);
  }, 30_000);

  it("对照：未安装 hooksPath 时 hook 不生效（非法 message 也提交成功）", () => {
    const dir = mkTemp(true);
    expect(readHooksPath(dir)).toBe("");
    const r = commitWithMessage(dir, "bad message 不合格式\n");
    expect(r.status).toBe(0);
  }, 30_000);
});

describe("真仓集成：hooks-install 安装全链（生产形态，相对路径）", () => {
  it("安装后合法提交通过、非法提交被拒", () => {
    const dir = mkTemp(true);
    copyHooksInto(dir);
    expect(runNode(installerPath, [], dir).status).toBe(0);

    const ok = commitWithMessage(dir, "feat: 安装器全链合法提交\n");
    expect(ok.status).toBe(0);

    const bad = commitWithMessage(dir, "still bad\n");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain("白名单");
  }, 30_000);
});
