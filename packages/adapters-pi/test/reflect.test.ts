import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initialState } from "@vibe/core";
import type { RunAfterContext } from "@vibe/runtime";
import { createReflector } from "../src/index";

const task = { id: "t1", input: { store: "noon-sg" } };
const ctx: RunAfterContext = {
  runId: "r1",
  task,
  run: { runId: "r1", sessionId: "s1", task, status: "completed", startedAt: 1, updatedAt: 2 },
  events: [],
  state: initialState(task),
};

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("任务后反思（createReflector）", () => {
  it("模型给出经验 → 追加写入知识笔记（含时间戳小节）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-reflect-"));
    cleanup.push(dir);
    const notesFile = join(dir, "stores", "noon-sg", "notes.md");
    const reflect = createReflector({
      ask: async () => "- Reports 页签的报表中心 URL 模式为 /reports?type={reportType}",
      notesFile,
      clock: () => "2026-09-24T00:00:00Z",
    });

    await reflect(ctx);
    const content = await readFile(notesFile, "utf8");
    expect(content).toContain("## Skill follow-ups (2026-09-24T00:00:00Z)");
    expect(content).toContain("/reports?type={reportType}");
  });

  it("模型回答 NONE → 不落任何文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-reflect-"));
    cleanup.push(dir);
    const notesFile = join(dir, "notes.md");
    const reflect = createReflector({
      ask: async () => "NONE",
      notesFile,
    });

    await reflect(ctx);
    await expect(readFile(notesFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
