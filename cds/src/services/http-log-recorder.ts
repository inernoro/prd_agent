import { performance } from 'node:perf_hooks';
import { recordMainThreadSection } from './main-thread-diagnostics.js';
import { omitHostedSitePreviewBody } from './hosted-site-preview-log-policy.js';
import { redactBodyText, type HttpLogRecord, type HttpLogSink, type PreparedBodySnapshot } from './http-log-store.js';

type LogInput = Omit<HttpLogRecord, '_id' | 'ts'> & { ts?: Date | string };
interface PendingLog {
  record: LogInput;
  body: PreparedBodySnapshot;
  suppressBody: boolean;
  bytes: number;
}

/** Yield between completed read audits, without adding a drop or retry policy. */
export class HttpLogRecorder {
  private readonly pending: PendingLog[] = [];
  private pendingBytes = 0;
  private scheduled?: ReturnType<typeof setImmediate>;
  private closed = false;
  private peakRecords = 0;
  private peakBytes = 0;
  private inlineOverflow = 0;
  private failures = 0;
  private static readonly MAX_RECORDS = 128;
  private static readonly MAX_BYTES = 2 * 1024 * 1024;
  private static readonly MAX_PER_TURN = 4;
  private static readonly TURN_BUDGET_MS = 2;

  constructor(private readonly sink: HttpLogSink | null | undefined, private readonly now = () => performance.now()) {}

  record(record: LogInput, body: PreparedBodySnapshot, suppressBody = false): void {
    if (!this.sink) return;
    const job: PendingLog = { record, body, suppressBody, bytes: 0 };
    const defer = !this.closed && record.method === 'GET' && record.status >= 200 && record.status < 400
      && record.requestKind !== 'sse' && !suppressBody;
    if (defer && this.sink.recordCaptured) {
      this.sink.recordCaptured(record, body);
      return;
    }
    if (!defer) { this.write(job, false); return; }
    // Only plain, already detached metadata and an 8KiB preview copy enter the
    // queue. No req/res, parsed request object or original response Buffer.
    job.bytes = Buffer.byteLength(JSON.stringify(record)) + body.retainedBytes;
    if (this.pending.length >= HttpLogRecorder.MAX_RECORDS || this.pendingBytes + job.bytes > HttpLogRecorder.MAX_BYTES) {
      this.inlineOverflow += 1;
      recordMainThreadSection('http-log.audit-overflow', 0);
      this.write(job, false);
      return;
    }
    this.pending.push(job);
    this.pendingBytes += job.bytes;
    this.peakRecords = Math.max(this.peakRecords, this.pending.length);
    this.peakBytes = Math.max(this.peakBytes, this.pendingBytes);
    this.schedule();
  }

  private write(job: PendingLog, deferred: boolean): void {
    const started = this.now();
    try {
      this.sink!.record({
        ...job.record,
        response: { ...job.record.response, ...omitHostedSitePreviewBody(job.body.snapshot(), job.suppressBody) },
      });
    } finally {
      recordMainThreadSection(deferred ? 'http-log.audit-deferred' : 'http-log.audit-inline', this.now() - started);
    }
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      const started = this.now();
      let count = 0;
      while (this.pending.length && count < HttpLogRecorder.MAX_PER_TURN) {
        this.writeNext();
        count += 1;
        if (this.now() - started >= HttpLogRecorder.TURN_BUDGET_MS) break;
      }
      if (this.pending.length) this.schedule();
    });
  }

  private writeNext(): void {
    const job = this.pending.shift()!;
    this.pendingBytes -= job.bytes;
    try { this.write(job, true); }
    catch (err) {
      this.failures += 1;
      recordMainThreadSection('http-log.audit-failed', 0);
      console.warn(`[http-log] deferred audit failed (${redactBodyText(job.record.requestId).slice(0, 80)}): ${redactBodyText(String(err)).slice(0, 1200)}`);
    }
  }

  /** Called before the sink closes. Later HTTP completions use the inline path. */
  close(): void {
    this.closed = true;
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
    while (this.pending.length) this.writeNext();
  }

  snapshot() {
    return { queuedRecords: this.pending.length, queuedBytes: this.pendingBytes,
      peakRecords: this.peakRecords, peakBytes: this.peakBytes, inlineOverflow: this.inlineOverflow, failures: this.failures };
  }
}
