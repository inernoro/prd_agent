import type { ServerResponse } from 'node:http';

/** 当前所有使用该发送器的连接共用预算；后续项目订阅也须接入同一实例。 */
export class SsePendingBudget {
  private used = 0;
  constructor(readonly limit = 64 * 1024 * 1024) {}
  reserve(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes; return true;
  }
  release(bytes: number): void { this.used = Math.max(0, this.used - bytes); }
  get bytes(): number { return this.used; }
}
export const ssePendingBudget = new SsePendingBudget();

export class BoundedSseWriter {
  private queue: Array<{ frame: string; cost: number }> = [];
  private queuedCost = 0;
  private reserved = 0;
  private blocked = false;
  private closed = false;
  private disposed = false;
  private ending = false;
  private timer?: NodeJS.Timeout;
  constructor(private readonly res: ServerResponse, private readonly onDrop: (reason: string) => void,
    private readonly budget = ssePendingBudget, private readonly limit = 1024 * 1024, private readonly stallMs = 5000) {
    res.on('drain', this.drain); res.on('close', this.dispose);
  }
  send(event: string, data: unknown): boolean {
    if (this.closed || this.ending || this.res.destroyed || this.res.writableEnded) return false;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const cost = Math.max(1024, Buffer.byteLength(frame));
    this.reconcile();
    if (this.closed) return false;
    if (this.reserved + cost > this.limit || !this.budget.reserve(cost)) {
      this.drop('日志连接消费过慢或发送容量已满，请重新打开日志。'); return false;
    }
    this.reserved += cost;
    if (this.blocked) { this.queue.push({ frame, cost }); this.queuedCost += cost; }
    else this.write(frame);
    this.reconcile(); return !this.closed;
  }
  end(): void {
    if (this.closed) return;
    this.ending = true;
    if (!this.queue.length && !this.blocked) { this.res.end(); }
  }
  getStats(): { pendingBytes: number; queuedFrames: number; closed: boolean } {
    this.reconcile(); return { pendingBytes: this.reserved, queuedFrames: this.queue.length, closed: this.closed };
  }
  private write(frame: string): void {
    try {
      if (!this.res.write(frame)) {
        this.blocked = true;
        this.timer ??= setTimeout(() => this.drop('日志连接长时间未消费，请重新打开日志。'), this.stallMs);
        this.timer.unref?.();
      }
    } catch { this.drop('日志连接已断开，请重新打开日志。'); }
  }
  private readonly drain = (): void => {
    if (this.closed) return;
    this.blocked = false; clearTimeout(this.timer); this.timer = undefined;
    while (this.queue.length && !this.blocked && !this.closed) {
      const next = this.queue.shift()!; this.queuedCost -= next.cost;
      this.write(next.frame); this.reconcile();
    }
    this.reconcile();
    if (this.ending && !this.blocked && !this.queue.length) { this.res.end(); }
  };
  private reconcile(): void {
    if (this.closed) return;
    const current = this.queuedCost + this.res.writableLength;
    if (current > this.reserved) {
      if (current > this.limit || !this.budget.reserve(current - this.reserved)) { this.drop('日志发送容量已满，请重新打开日志。'); return; }
      this.reserved = current;
    }
    if (current < this.reserved) { this.budget.release(this.reserved - current); this.reserved = current; }
  }
  private drop(reason: string): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    this.queue = []; this.queuedCost = 0;
    // 待发送数组可以立即释放；transport还没close时不能提前归还它占用的全局预算。
    const transport = Math.min(this.reserved, this.res.writableLength);
    this.budget.release(this.reserved - transport); this.reserved = transport;
    this.res.off('drain', this.drain);
    try { this.onDrop(reason); } finally { this.res.destroy(); }
  }
  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true; this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    this.queue = []; this.queuedCost = 0; this.budget.release(this.reserved); this.reserved = 0;
    this.res.off('drain', this.drain); this.res.off('close', this.dispose);
  };
}
