/**
 * 单消费者异步通道：Runtime 内部驱动循环与外部事件迭代器解耦。
 * live 流只服务一个消费者；副消费方（审计、回放、重算）从 RunLog 读。
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;
  private failure: { error: unknown } | undefined;

  push(value: T): void {
    if (this.closed) return; // 消费方提前离场不反噬驱动循环
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  close(error?: unknown): void {
    this.closed = true;
    if (error !== undefined) this.failure = { error };
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.closed) {
          return this.failure
            ? Promise.reject(this.failure.error)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
