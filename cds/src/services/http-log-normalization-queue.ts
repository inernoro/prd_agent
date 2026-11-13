import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import type { CapturedHttpLog, HttpLogRecord } from './http-log-store.js';
import { recordMainThreadSection } from './main-thread-diagnostics.js';

interface Job { id: number; input: CapturedHttpLog; bytes: number }
interface Options {
  onNormalized(record: HttpLogRecord, input: CapturedHttpLog): void;
  onInline(input: CapturedHttpLog): void;
  onFailure(error: unknown): void;
  workerFactory?: () => Worker;
}

/** One private CPU worker; at most one message in flight, including startup. */
export class HttpLogNormalizationQueue {
  private worker?: Worker;
  private active?: Job;
  private pending: Job[] = [];
  private bytes = 0;
  private nextId = 0;
  private deadline?: ReturnType<typeof setTimeout>;
  private failed = false;
  private closed = false;
  private termination: Promise<unknown> = Promise.resolve();
  private waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private stats = { normalized: 0, inline: 0, capacityFallback: 0, workerFailures: 0,
    processingFailures: 0, peakRecords: 0, peakBytes: 0 };
  private static readonly MAX_RECORDS = 128;
  private static readonly MAX_BYTES = 2 * 1024 * 1024;

  constructor(private readonly options: Options) {}

  enqueue(input: CapturedHttpLog): void {
    if (this.closed || this.failed) { this.inline(input); return; }
    const bytes = Buffer.byteLength(JSON.stringify(input.record)) + input.body.bytes.byteLength;
    if (this.pending.length + Number(Boolean(this.active)) >= HttpLogNormalizationQueue.MAX_RECORDS
      || this.bytes + bytes > HttpLogNormalizationQueue.MAX_BYTES) {
      this.stats.capacityFallback += 1;
      this.inline(input);
      return;
    }
    this.pending.push({ id: ++this.nextId, input, bytes });
    this.bytes += bytes;
    this.stats.peakRecords = Math.max(this.stats.peakRecords, this.pending.length + Number(Boolean(this.active)));
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
    this.pump();
  }

  private inline(input: CapturedHttpLog): void {
    this.stats.inline += 1;
    const started = performance.now();
    try { this.options.onInline(input); }
    catch (error) { this.stats.processingFailures += 1; this.options.onFailure(error); }
    finally { recordMainThreadSection('http-log.audit-fallback', performance.now() - started); }
  }

  private pump(): void {
    if (this.closed || this.failed || this.active || !this.pending.length) { this.settle(); return; }
    try {
      if (!this.worker) {
        this.worker = this.options.workerFactory?.() ?? new Worker(new URL('./http-log-normalization-worker.js', import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
        this.worker.on('message', message => this.received(message));
        this.worker.on('error', error => this.degrade(error));
        this.worker.on('messageerror', error => this.degrade(error));
        this.worker.on('exit', code => this.degrade(new Error(`worker exited (${code})`)));
      }
      this.worker.ref();
      this.active = this.pending.shift()!;
      // A wedged or failed worker cannot retain the queue indefinitely. This is
      // a background failure detector, not an HTTP/deployment timeout change.
      this.deadline = setTimeout(() => this.degrade(new Error('normalization worker deadline exceeded')), 5000);
      this.worker.postMessage({ id: this.active.id, input: this.active.input });
    } catch (error) { this.degrade(error); }
  }

  private received(message: { id?: number; record?: HttpLogRecord; error?: string }): void {
    if (!this.active || this.closed || this.failed) return;
    const job = this.active;
    if (message.id !== job.id || !message.record || message.error
      || message.record.requestId !== job.input.record.requestId || !(message.record.ts instanceof Date)) {
      this.degrade(new Error('invalid normalization worker response'));
      return;
    }
    clearTimeout(this.deadline); this.deadline = undefined;
    this.active = undefined; this.bytes -= job.bytes;
    const started = performance.now();
    try { this.options.onNormalized(message.record, job.input); this.stats.normalized += 1; }
    catch (error) { this.stats.processingFailures += 1; this.options.onFailure(error); }
    finally { recordMainThreadSection('http-log.audit-worker-delivery', performance.now() - started); }
    this.pump();
  }

  private detach(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
    if (this.worker) {
      const worker = this.worker; this.worker = undefined;
      worker.removeAllListeners();
      // An initialization error can arrive after intentional detachment.
      worker.on('error', () => {});
      this.termination = worker.terminate().catch(error => {
        this.stats.processingFailures += 1; this.options.onFailure(error);
      });
    }
  }

  private drainInline(): void {
    const jobs = [...(this.active ? [this.active] : []), ...this.pending];
    this.active = undefined; this.pending = []; this.bytes = 0;
    for (const job of jobs) this.inline(job.input);
    this.settle();
  }

  private degrade(error: unknown): void {
    if (this.failed || this.closed) return;
    this.failed = true; this.stats.workerFailures += 1;
    this.options.onFailure(error);
    this.detach(); this.drainInline();
  }

  private settle(): void {
    if (this.active || this.pending.length) return;
    this.worker?.unref();
    for (const waiter of this.waiters.splice(0)) {
      if (this.stats.processingFailures) waiter.reject(new Error('HTTP audit normalization incomplete'));
      else waiter.resolve();
    }
  }

  flush(): Promise<void> {
    if (!this.active && !this.pending.length) return this.stats.processingFailures
      ? Promise.reject(new Error('HTTP audit normalization incomplete')) : Promise.resolve();
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.detach(); this.drainInline();
    await this.termination;
    await this.flush();
  }

  snapshot() { return { ...this.stats, queuedRecords: this.pending.length + Number(Boolean(this.active)), queuedBytes: this.bytes }; }
}
