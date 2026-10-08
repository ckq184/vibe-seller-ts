// 确定性 catalog 桩契约（app/workspace/catalog_validation.py 逐条移植）。
// CATALOG.md 把"有实质内容"的文件标成 Empty/stub 摘要 → 写边界直接拒绝，
// 契约从写面上就不可违反，不依赖弱模型的 empty-vs-substantive 判断。
// rejectWrongStubs 抛 HttpError(400)——对应原 ValueError → HTTPException(400)。

import { HttpError } from "../types";

// 必须与同步提示词让 agent 为空文件写的摘要串一致（prompts CATALOG_DESC_L2/L3）。
export const STUB_SUMMARY = "Empty/stub — knowledge accumulates here";

// 正文词数（去掉 YAML frontmatter、markdown 标题行、空行后）低于该值的文件
// 没有可摘要的内容——合法桩；达到即有主题，必须摘要不得打桩。
const MIN_BODY_WORDS = 5;

export function isNearEmpty(content: string): boolean {
  let s = content;
  if (s.startsWith("---")) {
    const end = s.indexOf("\n---", 3);
    if (end !== -1) s = s.slice(end + 4);
  }
  const words: string[] = [];
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    words.push(...t.split(/\s+/).filter(Boolean));
  }
  return words.length < MIN_BODY_WORDS;
}

/** 产出表格每个数据行的 (file_path, summary)；跳过表头与 |---| 分隔行。 */
function dataRows(catalogText: string): [string, string][] {
  const rows: [string, string][] = [];
  for (const line of catalogText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (!cells.join("").replace(/[-: ]/g, "")) continue; // 分隔行
    if (cells[0]!.toLowerCase() === "file") continue; // 表头
    const path = cells[0]!;
    const summary = cells[cells.length - 1]!;
    if (path.includes("/")) rows.push([path, summary]); // 真实工作区路径，非标签
  }
  return rows;
}

/** catalog 打了桩但文件有实质内容的路径清单。读不到的文件跳过（没有内容无法证伪桩）。 */
export function findWronglyStubbed(catalogText: string, readText: (relPath: string) => string | null): string[] {
  const bad: string[] = [];
  for (const [path, summary] of dataRows(catalogText)) {
    if (!summary.includes(STUB_SUMMARY)) continue;
    let content: string | null = null;
    try {
      content = readText(path);
    } catch {
      content = null;
    }
    if (content !== null && !isNearEmpty(content)) bad.push(path);
  }
  return bad;
}

/** CATALOG 把有内容的文件打了桩 → 抛 400（写边界调用）。 */
export function rejectWrongStubs(catalogText: string, readText: (relPath: string) => string | null): void {
  const bad = findWronglyStubbed(catalogText, readText);
  if (bad.length > 0) {
    const listed = bad.slice(0, 10).join(", ");
    throw new HttpError(
      400,
      `CATALOG marks ${bad.length} file(s) as "${STUB_SUMMARY}" but they have real content: ${listed}. Read each and write a ` +
        "one-line topic summary (≤80 chars) instead of the stub, then write CATALOG.md again.",
    );
  }
}
