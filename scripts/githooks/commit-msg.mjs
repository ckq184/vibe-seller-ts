// commit-msg 校验模块（宪法门禁③，PRD 路线3 §二③/§三）：把宪法第 8 条提交格式
// （Conventional Commits）做成机器门禁，替代落地表第 8 条的"过渡期人工核对"。
//
// 形态：可单测的纯函数 validateCommitMessage + CLI 入口（`node commit-msg.mjs <msgfile>`，
// 由同目录 hook 入口 commit-msg 转发调用）。零第三方依赖，只用 node: 内置。
//
// 规格锚点（PRD §三）：
//   - 只校验提交信息文件的首行（subject）；多行 message 只看首行。
//   - 合法格式：^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?: \S.*$
//     （类型白名单 + 可选 parenthetical scope + ": " 后非空 subject）。
//   - "范围 - 摘要" 的 " - " 分隔符不机审（裁决：仓内 " - "/" + " 两种 house style
//     并存，机审会误拒合法风格；见 PRD §三）。
//   - 豁免（首行匹配即放行）：`Merge ` 开头 / `Revert "` 开头 / `fixup! `、`squash! ` 前缀。
//   - 明示取舍：--no-verify 可绕过本 hook，git hook 层无防御手段（PRD §三）。
//
// 退出码（同 check-scope.mjs 约定）：0 通过 / 1 格式拒绝 / 2 用法或运行错误。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 宪法第 8 条类型白名单（顺序与宪法原文一致）
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "chore",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
  "style",
  "revert",
];

const VALID_RE = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([^)]+\\))?: \\S.*$`);

// 豁免前缀（首行匹配即放行；前缀精确到字符，"Merge branch/x"、"Reverted" 不豁免）
const EXEMPT_RES = [/^Merge /, /^Revert "/, /^fixup! /, /^squash! /];

// 校验提交信息首行。返回 { ok, errors }：ok=false 时 errors 逐条列出具体违规点
// （未知类型并列出白名单 / 缺 ": " / 空 subject / 空消息），全部中文并标注条款出处。
export function validateCommitMessage(firstLine) {
  const line = typeof firstLine === "string" ? firstLine : "";

  for (const re of EXEMPT_RES) {
    if (re.test(line)) return { ok: true, errors: [] };
  }

  if (line.trim() === "") {
    return {
      ok: false,
      errors: [
        "空消息：提交信息首行（subject）不能为空，必须以 \"type: 摘要\" 形式开头（宪法第 8 条 Conventional Commits）。",
      ],
    };
  }

  if (VALID_RE.test(line)) return { ok: true, errors: [] };

  const errors = [];
  const headMatch = line.match(/^([^(:\s]+)/);
  const head = headMatch ? headMatch[1] : "";

  if (!COMMIT_TYPES.includes(head)) {
    errors.push(
      `未知提交类型 "${head || "（行首无类型词元）"}"：类型必须在白名单内：${COMMIT_TYPES.join("|")}（宪法第 8 条）。`,
    );
  }

  // 类型词元之后剥掉一个可选 parenthetical scope，再检查分隔符与 subject
  const afterHead = line.slice(head.length).replace(/^\([^)]+\)/, "");
  if (!afterHead.startsWith(": ")) {
    errors.push(
      "缺少 \": \" 分隔：类型（及可选 scope）后必须紧跟英文冒号+空格，形如 \"feat: 摘要\" 或 \"feat(scope): 摘要\"（宪法第 8 条）。",
    );
  } else if (!/^: \S/.test(afterHead)) {
    errors.push(
      "subject 为空或以空白开头：\": \" 之后必须紧跟非空 subject（宪法第 8 条）。",
    );
  }

  return { ok: false, errors };
}

// CLI/共享入口：argv[2] = 提交信息文件（git commit-msg hook 传入 $1）。
// 只读首行校验（PRD §三：多行 message 只看首行）。
// 返回退出码：0 通过 / 1 格式拒绝 / 2 用法或运行错误。
export function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("用法错误：缺少 <msgfile> 参数。git commit-msg hook 会自动传入提交信息文件路径；手动调用形如：node commit-msg.mjs <msgfile>");
    return 2;
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`运行错误：无法读取提交信息文件 ${file}：${err.message}`);
    return 2;
  }

  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const { ok, errors } = validateCommitMessage(firstLine);
  if (ok) return 0;

  console.error("提交被拒绝：提交信息不符合宪法第 8 条（Conventional Commits）格式：");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`合法格式：type(scope): 摘要，type ∈ ${COMMIT_TYPES.join("|")}`);
  return 1;
}

// 仅直接运行时执行 main（被 hook 入口导入时不产生副作用，同 verify.mjs 约定）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv);
}
