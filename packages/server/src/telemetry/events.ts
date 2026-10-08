// 事件名常量（app/telemetry_events.py 的 TelemetryEvent 移植——蛇形命名保留为
// 字符串值，常量名转 camelCase）。硬编码字符串漂移会让看板悄悄丢维度，所有
// 发射点统一引用本文件。
// 差异记录：DAILY_HEARTBEAT（'daily_heartbeat'）不移植——原实现中无任何发送点，
// 属死代码（PRD §3.3 预裁决）。

export const TelemetryEvent = {
  APP_STARTED: "app_started",

  STORE_CREATED: "store_created",
  STORE_DELETED: "store_deleted",

  TASK_CREATED: "task_created",
  TASK_COMPLETED: "task_completed",
  TASK_FAILED: "task_failed",
  TASK_RESUMED: "task_resumed", // 原实现在 task_runner_exec.py 硬编码字符串，非常量

  SCHEDULE_FIRED: "schedule_fired",

  SETTING_CHANGED: "setting_changed",
  USER_PREF_CHANGED: "user_pref_changed",

  AI_PROFILE_CREATED: "ai_profile_created",
  AI_PROFILE_DELETED: "ai_profile_deleted",
  AI_PROFILE_DEFAULT_SET: "ai_profile_default_set",

  EMAIL_ACCOUNT_ADDED: "email_account_added",
  EMAIL_ACCOUNT_REMOVED: "email_account_removed",

  ZINIAO_ACCOUNT_ADDED: "ziniao_account_added",
  ZINIAO_ACCOUNT_REMOVED: "ziniao_account_removed",

  INTEGRATION_GWS_ENABLED: "integration_gws_enabled",
  INTEGRATION_GWS_DISABLED: "integration_gws_disabled",

  ADMIN_USER_CREATED: "admin_user_created",
  ADMIN_USER_DELETED: "admin_user_deleted",

  BROWSER_SESSION_ATTEMPTED: "browser_session_attempted",
  BROWSER_SESSION_STARTED: "browser_session_started",
  BROWSER_SESSION_FAILED: "browser_session_failed",
} as const;

/** 浏览器会话放弃的原因——error_category 的有界基数（BrowserFailureReason）。 */
export const BrowserFailureReason = {
  WSL_NOT_RUNNING: "wsl_not_running",
  WSL_WRONG_PORT: "wsl_wrong_port",
  NORMAL_MODE: "normal_mode",
  WRONG_PORT: "wrong_port",
  LAUNCH_FAILED: "launch_failed",
  STARTUP_TIMEOUT: "startup_timeout",
} as const;

/** 失败发生在任务生命周期的哪个阶段（TaskFailurePhase）。 */
export const TaskFailurePhase = {
  PRE_RUNNING: "pre_running",
  RUNNING: "running",
  PIPELINE: "pipeline",
} as const;

/** task.error_category 未设时的粗分桶兜底（TaskFailureCategory）。 */
export const TaskFailureCategory = {
  ZINIAO_UNAVAILABLE: "ziniao_unavailable",
  NO_RESULT: "no_result",
  AGENT_SET_ERROR: "agent_set_error",
  CLI_ERROR: "cli_error",
  UNHANDLED_EXCEPTION: "unhandled_exception",
} as const;
