// 一次 run 产出什么——只在一处裁决（TS 移植 app/task_outcome.py，语义逐条对齐）。
//
// 优先级（最佳交付物优先）：
//   1. accepted_result —— 通过全部门槛的提交 → DELIVERED
//   2. submitted_result —— 已提交被拒、保留 → INCOMPLETE（缺口作 caveats）
//   3. transcript_tail  —— 流式 prose（聊天即答案的合法交付物）→ DELIVERED
//   4. 空               —— FAILED（"什么都没产出"≠"失败"，reason 可为 None）
// infra 错误压倒一切；agent 自报错误（error_category=agent_reported）降级为 caveat。

export const AGENT_REPORTED = "agent_reported";

export type OutcomeKind = "delivered" | "incomplete" | "failed";

/** OutcomeKind → 终态的唯一映射；任何调用方不得特判。INCOMPLETE 也算完成。 */
export const TERMINAL_STATUS: Record<OutcomeKind, string> = {
  delivered: "completed",
  incomplete: "completed",
  failed: "failed",
};

export interface TaskOutcome {
  kind: OutcomeKind;
  content?: string;
  caveats: string[];
  reason?: string;
  category?: string | null;
}

export interface OutcomeTask {
  accepted_result: string | null;
  submitted_result: string | null;
  transcript_tail: string | null;
  review_gaps: string | null;
  error: string | null;
  error_category: string | null;
}

function text(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function gaps(task: OutcomeTask): string[] {
  if (!task.review_gaps) return [];
  try {
    const parsed = JSON.parse(task.review_gaps) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((g) => String(g)).filter((g) => g.trim());
  } catch {
    return [];
  }
}

/** 纯函数：从任务行读出唯一裁决。可重复调用。 */
export function resolveOutcome(task: OutcomeTask): TaskOutcome {
  const error = text(task.error);
  const category = task.error_category;
  const agentReported = Boolean(error) && category === AGENT_REPORTED;

  if (error && !agentReported) {
    return { kind: "failed", reason: error, caveats: [], category };
  }
  const agentCaveat = agentReported && error ? [error] : [];

  const accepted = text(task.accepted_result);
  if (accepted) {
    return { kind: "delivered", content: accepted, caveats: [...gaps(task), ...agentCaveat] };
  }
  const submitted = text(task.submitted_result);
  if (submitted) {
    return { kind: "incomplete", content: submitted, caveats: [...gaps(task), ...agentCaveat] };
  }
  const prose = text(task.transcript_tail);
  if (prose && !error) {
    return { kind: "delivered", content: prose, caveats: [] };
  }
  return { kind: "failed", reason: error, caveats: [], category: category ?? null };
}

function rendered(outcome: TaskOutcome): string | undefined {
  if (outcome.content === undefined) return undefined;
  if (outcome.caveats.length === 0) return outcome.content;
  const lines = outcome.caveats.map((c) => `> - ${c}`).join("\n");
  return `${outcome.content}\n\n> ⚠️ **未完成项 / Unmet**\n${lines}`;
}

/** 丢弃本 run 的全部输入（turn 范围）；retry 时 resetSubmissions。 */
export function clearRunStateColumns(): {
  result: null;
  accepted_result: null;
  submitted_result: null;
  review_gaps: null;
  transcript_tail: null;
  error: null;
  error_category: null;
} {
  return {
    result: null,
    accepted_result: null,
    submitted_result: null,
    review_gaps: null,
    transcript_tail: null,
    error: null,
    error_category: null,
  };
}

/** 把裁决写回任务行。不写 status（调用方经 assert_transition 落）。 */
export function applyOutcome(
  task: OutcomeTask & { result: string | null; submission_count?: number },
  outcome: TaskOutcome,
): void {
  if (outcome.kind === "failed") {
    // 只记录 run 真实报过的错误；给"什么都没产出"编造错误会让
    // WAITING-for-input 分支被吞掉
    if (outcome.reason !== undefined) {
      task.error = outcome.reason;
      task.error_category = outcome.category ?? null;
    }
    return;
  }
  task.result = rendered(outcome) ?? null;
  // caveats 持久化回 review_gaps（agent 自报错误是其中之一；
  // finalizer 会跑多次，只存在于 error 的 caveat 第二遍就丢了）
  task.review_gaps = outcome.caveats.length ? JSON.stringify(outcome.caveats) : null;
  task.error = null;
  task.error_category = null;
}
