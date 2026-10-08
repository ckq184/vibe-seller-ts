// 最小 PostHog 传输客户端（PRD §3.4 预裁决：零新依赖，不引入 posthog SDK）。
// 对齐 posthog-python 默认异步客户端的调用面子集：capture 只入队（内存队列），
// flushAt=20 或 10s 定时触发批量 POST {host}/batch/，body 形状
// {"api_key": key, "batch": [{event, distinct_id, properties, timestamp, type:"capture"}]}。
// 传输函数可注入（测试注入假 post，绝不真网）；POST 失败只 debug 级吞掉——
// 遥测永远不能影响业务（与原 telemetry.send 全量吞异常同语义）。

export interface BatchMessage {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
  type: "capture";
}

export type PostFn = (url: string, body: string) => Promise<void>;

/** core.ts 持有的客户端最小面（PosthogTransport 实现；测试注入桩）。 */
export interface TelemetryClient {
  capture(distinctId: string, event: string, properties: Record<string, unknown>): void;
  /** posthog-python identify 的最小等价：$identify capture，属性挂 $set。 */
  identify(distinctId: string, properties: Record<string, unknown>): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PosthogTransportOptions {
  apiKey: string;
  host: string;
  flushAt?: number;
  flushIntervalMs?: number;
  /** 注入点：默认 fetch POST。测试注入假函数，绝不真网。 */
  post?: PostFn;
}

function defaultPost(): PostFn {
  return async (url, body) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!resp.ok) throw new Error(`posthog batch failed: HTTP ${resp.status}`);
  };
}

export class PosthogTransport implements TelemetryClient {
  private readonly queue: BatchMessage[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly apiKey: string;
  private readonly host: string;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly post: PostFn;

  constructor(opts: PosthogTransportOptions) {
    this.apiKey = opts.apiKey;
    this.host = opts.host;
    this.flushAt = opts.flushAt ?? 20; // posthog-python 默认 flush_at
    this.flushIntervalMs = opts.flushIntervalMs ?? 10_000; // 默认 10s 定时 flush
    this.post = opts.post ?? defaultPost();
  }

  capture(distinctId: string, event: string, properties: Record<string, unknown>): void {
    this.enqueue({
      event,
      distinct_id: distinctId,
      properties,
      timestamp: new Date().toISOString(),
      type: "capture",
    });
  }

  identify(distinctId: string, properties: Record<string, unknown>): void {
    // posthog-python 的 identify 即一条 '$identify' 事件、属性进 $set——最小复刻。
    this.enqueue({
      event: "$identify",
      distinct_id: distinctId,
      properties: { $set: { ...properties } },
      timestamp: new Date().toISOString(),
      type: "capture",
    });
  }

  private enqueue(msg: BatchMessage): void {
    this.queue.push(msg);
    if (this.queue.length >= this.flushAt) {
      void this.flush();
      return;
    }
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.(); // 不阻止进程退出
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 排空队列并发一批；失败 debug 级吞掉、队列丢弃（不重试，PRD §7 非目标）。 */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.post(`${this.host}/batch/`, JSON.stringify({ api_key: this.apiKey, batch }));
    } catch (err) {
      console.debug("[vibe-telemetry] batch flush failed:", err instanceof Error ? err.message : err);
    }
  }

  async shutdown(): Promise<void> {
    this.clearTimer();
    await this.flush();
  }
}
