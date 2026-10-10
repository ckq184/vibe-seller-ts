// hooks 幂等安装脚本（宪法门禁③④共用，PRD 路线3 §二③"两 hook 共用 hooksPath"）。
//
// 用法：npm run hooks:install（无参数）。
//
// 行为：git config core.hooksPath scripts/githooks → 执行后读回
// git config core.hooksPath 打印确认；已是该值时输出"已安装"（幂等无害）。
// 配置前确认 hook 文件存在（scripts/githooks/commit-msg），缺失即拒绝配置并退出 2，
// 避免 hooksPath 指向空目录造成"看似装了、实际无效"。
//
// 相对路径语义：值 scripts/githooks 为相对路径，按 git ≥2.29 语义相对仓库根解析
// （本机 git 2.55.0.windows.5 实证支持）；不入仓绝对路径，clone 后重跑本命令即可。
//
// 退出码（同 check-scope.mjs 约定）：0 已安装（含重复执行）/ 2 环境（非 git 仓、
// hook 文件缺失）或运行错误。
//
// 明示取舍（PRD §三）：--no-verify 可绕过 hook，git hook 层无防御手段；防绕过靠
// 代码质量审查核对 diff，不由本门禁承担。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 与仓库内目录保持一致；T2（secret 扫描）落地后在此追加 "pre-commit"
const HOOKS_PATH = "scripts/githooks";
const REQUIRED_HOOKS = ["commit-msg"];

function gitOut(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

// 读当前 core.hooksPath：返回字符串 / null（未设置）/ 抛错（非 git 仓等运行错误）
function readHooksPath(cwd) {
  const r = gitOut(["config", "core.hooksPath"], cwd);
  if (r.status === 0) return r.stdout;
  if (r.status === 1) return null; // 键未设置（git config 约定）
  throw new Error(r.stderr || `git config core.hooksPath 失败(exit=${r.status})`);
}

// 返回退出码。cwd 须在目标仓库内（npm run 的 cwd = package.json 目录 = 仓库根）。
export function install({ cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  let root;
  try {
    const r = gitOut(["rev-parse", "--show-toplevel"], cwd);
    if (r.status !== 0) throw new Error(r.stderr || "当前目录不在 git 仓库内");
    root = r.stdout;
  } catch (e) {
    error(`[hooks:install] 运行错误：${e.message}`);
    return 2;
  }

  for (const hook of REQUIRED_HOOKS) {
    if (!existsSync(join(root, HOOKS_PATH, hook))) {
      error(`[hooks:install] 运行错误：hook 文件缺失 ${HOOKS_PATH}/${hook}（仓库 ${root}），拒绝配置 hooksPath 指向空目录`);
      return 2;
    }
  }

  let before;
  try {
    before = readHooksPath(cwd);
  } catch (e) {
    error(`[hooks:install] 运行错误：${e.message}`);
    return 2;
  }
  if (before === HOOKS_PATH) {
    log(`[hooks:install] 已安装（core.hooksPath=${HOOKS_PATH}，读回确认；hook 文件存在）`);
    return 0;
  }

  const set = gitOut(["config", "core.hooksPath", HOOKS_PATH], cwd);
  if (set.status !== 0) {
    error(`[hooks:install] 运行错误：写入 core.hooksPath 失败：${set.stderr}`);
    return 2;
  }

  const after = readHooksPath(cwd);
  if (after !== HOOKS_PATH) {
    error(`[hooks:install] 运行错误：读回确认失败，期望 ${HOOKS_PATH}，实际 ${after}`);
    return 1;
  }

  log(
    `[hooks:install] 已安装：core.hooksPath=${HOOKS_PATH}（读回确认；相对路径，按 git ≥2.29 语义相对仓库根解析）。` +
    `卸载：git config --unset core.hooksPath。注意：--no-verify 可绕过 hook（PRD §三 明示取舍）。`,
  );
  return 0;
}

// 仅直接运行时执行（被测试导入时不产生副作用，同 verify.mjs 约定）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = install({ cwd: process.cwd() });
}
