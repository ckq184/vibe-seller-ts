// secret 扫描模块（宪法门禁④，PRD 路线3 §二④/§四/§五.3/§五.8/§六）：
// git commit 前扫描 staged 变更内容，命中已知密钥模式即拒绝提交并列出文件与行号，
// 拦截"密钥入仓库历史"（verify 是提交后门禁，拦不住泄漏，故必须挂在提交前）。
//
// 形态：可单测的纯函数（PATTERNS / maskSecret / scanLine / scanText / looksBinary /
// loadAllowlist）+ CLI 入口 main（`node scan-secrets.mjs`，由同目录 hook 入口 pre-commit
// 转发调用）。零第三方依赖，只用 node: 内置（PRD §二④ 方案 B 裁决：不用 gitleaks，
// 自写扫描覆盖面窄但确定性强、完全 TDD 可钉、离线可用）。
//
// 规格锚点（PRD §四）：
//   - 扫描对象：staged Added/Modified（Deleted 跳过——staged 内容已不存在，
//     `git show :path` 无从读取；二进制跳过——numstat 两列为 "-" 或 UTF-8 解码含
//     NUL/替换符）。只看 staged，不扫 unstaged/未跟踪（PRD §六.5）。
//   - 模式表：PATTERNS 七条，逐条注释说明针对的密钥形状；显式模式、无高熵启发式
//     （PRD §六.6：误报面不可控）。诚实边界 = "已知模式 + 可审查 allowlist"。
//   - 打码：命中串只留前 4 后 2 字符 + "…"（如 68kV…hAh），短于 8 位全打码；
//     任何输出路径（结构化结果、stdout/stderr）绝不完整回显命中串（宪法第 3 条）。
//   - allowlist：scripts/githooks/secret-allowlist.json，命中行匹配任一条目正则即放行；
//     文件入仓可审查，每条必须带 note。读工作区版本（而非 staged 版本）——这样
//     "给本提交新增放行条目" 时新条目即时生效，否则永远无法自举放行。
//   - 修复指引：从源移除 / 入 env / 若已泄漏先轮换再清理。
//
// 明示取舍（PRD §六.2）：--no-verify 可整体绕过本 hook，git hook 层无防御手段；
// 防绕过靠代码质量审查核对 diff，不由本门禁承担。
//
// 退出码（同 commit-msg.mjs / check-scope.mjs 约定）：0 干净 / 1 命中拒绝 /
// 2 用法或运行错误（非 git 仓、git 失败、allowlist 损坏——损坏时 fail loud，
// 不静默按空表放行）。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 密钥模式表（PRD §四首版七条；顺序即报告顺序）。全部显式写在常量中，
// 逐条注释说明针对的密钥形状。注意：本文件自身的源码行也会被本扫描器扫过
// （pre-commit 扫 staged 时本文件在仓内），故注释里不写可命中的密钥字面量。
export const PATTERNS = [
  // StepFun / OpenAI 形 API key："sk-" 前缀 + ≥16 位连续密钥字符（本仓 bridge/agent 供应商 key 的常见形状）
  { name: "stepfun-openai-sk", re: /sk-[A-Za-z0-9]{16,}/ },
  // Anthropic 鉴权凭据赋值行：ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 后接 =/: 与
  // ≥16 位连续密钥字符（本仓敏感区域清单点名的两个环境变量名，拦"名字=值"整行入仓）
  { name: "anthropic-token-assign", re: /ANTHROPIC_(AUTH_TOKEN|API_KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/ },
  // AWS AccessKey ID：固定 "AKIA" 前缀 + 16 位大写字母/数字（IAM 长期密钥标识）
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  // 私钥块头：PEM / OpenSSH 私钥文件起始行（命中即整块私钥泄漏的开始，RSA/EC/OPENSSH/通用变体）
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // GitHub token 双分支：经典 ghp_ 前缀（后接 ≥30 位 token 字符）与
  // 细粒度 PAT 的 github_pat_ 前缀（后接 ≥20 位）
  { name: "github-token", re: /ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/ },
  // Slack token："xox" + 类型字母（b/a/p/r/s 五族 token 前缀）+ "-" + ≥10 位 token 字符
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  // 企业微信机器人 webhook 带 key：固定 URL 路径 + 32 位十六进制 key（持有即可向该群发消息）
  { name: "wecom-webhook-key", re: /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[0-9a-f]{32}/ },
];

// 打码：命中串只留前 4 后 2 字符 + "…"（如 68kV…hAh）；短于 8 位全打码。
// 唯一允许"密钥形状"出现在输出的通道，保证不完整回显（宪法第 3 条）。
export function maskSecret(s) {
  if (s.length < 8) return "*".repeat(s.length);
  return s.slice(0, 4) + "…" + s.slice(-2);
}

// allowlines → RegExp[]。条目接受 {re, note}（allowlist JSON 形状）或纯正则串。
function compileAllowlines(allowlines) {
  return (allowlines ?? []).map((a) => (typeof a === "string" ? a : a.re)).map((re) => new RegExp(re));
}

function lineAllowed(line, allowRes) {
  return allowRes.some((re) => re.test(line));
}

// 单行内收集所有模式的首次命中（每模式最多一条，含位置供打码行重建）
function collectMatches(line) {
  const matches = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(line);
    if (m) matches.push({ name: p.name, index: m.index, text: m[0] });
  }
  return matches;
}

