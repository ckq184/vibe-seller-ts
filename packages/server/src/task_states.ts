// 任务状态机（逐字对齐 app/task_states.py 的 TRANSITIONS 与命名组）。

export const TASK_STATUSES = [
  "pending",
  "queued",
  "designing",
  "planned",
  "running",
  "waiting",
  "completed",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(["queued", "designing", "running", "failed"]),
  queued: new Set(["designing", "running", "failed"]),
  designing: new Set(["planned", "running", "completed", "waiting", "failed"]),
  planned: new Set(["queued", "running", "designing", "completed", "failed"]),
  running: new Set(["completed", "failed", "waiting"]),
  waiting: new Set(["queued", "completed", "failed"]),
  completed: new Set(["pending", "designing", "running", "waiting"]),
  failed: new Set(["pending", "queued", "designing", "running"]),
};

export const STOPPABLE = new Set(["designing", "planned", "running", "waiting"]);
export const ACTIVE = new Set(["designing", "running"]);
export const WAKEABLE = new Set(["waiting"]);
export const RETRIABLE = new Set(["failed", "pending", "completed"]);
export const STARTABLE = new Set(["pending", "failed"]);
export const DESIGNABLE = new Set(["pending", "failed", "planned"]);

export function canTransition(fromS: string, toS: string): boolean {
  return TRANSITIONS[fromS]?.has(toS) ?? false;
}

export function assertTransition(fromS: string, toS: string): void {
  if (!canTransition(fromS, toS)) {
    throw new Error(`Invalid task transition: ${JSON.stringify(fromS)} -> ${JSON.stringify(toS)}`);
  }
}
