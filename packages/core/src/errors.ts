import type { RunErrorCode } from "./types";

/** 错误分类法：可重试（rate_limited/timeout/provider_unavailable）与不可重试（其余）。 */
const RETRYABLE: ReadonlySet<string> = new Set(["rate_limited", "timeout", "provider_unavailable"]);

export class RunError extends Error {
  readonly code: RunErrorCode;
  readonly retryable: boolean;

  constructor(code: RunErrorCode, message: string, retryable: boolean = RETRYABLE.has(code)) {
    super(message);
    this.name = "RunError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 适配器约定的中止错误形态（避免依赖 DOM lib）。 */
export function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 把适配器抛出的任意错误归一到 RunError 语义；用户取消不在这里处理。 */
export function normalizeError(err: unknown): RunError {
  if (err instanceof RunError) return err;
  return new RunError("runtime_error", err instanceof Error ? err.message : String(err));
}
