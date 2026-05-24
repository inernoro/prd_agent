import { spawn, type ChildProcess } from 'node:child_process';
import type { IShellExecutor } from '../types.js';
import type { ServerEventLogSink, ServerEventSeverity } from './server-event-log-store.js';

const DEFAULT_UNITS = ['cds-master.service', 'cds-forwarder.service'];

function severityFromJournal(priority: unknown, message: string): ServerEventSeverity {
  const p = Number(priority);
  const lower = message.toLowerCase();
  if (p <= 3 || /fatal error|heap out of memory|allocation failed|uncaughtexception|unhandledrejection|\boom\b|panic|segmentation fault/.test(lower)) {
    return 'error';
  }
  if (p === 4 || /\bwarn(?:ing)?\b| 502 | 503 |bad gateway|service unavailable|upstream error|request failed/.test(lower)) {
    return 'warn';
  }
  return 'info';
}

function parseJournalLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return { MESSAGE: line };
  }
}

export class SystemLogMonitor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private seenCursors = new Set<string>();

  constructor(
    private readonly shell: IShellExecutor,
    private readonly store: ServerEventLogSink | null | undefined,
    private readonly units = DEFAULT_UNITS,
  ) {}

  async start(): Promise<void> {
    if (!this.store || this.child) return;
    this.stopping = false;
    await this.backfillRecent();
    this.spawnTail();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }

  private async backfillRecent(): Promise<void> {
    if (!this.store) return;
    const since = process.env.CDS_JOURNAL_BACKFILL_SINCE || '15 minutes ago';
    const unitFlags = this.units.map((unit) => `-u ${unit}`).join(' ');
    const result = await this.shell.exec(
      `journalctl ${unitFlags} --since ${JSON.stringify(since)} -o json --no-pager`,
      { timeout: 8000 },
    );
    if (result.exitCode !== 0) {
      this.store.record({
        category: 'system',
        severity: 'warn',
        source: 'journalctl',
        action: 'backfill.failed',
        message: result.stderr || result.stdout || 'journalctl backfill failed',
        command: { name: 'journalctl backfill', exitCode: result.exitCode, stdoutPreview: result.stdout, stderrPreview: result.stderr },
      });
      return;
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim()) this.recordLine(line.trim(), 'journal.backfill');
    }
  }

  private spawnTail(): void {
    if (this.stopping || !this.store) return;
    const args = [
      ...this.units.flatMap((unit) => ['-u', unit]),
      '-f',
      '-n',
      '0',
      '-o',
      'json',
      '--no-pager',
    ];
    const child = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.recordLine(line.trim(), 'journal.tail');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (!message) return;
      this.store?.record({
        category: 'system',
        severity: 'warn',
        source: 'journalctl',
        action: 'tail.stderr',
        message,
      });
    });
    child.on('error', (err) => {
      this.store?.record({
        category: 'system',
        severity: 'error',
        source: 'journalctl',
        action: 'tail.error',
        message: err.message,
      });
    });
    child.on('close', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      this.store?.record({
        category: 'system',
        severity: 'warn',
        source: 'journalctl',
        action: 'tail.closed',
        message: `journalctl tail exited code=${code ?? 'null'} signal=${signal ?? 'null'}; restarting`,
      });
      this.restartTimer = setTimeout(() => this.spawnTail(), 5000);
    });
  }

  private recordLine(line: string, action: string): void {
    if (!this.store) return;
    const doc = parseJournalLine(line);
    if (!doc) return;
    const cursor = typeof doc.__CURSOR === 'string' ? doc.__CURSOR : '';
    if (cursor) {
      if (this.seenCursors.has(cursor)) return;
      this.seenCursors.add(cursor);
      if (this.seenCursors.size > 5000) this.seenCursors = new Set(Array.from(this.seenCursors).slice(-2500));
    }
    const message = String(doc.MESSAGE || '').trim();
    if (!message) return;
    const unit = String(doc._SYSTEMD_UNIT || doc.SYSLOG_IDENTIFIER || '');
    this.store.record({
      category: 'system',
      severity: severityFromJournal(doc.PRIORITY, message),
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
