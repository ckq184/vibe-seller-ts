// verify 一键脚本（宪法门禁①，PRD 路线3 §3.2 Task 2）：四门禁合成一条命令。
//
// 用法: npm run verify -- --scope <pattern>[,<pattern>...] [--scope <pattern>...] [--base <git-ref>]
//
// 门禁顺序（失败即短序，后续门禁不执行；四门禁缺一不可，无跳过开关）：
//   ① npm run typecheck        ② npm test
//   ③ npm run build:server     ④ node scripts/check-scope.mjs <透传参数>
//
// 退出码：0 四门禁全过 / 1 任一门禁失败（含缺 --scope 时门禁④标记失败）/
//         2 本脚本用法错误（只认 --scope/--base，其他参数一律非法）。
// 注意：缺 --scope 不是用法错误——门禁④直接标记失败（前三个门禁照常跑完），
// 打印 check-scope 用法提示；这样不存在"跳过门禁④"的用法通道。
//
// spawn 处理沿用 scripts/package-release.mjs run() 的先例：
//   - npm 系命令在 Windows 是 npm.cmd shim，必须经 shell；shell 模式拼单条命令
//     字符串、args 传空数组（args 数组 + shell 触发 DEP0190 弃用告警）；
//   - check-scope 用 process.execPath + 参数数组直 spawn（不经 shell）：
//     glob 模式（**）里的特殊字符经 shell 需引号转义且 Windows 会丢，参数数组免疫。
//
// 零第三方依赖，只用 node: 内置；导出 parseVerifyArgs / buildGates / runGates（runner 可注入）
// 供本文件测试（verify.test.mjs，fake runner 不真跑 npm）复用。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SCOPE_SCRIPT = join(root, "scripts", "check-scope.mjs");
const CHECK_SCOPE_DISPLAY = "node scripts/check-scope.mjs";

class UsageError extends Error {}

// argv → { scopes, base }。--scope 可重复、可逗号分隔；只认 --scope/--base。
// 区分两种失败：--scope 给了但为空/参数非法 → throw UsageError（main 退出 2）；
// --scope 整个缺失 → 返回 scopes=null（buildGates 把门禁④标记为失败，退出 1）。
export function parseVerifyArgs(argv) {
  const scopes = [];
  let base = null;
  let hasScopeFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scope") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--scope 缺少值");
      const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) throw new UsageError(`--scope 值为空: "${value}"`);
      hasScopeFlag = true;
      scopes.push(...parts);
    } else if (arg === "--base") {
      const value = argv[++i];
      if (value === undefined || !value.trim()) throw new UsageError("--base 缺少值");
      base = value.trim();
    } else {
      throw new UsageError(`非法参数: ${arg}`);
    }
  }
  return { scopes: hasScopeFlag ? scopes : null, base };
}

// 与 check-scope.mjs 的 USAGE 保持同步（未导出，只能复制；改动两处同改）。
const CHECK_SCOPE_USAGE = `\
check-scope 用法: node scripts/check-scope.mjs --scope <pattern>[,<pattern>...] [--scope <pattern>...] [--base <git-ref>]
  --scope  必填，可重复、可逗号分隔；glob 锚定仓库根：无通配符=精确或目录前缀子树，** 跨段，* / ? 不跨段
  --base   可选，git ref（任务回滚点）；给出时变更集 = <base>..HEAD ∪ 工作区变更（含未跟踪）`;

// 四门禁命令表。npm 系门禁 spawn.shell=true（npm.cmd shim 必须经 shell）；
// 门禁④ spawn.shell=false（execPath + 参数数组直 spawn）。
export function buildGates({ scopes, base } = {}) {
  // ④ 透传参数：每个 pattern 单独一个 --scope（check-scope 可重复），--base 原样。
  // 直 spawn 不经 shell，** 等 glob 字符原样抵达，无需任何引号转义。
  const passthrough = [];
  for (const s of scopes ?? []) passthrough.push("--scope", s);
  if (base) passthrough.push("--base", base);

  const npmGate = (name, commandLine) => ({
    name,
    display: commandLine,
    spawn: { file: commandLine, args: [], shell: true },
  });

  const gates = [
    npmGate("① 类型检查", "npm run typecheck"),
    npmGate("② 测试", "npm test"),
    npmGate("③ 构建", "npm run build:server"),
    {
      name: "④ diff 范围检查",
      display: [CHECK_SCOPE_DISPLAY, ...passthrough].join(" "),
      spawn: { file: process.execPath, args: [CHECK_SCOPE_SCRIPT, ...passthrough], shell: false },
    },
  ];

  if (scopes === null) {
    // 四门禁缺一不可：缺 --scope 不提供"跳过④"通道，直接把④标记为失败
    gates[3].preFailed = "缺少必填参数 --scope（四门禁缺一不可，无跳过开关）";
    gates[3].usageHint = CHECK_SCOPE_USAGE;
  }
  return gates;
}

