export interface DiagnosticResult {
  inspect?: Record<string, unknown>;
  logs?: import('./server-event-log-store.js').ServerEventRecord['logs'];
  error?: { message: string };
}

interface Job {
  ref: string;
  scope: string;
  resolve: (result: DiagnosticResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CacheEntry {
  id: string;
  promise: Promise<DiagnosticResult>;
  completedAt?: number;
}

const failure = (message: string): DiagnosticResult => ({ error: { message } });

/** Bounds diagnostic IO only; every lifecycle event still reaches the event sink. */
export class ContainerDiagnosticBudget {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queue: Job[] = [];
  private active = false;

  constructor(
    private readonly collect: (ref: string, scope: string) => Promise<DiagnosticResult>,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(id: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.id === id) this.cache.delete(key);
    }
  }

  collectFor(ref: string, scope: string): Promise<DiagnosticResult> {
    for (const [key, entry] of this.cache) {
      if (entry.completedAt !== undefined && this.now() - entry.completedAt >= 5000) this.cache.delete(key);
    }
    // Names and truncated IDs can refer to a different instance after recreation.
    const key = /^[a-f0-9]{64}$/.test(ref) ? JSON.stringify([ref, scope]) : undefined;
    const existing = key && this.cache.get(key);
    if (existing) return existing.promise;
    if (this.active && this.queue.length >= 16) return Promise.resolve(failure('diagnostic_capacity'));
    while (this.cache.size >= 64) {
      const completed = [...this.cache].find(([, entry]) => entry.completedAt !== undefined);
      if (!completed) return Promise.resolve(failure('diagnostic_capacity'));
      this.cache.delete(completed[0]);
    }
    const promise = this.enqueue(ref, scope);
    if (key) {
      const entry: CacheEntry = { id: ref, promise };
      this.cache.set(key, entry);
      void promise.then(() => {
        // A start/restart invalidation must also fence an older in-flight result.
        if (this.cache.get(key) === entry) entry.completedAt = this.now();
      });
    }
    return promise;
  }

  private enqueue(ref: string, scope: string): Promise<DiagnosticResult> {
    return new Promise(resolve => {
      const job: Job = { ref, scope, resolve, timer: setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          resolve(failure('diagnostic_queue_timeout'));
        }
      }, 5000) };
      this.queue.push(job);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    clearTimeout(job.timer);
    this.active = true;
    void Promise.resolve().then(() => this.collect(job.ref, job.scope))
      .catch(() => failure('diagnostic_collect_failed'))
      .then(job.resolve)
      .finally(() => { this.active = false; this.drain(); });
  }
}
