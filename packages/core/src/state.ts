import type { AgentEvent, AgentState, Decision, Run, RunStatus, Task } from "./types";

export interface Observation {
  name: string;
  data: unknown;
}

export function initialState(task: Task): AgentState {
  return { task, messages: [], observations: [], iteration: 0 };
}

/** 不可变转移：任何一步都不得原地修改 state。 */
export function applyDecision(state: AgentState, decision: Decision): AgentState {
  return { ...state, messages: [...state.messages, { role: "decision", decision }] };
}

export function applyHumanInput(state: AgentState, input: unknown): AgentState {
  return { ...state, messages: [...state.messages, { role: "human", input }] };
}

export function applyObservation(state: AgentState, observation: Observation): AgentState {
  return {
    ...state,
    messages: [...state.messages, { role: "observation", observation }],
    observations: [...state.observations, observation],
    iteration: state.iteration + 1,
  };
}

/**
 * 从单个 run 的事件序列（sequence 升序）重建 AgentState。
 * 纯函数：同一事件列表重放两次结果全等 —— 回放幂等是崩溃恢复的前提。
 */
export function replayState(events: readonly AgentEvent[]): AgentState | undefined {
  let state: AgentState | undefined;
  for (const event of events) {
    switch (event.type) {
      case "run_started":
        state = initialState(event.task);
        break;
      case "decision_made":
        if (state) state = applyDecision(state, event.decision);
        break;
      case "observation_added":
        if (state) state = applyObservation(state, { name: event.name, data: event.observation });
        break;
      case "human_input_received":
        if (state) state = applyHumanInput(state, event.input);
        break;
      default:
        break;
    }
  }
  return state;
}

/** 从事件日志推导 Run（含终态）。事件日志是唯一事实源，快照只是缓存。 */
export function deriveRun(events: readonly AgentEvent[]): Run | undefined {
  const start = events.find((e): e is Extract<AgentEvent, { type: "run_started" }> => e.type === "run_started");
  if (!start) return undefined;
  let status: RunStatus = "running";
  for (const event of events) {
    switch (event.type) {
      case "run_completed":
        status = "completed";
        break;
      case "run_failed":
        status = "failed";
        break;
      case "run_cancelled":
        status = "cancelled";
        break;
      case "human_input_requested":
        status = "awaiting_human";
        break;
      default:
        break;
    }
  }
  return {
    runId: start.runId,
    sessionId: start.sessionId,
    task: start.task,
    status,
    startedAt: start.timestamp,
    updatedAt: events[events.length - 1]?.timestamp ?? start.timestamp,
  };
}
