import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveRun, type AgentEvent, type Run } from "@vibe/core";

export interface RunLog {
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(runId: string): Promise<AgentEvent[]>;
  loadRun(runId: string): Promise<Run | undefined>;
}

/**
 * append-only JSONL，一个 run 一个文件。
 * 事件日志是 run 的唯一事实源：崩溃后从这里回放恢复；
 * Session 快照只是缓存，允许落后。
 */
export class JsonlRunLog implements RunLog {
  constructor(private readonly dir: string) {}

  private file(runId: string): string {
    return join(this.dir, `${runId}.jsonl`);
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(event.runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    try {
      const text = await readFile(this.file(runId), "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AgentEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async loadRun(runId: string): Promise<Run | undefined> {
    const events = await this.listEvents(runId);
    if (events.length === 0) return undefined;
    return deriveRun(events);
  }
}
