// 任务级遥测助手（app/telemetry_tasks.py 的移植）。独立成文件以免
// task_runner_exec 对应物（agent/orchestrator.ts）膨胀。匿名 + 隐私安全。
// 两条失败语义分开保真（PRD §6.3 预裁决）：
//   - task_completed：统计查询失败 → 静默降级（空 skills / 计数 0）仍发送；
//   - task_failed：同步无统计，直接按给定 phase/category 发送。

import type { DatabaseSync } from "node:sqlite";
import { ProfileManager } from "../profiles/manager";
import { DEFAULT_PROFILE_ID, profileKind } from "../profiles/presets";
import * as telemetry from "./core";
import { TaskFailureCategory, TaskFailurePhase, TelemetryEvent } from "./events";

// .claude/skills/<name>/SKILL.md 结尾的 Read 工具路径 → 技能名
const SKILL_PATH_RE = /\.claude\/skills\/([^/]+)\/SKILL\.md$/;

/** homeDir → ProfileManager 备忘（telemetry 专用；调用方各自持有实例语义不同）。 */
const managers = new Map<string, ProfileManager>();
function profilesFor(homeDir: string): ProfileManager {
  let m = managers.get(homeDir);
  if (!m) {
    m = new ProfileManager(ProfileManager.defaultPath(homeDir));
    managers.set(homeDir, m);
  }
  return m;
}

// 原 ai.profiles.profile_kind_for_id：'default'/空 → 'default'；否则按
// ANTHROPIC_BASE_URL 比对预设得隐私安全枚举（kimi/glm/…/custom）。
export function profileKindForId(homeDir: string, profileId: string | null | undefined): string {
  if (!profileId || profileId === DEFAULT_PROFILE_ID) return "default";
  return profileKind(profilesFor(homeDir).getProfile(profileId) ?? null);
}

/** 任务里 agent 实际加载过的内置技能（Read tool_use 行的 file_path 匹配）。 */
function skillsUsedInTask(db: DatabaseSync, taskId: string): string[] {
  let rows: { content: string }[];
  try {
    rows = db.prepare("SELECT content FROM task_messages WHERE task_id = ? AND role = 'tool_use'").all(taskId) as {
      content: string;
    }[];
  } catch {
    return [];
  }
  const skills = new Set<string>();
  for (const { content } of rows) {
    if (typeof content !== "string") continue;
    let path = "";
    try {
      const data = JSON.parse(content) as { tool_input?: { file_path?: string }; input?: { file_path?: string } };
      path = data.tool_input?.file_path ?? data.input?.file_path ?? "";
    } catch {
      continue;
    }
    const m = SKILL_PATH_RE.exec(path || "");
    if (m && !m[1]!.startsWith("__")) skills.add(m[1]!);
  }
  return [...skills].sort().slice(0, 20);
}

function toolUseCount(db: DatabaseSync, taskId: string): number {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND role = 'tool_use'").get(taskId) as {
      n: number;
    };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

interface TaskTelemetryRow {
  id: string;
  store_id: string | null;
  schedule_id: string | null;
  plan_mode: number | null;
  ai_profile_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_category: string | null;
}

export function sendTaskCompleted(db: DatabaseSync, homeDir: string, task: TaskTelemetryRow): void {
  let skillsUsed: string[] = [];
  let toolCount = 0;
  try {
    skillsUsed = skillsUsedInTask(db, task.id);
    toolCount = toolUseCount(db, task.id);
  } catch {
    /* 静默降级仍发送 */
  }
  const durationSecs = telemetry.durationSecondsFromIso(task.started_at, task.completed_at);
  telemetry.send(TelemetryEvent.TASK_COMPLETED, {
    is_store_task: task.store_id !== null,
    was_planned: Boolean(task.plan_mode),
    duration_bucket: telemetry.durationBucket(durationSecs),
    duration_seconds: durationSecs,
    is_scheduled: task.schedule_id !== null,
    ai_profile_kind: profileKindForId(homeDir, task.ai_profile_id),
    tool_use_count_bucket: telemetry.countBucket(toolCount),
    tool_use_count: toolCount,
    skills_used: skillsUsed,
  });
}

export function sendTaskFailed(
  db: DatabaseSync,
  homeDir: string,
  task: TaskTelemetryRow,
  phase: (typeof TaskFailurePhase)[keyof typeof TaskFailurePhase],
  fallbackCategory: string,
): void {
  telemetry.send(TelemetryEvent.TASK_FAILED, {
    is_store_task: task.store_id !== null,
    was_planned: Boolean(task.plan_mode),
    phase,
    error_category: task.error_category || fallbackCategory, // DB 字段优先
    is_scheduled: task.schedule_id !== null,
    ai_profile_kind: profileKindForId(homeDir, task.ai_profile_id),
  });
}

/** 唤醒遥测行（task_resumed）：等待时长从 wait_condition.waiting_since 推导。 */
export function sendTaskResumed(db: DatabaseSync, homeDir: string, taskId: string): void {
  const task = db
    .prepare("SELECT id, store_id, schedule_id, plan_mode, ai_profile_id, wait_condition FROM tasks WHERE id = ?")
    .get(taskId) as (TaskTelemetryRow & { wait_condition: string | null }) | undefined;
  if (!task) return;
  let condition: { waiting_since?: string; woken_by?: string; check_strategy?: string } = {};
  try {
    condition = (JSON.parse(task.wait_condition ?? "{}") ?? {}) as typeof condition;
  } catch {
    /* 坏 condition 按空处理 */
  }
  let waitSecs: number | null = null;
  if (condition.waiting_since) {
    const since = Date.parse(condition.waiting_since);
    if (!Number.isNaN(since)) waitSecs = Math.max(0, Math.trunc((Date.now() - since) / 1000));
  }
  // 原 execute_woken_task：woken_by 缺省取 check_strategy，再缺省 'manual'
  const wakeReason = condition.woken_by ?? condition.check_strategy ?? "manual";
  // 原实现在此处硬编码 'task_resumed' 字符串（非常量），保持一致
  telemetry.send("task_resumed", {
    is_store_task: task.store_id !== null,
    wait_duration_bucket: telemetry.durationBucket(waitSecs),
    wake_reason: wakeReason,
    ai_profile_kind: profileKindForId(homeDir, task.ai_profile_id),
  });
}

export { TaskFailureCategory, TaskFailurePhase };
