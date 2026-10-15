import type { IShellExecutor } from '../types.js';
import type { ObservationStreamExecutor } from './observation-stream-executor.js';
import { shellQuoteArg } from './secure-database-cli.js';
import type { ServerEventLogSink, ServerEventSeverity } from './server-event-log-store.js';

const DEFAULT_UNITS = ['cds-master.service', 'cds-forwarder.service'];
const DEFAULT_JOURNAL_PRIORITY = 'warning..alert';
const MAX_JOURNAL_LINE_BYTES = 64 * 1024;
const JOURNAL_PROCESS_BATCH = 100;
const MAX_CURSOR_BYTES = 1024 * 1024;

function severityFromJournal(priority: unknown, message: string): ServerEventSeverity {
  const p = Number(priority);
  const lower = message.toLowerCase();
  if (p <= 3 || /fatal error|heap out of memory|allocation failed|uncaughtexception|unhandledrejection|\boom\b|panic|segmentation fault|main process exited|failed with result|core-dump/.test(lower)) {
    return 'error';
  }
  if (p === 4 || /\bwarn(?:ing)?\b| 502 | 503 |bad gateway|service unavailable|upstream error|request failed|shutdown|stopping|stopped|started/.test(lower)) {
    return 'warn';
  }
  return 'info';
}

export function shouldRecordJournalMessage(severity: ServerEventSeverity, message: string): boolean {
  if (severity !== 'info') return true;
  const lower = message.toLowerCase();
  if (/persistent .* enabled|listening on|worker proxy listening|started cds-|stopped cds-/.test(lower)) return true;
  // Health checks and successful proxy lines are already covered by HTTP logs
  // and otherwise dominate this collection under normal traffic.
  if (/\[proxy\] get \/(healthz|readyz)\b/.test(lower)) return false;
  if (/^\[proxy\] (get|post|put|delete|patch) /.test(lower)) return false;
  return false;
}

export function parseJournalLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return { MESSAGE: line };
  }
}

export function journalPriorityArgs(): string[] {
  const value = (process.env.CDS_JOURNAL_PRIORITY || DEFAULT_JOURNAL_PRIORITY).trim();
  if (!value || value.toLowerCase() === 'all') return [];
  return ['-p', value];
}

export class SystemLogMonitor {
  private enabled = false;
  private running?: Promise<void>;
  private connection?: AbortController;
  private restartTimer?: NodeJS.Timeout;
  private seenCursors = new Set<string>();
  private cursorBytes = 0;
  private bufferedBytes = 0;
  private overflowLines = 0;
  private backfilled = false;
  private cleanupFailure?: unknown;

  constructor(
    _shell: IShellExecutor,
    private readonly store: ServerEventLogSink | null | undefined,
    private readonly units = DEFAULT_UNITS,
    private readonly streams?: ObservationStreamExecutor,
    private readonly reconnectMs = 5000,
  ) {}