// 重建"打码行"：按位置从左到右把每个命中替换为打码串。若两模式命中区间重叠
// （本模式集下只会是包含关系，如 anthropic 赋值行包含其值内的 sk- 串），后者不再
// 重复替换——其打码形态仍通过 hits[].masked 单独呈现。
function buildMaskedLine(line, matches) {
  const sorted = [...matches].sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  let out = "";
  let pos = 0;
  for (const m of sorted) {
    if (m.index < pos) continue; // 与已打码区间重叠：行内不重复替换
    out += line.slice(pos, m.index) + maskSecret(m.text);
    pos = m.index + m.text.length;
  }
  return out + line.slice(pos);
}

// 扫描单行。allowlines：allowlist 条目数组（{re, note} 或正则串）。
// 返回 { hits: [{name, masked}] }；命中行匹配任一 allowlist 正则 → hits 为空。
export function scanLine(line, allowlines = []) {
  const allowRes = compileAllowlines(allowlines);
  if (lineAllowed(line, allowRes)) return { hits: [] };
  return {
    hits: collectMatches(line).map((m) => ({ name: m.name, masked: maskSecret(m.text) })),
  };
}

// 扫描整段文本。返回命中行数组 [{line(1 基), hits, maskedLine}]，无命中的行不出现。
export function scanText(text, allowlines = []) {
  const allowRes = compileAllowlines(allowlines);
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineAllowed(line, allowRes)) continue;
    const matches = collectMatches(line);
    if (matches.length === 0) continue;
    findings.push({
      line: i + 1,
      hits: matches.map((m) => ({ name: m.name, masked: maskSecret(m.text) })),
      maskedLine: buildMaskedLine(line, matches),
    });
  }
  return findings;
}

// 二进制判定（PRD §四：numstat "-" 之外的第二道防线）：
// 缓冲含 NUL 字节，或按 UTF-8 解码出现替换符 U+FFFD（非法字节序列）→ 视为二进制跳过。
export function looksBinary(buf) {
  if (buf.includes(0)) return true;
  return buf.toString("utf8").includes("\uFFFD");
}

// 读 allowlist。文件缺失 → []（零放行，最严格方向，不报错）；
// JSON 损坏 / 形状非法 / 条目缺 re 或 note → 抛错（PRD §四：每条必须带 note；
// 损坏时静默按空表会无声丢失放行条目造成困惑，故 fail loud，由 main 转退出 2）。
export function loadAllowlist(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw); // SyntaxError 上抛
  if (!parsed || !Array.isArray(parsed.allowlines)) {
    throw new Error("secret-allowlist.json 形状非法：缺少 allowlines 数组");
  }
  for (const entry of parsed.allowlines) {
    if (!entry || typeof entry.re !== "string" || !entry.re) {
      throw new Error("secret-allowlist.json 条目非法：缺少非空 re 字段");
    }
    if (typeof entry.note !== "string" || !entry.note) {
      throw new Error(`secret-allowlist.json 条目非法（${entry.re}）：缺少 note 字段（每条必须写明为什么放行，PRD §四）`);
    }
  }
  return parsed.allowlines;
}

