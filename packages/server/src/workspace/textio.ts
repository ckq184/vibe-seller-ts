// 工作区文本 IO 的平台换行对齐（批次 4.7.2 录制回放契约）。
//
// 原实现所有工作区文本文件都经 Python open(newline=None) 文本模式写：
// Windows 落盘 \r\n、读取 universal-newlines 归一回 \n。TS 侧 writeFileSync /
// readFileSync 不做翻译——同一台 Windows 机器上 Python 写的文件 TS 读出 \r、
// workspace tree 的 size 也逐字节漂移（fixture：notes/replay.md 10 vs 9 等）。
// 对齐策略：写侧在 win32 做 \n→\r\n；读侧统一 \r\n→\n（等于 universal newlines）。
// 非 Windows 平台两侧都不翻译，行为不变。

import { readFileSync, writeFileSync } from "node:fs";

export function writeTextSync(path: string, content: string): void {
  writeFileSync(path, process.platform === "win32" ? content.replace(/\n/g, "\r\n") : content, "utf8");
}

export function readTextSync(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** 已解码文本的 universal-newlines 归一（readFile 的 TextDecoder 路径复用）。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