// 默认 runner：同步 spawn（门禁串行、短生命周期 CLI，无需并发），stdio inherit
// 让门禁实时输出可见。返回退出码；spawn 本身失败（如 node 缺失）按门禁失败处理返回 1。
function defaultRunner(gate) {
  const { file, args, shell } = gate.spawn;
  const r = spawnSync(file, shell ? [] : args, {
    cwd: root,
    stdio: "inherit",
    shell,
  });
  if (r.error) {
    console.error(`[verify] 门禁进程无法启动: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s - m * 60).toFixed(1)}s`;
}

// 顺序执行门禁并实时打印横幅。runner 可注入（测试用 fake，不真跑 npm）。
// io 可注入（测试收集断言）。返回结构化结论：
//   { ok, failed: { name, display, exitCode, reason? } | null, results: [{name, display, ok, ms}], totalMs }
export function runGates(gates, runner = defaultRunner, io = { log: console.log, error: console.error }) {
  const results = [];
  const started = Date.now();
  for (const gate of gates) {
    if (gate.preFailed) {
      // 预失败门禁（缺 --scope 的门禁④）：不调用 runner，打印结论与用法提示后短序
      io.log(`[verify] 门禁${gate.name} 失败：${gate.preFailed}`);
      if (gate.usageHint) io.error(gate.usageHint);
      return {
        ok: false,
        failed: { name: gate.name, display: gate.display, exitCode: null, reason: gate.preFailed },
        results,
        totalMs: Date.now() - started,
      };
    }
    io.log(`[verify] 门禁${gate.name} 开始：${gate.display}`);
    const t0 = Date.now();
    const exitCode = runner(gate);
    const ms = Date.now() - t0;
    if (exitCode !== 0) {
      io.log(`[verify] 门禁${gate.name} 失败（exit=${exitCode}，耗时 ${fmtDuration(ms)}）：${gate.display}`);
      return {
        ok: false,
        failed: { name: gate.name, display: gate.display, exitCode },
        results,
        totalMs: Date.now() - started,
      };
    }
    io.log(`[verify] 门禁${gate.name} 通过（耗时 ${fmtDuration(ms)}）`);
    results.push({ name: gate.name, display: gate.display, ok: true, ms });
  }
  return { ok: true, failed: null, results, totalMs: Date.now() - started };
}

const USAGE = `\
用法: npm run verify -- --scope <pattern>[,<pattern>...] [--scope <pattern>...] [--base <git-ref>]
  --scope  透传给门禁④（check-scope），可重复、可逗号分隔；glob 锚定仓库根
  --base   透传给门禁④（check-scope），git ref（任务回滚点）
只认 --scope / --base；四门禁缺一不可，无跳过开关
退出码: 0 四门禁全过 / 1 任一门禁失败 / 2 用法错误`;

// runner/io 可注入：verify.test.mjs 用 fake runner 测编排（§7.5），不真跑 npm
export function main(argv, { runner, log = console.log, error = console.error } = {}) {
  let args;
  try {
    args = parseVerifyArgs(argv);
  } catch (e) {
    error(`[verify] 用法错误: ${e.message}\n${USAGE}`);
    return 2;
  }

  const outcome = runGates(buildGates(args), runner, { log, error });

  if (outcome.ok) {
    log("[verify] 四门禁全部通过：");
    for (const r of outcome.results) {
      log(`  ${r.name}  ${r.display} — ${fmtDuration(r.ms)}`);
    }
    log(`[verify] 总耗时 ${fmtDuration(outcome.totalMs)}`);
    return 0;
  }

  const f = outcome.failed;
  const detail = f.reason ?? `exit=${f.exitCode}`;
  error(`[verify] 失败门禁：${f.name}（${f.display}，${detail}）`);
  return 1;
}

// 仅直接运行时执行 main（被测试导入时不产生副作用，同 check-scope.mjs）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