function gitRun(args, cwd, encoding) {
  return spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// CLI/共享入口。argv 仅作形态兼容（与 commit-msg.mjs 的 main 同形，argv[2] 未用）。
// options.cwd：hook 经入口调用时 = git 传入的仓库根（git 以仓库根为 cwd 调 hook）；
// 测试可注入 temp 仓。options.allowlistPath：测试注入；默认 = 本模块同目录的
// secret-allowlist.json（工作区版本，见文件头 allowlist 说明）。
// 返回退出码：0 干净 / 1 命中拒绝 / 2 运行错误。
export function main(argv, { cwd = process.cwd(), allowlistPath } = {}) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const listPath = allowlistPath ?? join(moduleDir, "secret-allowlist.json");

  let allowlines;
  try {
    allowlines = loadAllowlist(listPath);
  } catch (err) {
    console.error(`[pre-commit secret 扫描] 运行错误：allowlist 无法加载（${listPath}）：${err.message}`);
    return 2;
  }

  // staged 清单：name-status 取 Added/Modified/Typechanged，Deleted 跳过
  // （staged 删除后索引里已无该路径，内容无从读取也无须读取）。
  // --no-renames：把重命名拆成 D+A，状态/路径一一对应，免解析 R 带分数的 -z 形状。
  const ns = gitRun(["diff", "--cached", "--name-status", "--no-renames", "-z"], cwd, "utf8");
  if (ns.error || ns.status !== 0) {
    console.error(`[pre-commit secret 扫描] 运行错误：git diff --cached 失败：${ns.stderr || ns.error?.message || `exit=${ns.status}`}（cwd=${cwd}，须在 git 仓库内执行）`);
    return 2;
  }

  // 二进制清单：numstat 两列含 "-" 即二进制（PRD §四第一道防线）
  const numstat = new Map(); // path → isBinary
  const nm = gitRun(["diff", "--cached", "--numstat", "--no-renames", "-z"], cwd, "utf8");
  if (!nm.error && nm.status === 0) {
    for (const rec of nm.stdout.split("\0")) {
      if (!rec) continue;
      const fields = rec.split("\t");
      const path = fields.slice(2).join("\t");
      numstat.set(path, fields[0] === "-" || fields[1] === "-");
    }
  }

  const entries = [];
  const nsParts = ns.stdout.split("\0");
  for (let i = 0; i + 1 < nsParts.length; i += 2) {
    entries.push({ status: nsParts[i], path: nsParts[i + 1] });
  }

  const findings = [];
  let scanned = 0;
  let skippedBinary = 0;
  let skippedDeleted = 0;

  for (const { status, path } of entries) {
    if (status === "D") {
      skippedDeleted++;
      continue;
    }
    if (numstat.get(path) === true) {
      skippedBinary++;
      continue;
    }
    // 逐文件读 staged 内容（git show :path = 索引版本，不读工作区——被 staged 的才是要提交的）
    const show = gitRun(["show", `:${path}`], cwd, "buffer");
    if (show.error || show.status !== 0) {
      console.error(`[pre-commit secret 扫描] 运行错误：无法读取 staged 内容 :${path}：${show.stderr || show.error?.message || `exit=${show.status}`}`);
      return 2;
    }
    if (looksBinary(show.stdout)) {
      skippedBinary++;
      continue;
    }
    scanned++;
    for (const f of scanText(show.stdout.toString("utf8"), allowlines)) {
      findings.push({ file: path, ...f });
    }
  }

  if (findings.length === 0) return 0;

  const hitCount = findings.reduce((n, f) => n + f.hits.length, 0);
  console.error(`[pre-commit secret 扫描] 发现 ${findings.length} 行 / ${hitCount} 处疑似密钥，提交被拒绝：\n`);
  for (const f of findings) {
    for (const h of f.hits) {
      console.error(`  ${f.file}:${f.line} [${h.name}] ${f.maskedLine}`);
    }
  }
  console.error(`\n修复指引（宪法第 3 条 / PRD §四）：`);
  console.error(`  1. 从源文件移除该密钥，改为环境变量或本地配置注入，不入仓库；`);
  console.error(`  2. 若该密钥已真实泄漏，先轮换（revoke + 重新签发）再清理内容；`);
  console.error(`  3. 确属合法假密钥/文档示例（如测试 fixture）：在 scripts/githooks/secret-allowlist.json`);
  console.error(`     增加 {re, note} 条目（note 写明出处，入仓可审查），审查后再提交。`);
  if (scanned === 0 && (skippedBinary > 0 || skippedDeleted > 0)) {
    console.error(`  （本次 staged 变更全部为二进制或删除，已跳过）`);
  }
  return 1;
}

// 仅直接运行时执行（被 hook 入口/测试导入时不产生副作用，同 commit-msg.mjs 约定）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv);
}