  async start(): Promise<void> {
    if (!this.store || this.enabled) return;
    this.enabled = true;
    this.connect();
  }
  async stop(): Promise<void> {
    this.enabled = false;
    clearTimeout(this.restartTimer); this.restartTimer = undefined;
    this.connection?.abort();
    await this.running;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
  getStats(): { active: boolean; bufferedBytes: number; overflowLines: number; seenCursors: number; cursorBytes: number } {
    return { active: !!this.running, bufferedBytes: this.bufferedBytes, overflowLines: this.overflowLines,
      seenCursors: this.seenCursors.size, cursorBytes: this.cursorBytes };
  }
  private warning(action: string, message: string): void {
    try { this.store?.record({ category: 'system', severity: 'warn', source: 'journalctl', action, message }); }
    catch { /* 诊断存储失败不能触发裸进程兜底或未捕获异常 */ }
  }
  private connect(): void {
    if (!this.enabled || this.running || this.restartTimer) return;
    const ac = new AbortController(); this.connection = ac;
    const running = this.collect(ac); this.running = running;
    void running.finally(() => {
      if (this.running !== running) return;
      this.running = undefined; this.connection = undefined;
      if (!this.enabled) return;
      this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.connect(); }, ac.signal.aborted ? 0 : this.reconnectMs);
      this.restartTimer.unref?.();
    }).catch(() => {});
  }
  private async collect(ac: AbortController): Promise<void> {
    if (!this.streams) { this.warning('tail.unavailable', '系统日志独立读取暂不可用，请稍后重试并查看诊断。'); return; }
    const unitFlags = this.units.flatMap(unit => ['-u', unit]);
    try {
      if (!this.backfilled) {
        const since = process.env.CDS_JOURNAL_BACKFILL_SINCE || '15 minutes ago';
        try {
          const result = await this.read([...unitFlags, ...journalPriorityArgs(), '--since', since, '-o', 'json', '--no-pager'], ac, 'journal.backfill', 8000);
          if (ac.signal.aborted) return;
          if (result.exitCode !== 0) this.warning('backfill.failed', '系统日志历史读取失败，将继续监听新日志。');
        } catch (error) {
          if ((error as { code?: string }).code === 'cleanup') throw error;
          if (ac.signal.aborted) return;
          // deadline只有所属组清理确认后才返回；历史过多不能永久挡住新日志监听。
          if ((error as { code?: string }).code !== 'deadline') throw error;
          this.warning('backfill.failed', '系统日志历史读取超时，将继续监听新日志。');
        }
        this.backfilled = true;
      }
      if (ac.signal.aborted || !this.enabled) return;
      const result = await this.read([...unitFlags, ...journalPriorityArgs(), '-f', '-n', '0', '-o', 'json', '--no-pager'], ac, 'journal.tail', 0);
      if (!ac.signal.aborted) this.warning('tail.closed', `系统日志监听已结束（${result.exitCode}），将重新连接。`);
      this.cleanupFailure = undefined;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'cleanup') { this.cleanupFailure = error; this.warning('tail.cleanup', '系统日志读取清理未确认，请查看诊断。'); throw error; }
      if (!ac.signal.aborted) this.warning('tail.unavailable', '系统日志独立读取暂不可用，将稍后重新连接。');
    }
  }
  private async read(argv: string[], ac: AbortController, action: string, timeout: number) {
    let buffer = ''; let dropping = false; let processed = 0;
    const consumeLine = async (): Promise<void> => {
      if (!dropping && buffer.trim() && !ac.signal.aborted && this.enabled) this.recordLine(buffer.trim(), action);
      buffer = ''; this.bufferedBytes = 0; dropping = false;
      // 单块大量短行也必须让出控制面；消费回执后才接收下一块，无额外全文/队列。
      if (++processed % JOURNAL_PROCESS_BATCH === 0) await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      const result = await this.streams!.exec(['journalctl', ...argv].map(shellQuoteArg).join(' '), {
        signal: ac.signal, timeout, onData: async (chunk, channel) => {
          if (ac.signal.aborted || !this.enabled) return;
          if (channel === 'stderr') { this.warning(action === 'journal.tail' ? 'tail.stderr' : 'backfill.stderr', chunk.trim().slice(0, 8192)); return; }
          let offset = 0;
          while (offset < chunk.length && !ac.signal.aborted && this.enabled) {
            const newline = chunk.indexOf('\n', offset);
            const end = newline < 0 ? chunk.length : newline;
            if (!dropping) {
              buffer += chunk.slice(offset, end); this.bufferedBytes = Buffer.byteLength(buffer);
              if (this.bufferedBytes > MAX_JOURNAL_LINE_BYTES) {
                buffer = ''; this.bufferedBytes = 0; dropping = true; this.overflowLines++;
                this.warning('journal.oversize', '系统日志超过64KiB，已跳过整行；后续日志继续读取。');
              }
            }
            if (newline < 0) break;
            await consumeLine(); offset = newline + 1;
          }
        },
      });
      if (buffer && !ac.signal.aborted && this.enabled) await consumeLine();
      return result;
    } finally { buffer = ''; this.bufferedBytes = 0; }
  }
  private recordLine(line: string, action: string): void {
    if (!this.store || !this.enabled) return;
    const doc = parseJournalLine(line);
    if (!doc) return;
    const cursor = typeof doc.__CURSOR === 'string' ? doc.__CURSOR : '';
    if (cursor) {
      if (this.seenCursors.has(cursor)) return;
      this.seenCursors.add(cursor); this.cursorBytes += Buffer.byteLength(cursor);
      while (this.seenCursors.size > 5000 || this.cursorBytes > MAX_CURSOR_BYTES) {
        const oldest = this.seenCursors.values().next().value!; this.seenCursors.delete(oldest); this.cursorBytes -= Buffer.byteLength(oldest);
      }
    }
    const message = String(doc.MESSAGE || '').trim();
    if (!message) return;
    const unit = String(doc._SYSTEMD_UNIT || doc.SYSLOG_IDENTIFIER || '');
    const severity = severityFromJournal(doc.PRIORITY, message);
    if (!shouldRecordJournalMessage(severity, message)) return;
    this.store.record({
      category: 'system',
      severity,
      source: 'journalctl',
      action,
      message,
      details: {
        unit,
        pid: doc._PID,
        priority: doc.PRIORITY,
        realtime: doc.__REALTIME_TIMESTAMP,
        monotonic: doc.__MONOTONIC_TIMESTAMP,
        cursor,
        syslogIdentifier: doc.SYSLOG_IDENTIFIER,
      },
    });
  }
}
