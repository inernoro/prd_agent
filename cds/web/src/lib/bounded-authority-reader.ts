/** Observation-only GET budget. It never retries or cancels a business command. */
export class BoundedAuthorityReader<T> {
  private revision = 0;
  private dirty = false;
  private disposed = false;
  private active?: { cancel: () => void };

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<T>,
    private readonly apply: (value: T) => void,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly timeoutMs = 5000,
  ) {}

  /** Reconnect/filter changes discard the old observation and begin a new one. */
  start(): void {
    this.disposed = false;
    this.invalidate();
    this.refresh();
  }

  /** Event bursts retain one latest demand, not one promise per event. */
  refresh(): void {
    if (this.disposed) return;
    this.revision++;
    if (this.active) { this.dirty = true; return; }
    this.begin();
  }

  /** A successful command receipt supersedes reads issued before the receipt. */
  invalidate(): void {
    this.revision++;
    this.dirty = false;
    const active = this.active;
    this.active = undefined;
    active?.cancel();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private begin(): void {
    const revision = this.revision;
    this.dirty = false;
    const controller = new AbortController();
    let rejectWait!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
    const task = { cancel: () => {
      clearTimeout(timer);
      rejectWait(new DOMException('Observation superseded', 'AbortError'));
      controller.abort();
    } };
    this.active = task;
    const timer = setTimeout(() => {
      // Release our waiter even when an injected/non-fetch reader ignores abort.
      rejectWait(new Error('Authoritative observation timed out'));
      controller.abort();
    }, this.timeoutMs);
    let result: Promise<T>;
    try { result = this.read(controller.signal); }
    catch (error) { result = Promise.reject(error); }
    void Promise.race([result, cancelled]).then(value => {
      if (this.active === task && !this.disposed && revision === this.revision) this.apply(value);
    }, error => {
      if (this.active === task && !this.disposed) this.onError(error);
    }).finally(() => {
      clearTimeout(timer);
      if (this.active !== task) return;
      this.active = undefined;
      if (!this.disposed && this.dirty) this.begin();
    }).catch(() => {
      // Observation callbacks cannot become unhandled task failures.
    });
  }
}
