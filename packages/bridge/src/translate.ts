// 事件翻译：AgentEvent → 桥 SSE 帧（vibe-seller 前端词汇表）。
// 纯逻辑、有状态（门计数、usage 缓存、respond 文本缓存），逐字段对齐
// docs/bridge-protocol.md 的映射表；原 Python 侧消费方 TsAgentBackend 已随
// Phase 5.2 退役，现为 server 编排器/assistant 进程内消费同一词表。

import type { AgentEvent } from "@vibe/core";

export interface BridgeEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface DonePayload {
  task_id: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  result_text: string;
  error_code?: string;
  interrupted?: boolean;
  missing_materials?: string[];
  usage?: Record<string, unknown>;
}

function messageFrame(taskId: string, role: string, content: string): BridgeEvent {
  return { event: "message", data: { task_id: taskId, role, content } };
}

/**
 * 每 run 一个翻译器。run_started 的 user 帧由 server 依据 persist_prompt 补发；
 * 这里只翻译 AgentEvent 流。
 */
export function createTranslator(taskId: string): {
  translate: (ev: AgentEvent) => BridgeEvent[];
  done: DonePayload | undefined;
} {
  let gateSeq = 0;
  let usage: Record<string, unknown> | undefined;
  let respondText: string | undefined;
  let done: DonePayload | undefined;
  let lastToolStatus: "success" | "error" | undefined;

  return {
    get done() {
      return done;
    },
    translate(ev: AgentEvent): BridgeEvent[] {
      switch (ev.type) {
        case "run_started":
        case "model_requested":
        case "tool_started":
        case "human_input_received":
        case "usage_reported":
          if (ev.type === "usage_reported") {
            usage = { ...ev.usage } as Record<string, unknown>;
          }
          return [];
        case "tool_completed":
          // 与紧随其后的 observation_added 配对：payload 无自述状态时兜底
          lastToolStatus = ev.status;
          return [];
        case "decision_made":
          if (ev.decision.kind === "call_tool") {
            return [
              messageFrame(taskId, "tool_use", JSON.stringify({ tool: ev.decision.intent.name, input: ev.decision.intent.arguments })),
            ];
          }
          if (ev.decision.kind === "respond" && typeof ev.decision.content === "string") {
            respondText = ev.decision.content;
          }
          return [];
        case "observation_added": {
          const obs = (ev.observation ?? {}) as {
            status?: string;
            ok?: boolean;
            error?: { code?: string };
          };
          let ok: string;
          if (obs.error?.code === "approval_denied") ok = "denied";
          else if (typeof obs.status === "string") ok = obs.status;
          else if (typeof obs.ok === "boolean") ok = obs.ok ? "success" : "error";
          else if (lastToolStatus) ok = lastToolStatus;
          else ok = "unknown";
          return [
            messageFrame(taskId, "agent_event", JSON.stringify({ event: "observation", tool: ev.name, ok })),
          ];
        }
        case "human_input_requested":
          // 确认闸门挂起：run 保持活连接（awaiting_human），发问题卡片等批复
          gateSeq += 1;
          return [
            {
              event: "questions",
              data: { task_id: taskId, request_id: `gate-${gateSeq}`, questions: [{ question: ev.question, kind: "tool_approval" }] },
            },
          ];
        case "run_resumed":
          return [{ event: "status", data: { task_id: taskId, status: "running" } }];
        case "run_completed": {
          const resultText = typeof ev.result === "string" ? ev.result : respondText ?? "";
          const missing = ev.missingMaterial ?? [];
          done = {
            task_id: taskId,
            status: ev.status === "complete" ? "completed" : "partial",
            result_text: resultText,
            ...(missing.length > 0 ? { missing_materials: missing } : {}),
            ...(usage ? { usage } : {}),
          };
          return [
            messageFrame(taskId, "result", resultText),
            ...(ev.status === "partial" ? [messageFrame(taskId, "agent_event", JSON.stringify({ event: "partial", missing: missing }))] : []),
            { event: "done", data: { ...done } },
          ];
        }
        case "run_failed":
          done = {
            task_id: taskId,
            status: "failed",
            result_text: "",
            error_code: ev.error.code,
            ...(usage ? { usage } : {}),
          };
          return [messageFrame(taskId, "system", ev.error.message), { event: "done", data: { ...done } }];
        case "run_cancelled":
          done = {
            task_id: taskId,
            status: "cancelled",
            result_text: respondText ?? "",
            interrupted: true,
            ...(usage ? { usage } : {}),
          };
          return [{ event: "done", data: { ...done } }];
        default:
          return [];
      }
    },
  };
}
