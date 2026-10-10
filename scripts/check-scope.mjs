// 范围检查脚本（宪法门禁②，PRD 路线3 §3.1 Task 1）：git 变更文件清单 vs 任务声明范围。
//
// 门禁语义与退出码：
//   0 通过——变更集非空且全部命中 --scope；
//   1 失败——存在越界文件（stdout 逐行列出全部），或变更集为空（防改动已全部提交时
//     静默通过，提示 --base 与未提交改动两种修正）；
//   2 用法错误（缺 --scope、空值、非法参数）或 git 运行错误（非 git 仓库、命令失败）。
//
// 变更集 = git status --porcelain -z 工作区变更（含未跟踪 ??；rename/copy 两侧都算）
//          [--base 给定时] ∪ git diff --name-only <base>..HEAD（已提交部分），去重并集。
//
// 已实测钉住（git 2.55 windows，实现依赖此前提）：
//   - -z 格式的 rename 条目为 "XY 新路径\0旧路径\0"（-> 省略、两侧顺序反转，旧路径是
//     独立 NUL 字段），两侧都必须收录，漏一侧会把半个 rename 误判越界；
//   - status 与 diff 的输出路径恒为仓库根相对（cwd 在子目录也不变），scope 锚定仓库根成立；
//   - core.quotepath=off + -z：非 ASCII 路径原样输出、无引号歧义；
//   - 默认 -unormal 会把"整目录皆未跟踪"折叠成单条 "dir/" 条目：目录前缀 / dir/** 语义
//     对其仍成立，但"精确路径"模式须目录内已有跟踪文件才能逐文件列出——这是 PRD 字面
//     命令的已知缝隙，误报方向（宁严勿漏），不做代码变通。
//
// 零第三方依赖，只用 node: 内置；导出纯函数供本文件测试与 verify.mjs（Task 2）复用。
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// git 输出经 -z/NUL 分隔无转义，路径一律归一正斜杠（Windows git 本为正斜杠，防御性归一）
function normalizePath(p) {
  return p.replaceAll("\\", "/");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// scope glob → 全串锚定 RegExp（语义表见 PRD §3.1）：
//   无 *? 字面 → 精确相等，或作为目录前缀匹配整棵子树（scripts 也匹配 scripts/sub/b.mjs）；
//   ** → 跨段任意（含 /）；* → 单段内任意；? → 恰一个；均不跨 /。
export function globToRegExp(pattern) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    const esc = escapeRegExp(pattern);
    return new RegExp(`^(?:${esc}|${esc}/.*)$`);
  }
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

// 命中任一模式即在范围内
export function matchScope(file, patterns) {
  const f = normalizePath(file);
  return patterns.some((p) => globToRegExp(p).test(f));
}

// porcelain -z 解析：NUL 分隔；rename/copy 条目后跟独立的旧路径字段，两侧都收录
export function parseStatusZ(output) {
  const tokens = output.split("\0");
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const xy = tok.slice(0, 2);
    if (xy.includes("R") || xy.includes("C")) {
      const oldPath = tokens[i + 1] ?? "";
      i++;
      if (oldPath) files.push(normalizePath(oldPath));
    }
    const path = tok.slice(3);
    if (path) files.push(normalizePath(path));
  }
  return files;
}

class UsageError extends Error {}

export function parseArgs(argv) {
  const scopes = [];
  let base = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scope") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--scope 缺少值");
      const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) throw new UsageError(`--scope 值为空: "${value}"`);
      scopes.push(...parts);
    } else if (arg === "--base") {
      const value = argv[++i];
      if (value === undefined || !value.trim()) throw new UsageError("--base 缺少值");
      base = value.trim();
    } else {
      throw new UsageError(`非法参数: ${arg}`);
    }
  }
  if (scopes.length === 0) throw new UsageError("缺少必填参数 --scope");
  return { scopes, base };
}

// git 变更收集：status（+ 可选 <base>..HEAD diff）→ 去重并集。
// spawnSync 同步驱动即可（门禁是短生命周期 CLI，无需并发）。
// maxBuffer 抬到 64MB：默认 1MB 在大仓变更集上会 ENOBUFS 误报 git 失败。
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(cwd, args, what) {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${what} 失败(exit=${r.status}): ${(r.stderr ?? r.error?.message ?? "").trim()}`);
  }
  return r.stdout;
}

export function collectChangedFiles({ cwd = process.cwd(), base = null } = {}) {
  const files = new Set();
  for (const f of parseStatusZ(runGit(cwd, ["status", "--porcelain", "-z"], "status"))) {
    files.add(f);
  }
  if (base !== null) {
    const out = runGit(cwd, ["diff", "--name-only", `${base}..HEAD`], `diff ${base}..HEAD`);
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) files.add(normalizePath(f));
    }
  }
  return [...files];
}

const USAGE = `\
用法: node scripts/check-scope.mjs --scope <pattern>[,<pattern>...] [--scope <pattern>...] [--base <git-ref>]
  --scope  必填，可重复、可逗号分隔；glob 锚定仓库根：无通配符=精确或目录前缀子树，** 跨段，* / ? 不跨段
  --base   可选，git ref（任务回滚点）；给出时变更集 = <base>..HEAD ∪ 工作区变更（含未跟踪）
退出码: 0 通过 / 1 越界或变更集为空 / 2 用法或 git 运行错误`;

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`[check-scope] 用法错误: ${e.message}\n${USAGE}`);
    return 2;
  }

  let files;
  try {
    files = collectChangedFiles({ base: args.base });
  } catch (e) {
    console.error(`[check-scope] 运行错误: ${e.message}`);
    return 2;
  }

  if (files.length === 0) {
    console.error(
      "[check-scope] 变更集为空，判失败（防已全部提交时静默通过）。两种修正：\n" +
        "  ① 传 --base <任务回滚点>，把已提交变更纳入判定；\n" +
        "  ② 确认工作区确有未提交改动后再运行。",
    );
    return 1;
  }

  const scopeDesc = args.scopes.join(", ");
  const outOfScope = files.filter((f) => !matchScope(f, args.scopes));
  if (outOfScope.length > 0) {
    // 越界清单走 stdout（验收 2：逐行列出全部）；汇总结论走 stderr
    for (const f of outOfScope) console.log(`越界: ${f}`);
    console.error(`[check-scope] 失败：${files.length} 个变更文件中 ${outOfScope.length} 个越界（scope: ${scopeDesc}）`);
    return 1;
  }

  console.log(`[check-scope] 通过：变更文件 ${files.length} 个，全部命中声明范围（scope: ${scopeDesc}）`);
  return 0;
}

// 仅直接运行时执行 main（被测试/verify 导入时不产生副作用）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
