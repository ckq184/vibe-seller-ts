// SSE 广播总线 + 帧格式：与原 event_bus + sse-starlette 契约一致——
// 每条消息一行 JSON 放 data: 字段（无自定义 event 名），空闲 30s 发 {"type":"ping"}。

import type { StreamWriter } from "./types";

export class EventBus {
  private readonly subscribers = new Set<StreamWriter>();
  private pingTimer: NodeJS.Timeout | undefined;
  /** 事件留痕（测试与排障）；不持久化、不回放——与原实现一致。 */
  history: { type: string; data: Record<string, unknown> }[] = [];

  subscribe(writer: StreamWriter): () => void {
    this.subscribers.add(writer);
    this.ensurePing();
    return () => {
      this.subscribers.delete(writer);
      if (this.subscribers.size === 0) this.stopPing();
    };
  }

  emit(type: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify({ type, ...data });
    this.history.push({ type, data });
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    for (const writer of [...this.subscribers]) {
      try {
        writer.write(`data: ${payload}\n\n`);
      } catch {
        this.subscribers.delete(writer);
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  private ensurePing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const writer of [...this.subscribers]) {
        try {
          writer.write(`data: {"type":"ping"}\n\n`);
        } catch {
          this.subscribers.delete(writer);
        }
      }
    }, 30_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
