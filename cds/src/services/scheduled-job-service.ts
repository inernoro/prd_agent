import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from './state.js';
import type { CdsConfig, IShellExecutor, ScheduledJob, ScheduledJobAction, ScheduledJobRun, ScheduledJobSchedule, ScheduledJobTarget } from '../types.js';

export interface ScheduledJobServiceDeps {
  stateService: StateService;
  shell: IShellExecutor;
  config: Pick<CdsConfig, 'masterPort' | 'repoRoot'> & Partial<Pick<CdsConfig, 'dockerNetwork'>>;
}

export interface ScheduledJobTargetCheckResult {
  ok: boolean;
  exitCode?: number;
  httpStatus?: number;
  log: string;
  error?: string;
}

const DEFAULT_TICK_MS = 30_000;
const MAX_LOG_CHARS = 24_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_COMMAND_SANDBOX_IMAGE = 'alpine:3';

export class ScheduledJobService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();

  constructor(private readonly deps: ScheduledJobServiceDeps) {}

  start(): void {
    if (this.timer) return;
    this.reconcileNextRunAt();
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduled-jobs] tick failed:', (err as Error).message);
      });
    }, DEFAULT_TICK_MS);
    this.timer.unref?.();
    console.log(`[scheduled-jobs] started (tick=${Math.round(DEFAULT_TICK_MS / 1000)}s)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    const due = this.deps.stateService.listScheduledJobs()
      .filter((job) => job.enabled && job.schedule.type !== 'manual')
      .filter((job) => !job.nextRunAt || Date.parse(job.nextRunAt) <= now.getTime());
    for (const job of due) {
      this.claimScheduledOccurrence(job, now);
      await this.runJob(job.id, 'schedule');
    }
  }

  async runJob(jobId: string, trigger: ScheduledJobRun['trigger']): Promise<ScheduledJobRun> {
    const job = this.deps.stateService.getScheduledJob(jobId);
    if (!job) throw new Error('任务不存在');

    if (this.running.has(job.id)) {
      const skipped = this.createRun(job, trigger, 'skipped');
      skipped.finishedAt = skipped.queuedAt;
      skipped.durationMs = 0;
      skipped.log = '上一次执行仍在运行，本次按并发策略跳过。';
      this.deps.stateService.upsertScheduledJobRun(skipped);
      return skipped;
    }

    const run = this.createRun(job, trigger, 'running');
    run.startedAt = new Date().toISOString();
    this.deps.stateService.upsertScheduledJobRun(run);
    this.running.add(job.id);

    try {
      const result = await this.executeActions(
        job,
        Math.max(1, job.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS),
        Math.max(0, Math.floor(job.retryCount || 0)),
      );
      run.exitCode = result.exitCode;
      run.httpStatus = result.httpStatus;
      run.log = truncateLog(result.log);
      run.status = result.ok ? 'success' : 'failed';
      if (!result.ok) run.error = result.error || `执行失败，退出码 ${result.exitCode ?? 'unknown'}`;
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;
      run.log = truncateLog((err as Error).stack || (err as Error).message);
    } finally {
      this.running.delete(job.id);
      run.finishedAt = new Date().toISOString();
      run.durationMs = run.startedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0;
      this.deps.stateService.upsertScheduledJobRun(run);
      this.patchJobAfterRun(job, run);
    }

    return run;
  }

  async checkTarget(target: ScheduledJobTarget, timeoutSeconds: number): Promise<ScheduledJobTargetCheckResult> {
    return this.executeTarget(target, Math.max(1, timeoutSeconds || DEFAULT_TIMEOUT_SECONDS), `check-${crypto.randomBytes(8).toString('hex')}`);
  }

  computeNextRunAt(schedule: ScheduledJobSchedule, from = new Date()): string | null {
    if (schedule.type === 'manual') return null;
    if (schedule.type === 'interval') {
      const minutes = Math.max(1, Math.floor(schedule.intervalMinutes || 1));
      return new Date(from.getTime() + minutes * 60_000).toISOString();
    }
    const tz = schedule.timezone || 'Asia/Shanghai';
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.timeOfDay || '');
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const parts = getZonedParts(from, tz);
    let candidate = zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, tz);
    if (candidate <= from.getTime()) {
      const next = addDays(parts.year, parts.month, parts.day, 1);
      candidate = zonedLocalToUtc(next.year, next.month, next.day, hour, minute, tz);
    }
    return new Date(candidate).toISOString();
  }

  normalizeJob(job: ScheduledJob): ScheduledJob {
    const now = new Date().toISOString();
    const next = job.enabled ? this.computeNextRunAt(job.schedule, new Date()) : null;
    const actions = normalizeActions(job.actions, job.target);
    return {
      ...job,
      actions,
      target: actions[0],
      timeoutSeconds: Math.max(1, Math.floor(job.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS)),
      retryCount: Math.max(0, Math.floor(job.retryCount || 0)),
      concurrencyPolicy: 'skip',
      updatedAt: now,
      nextRunAt: next,
    };
  }

  private reconcileNextRunAt(): void {
    for (const job of this.deps.stateService.listScheduledJobs()) {
      if (!job.enabled || job.nextRunAt || job.schedule.type === 'manual') continue;
      this.deps.stateService.upsertScheduledJob({ ...job, nextRunAt: this.computeNextRunAt(job.schedule) });
    }
  }

  private createRun(job: ScheduledJob, trigger: ScheduledJobRun['trigger'], status: ScheduledJobRun['status']): ScheduledJobRun {
    return {
      id: `sjr_${crypto.randomBytes(8).toString('hex')}`,
      jobId: job.id,
      projectId: job.projectId,
      trigger,
      status,
      queuedAt: new Date().toISOString(),
    };
  }

  private claimScheduledOccurrence(job: ScheduledJob, now: Date): void {
    if (job.schedule.type === 'manual') return;
    const latest = this.deps.stateService.getScheduledJob(job.id);
    if (!latest || !latest.enabled) return;
    this.deps.stateService.upsertScheduledJob({
      ...latest,
      nextRunAt: this.computeNextRunAt(latest.schedule, now),
      updatedAt: new Date().toISOString(),
    });
  }

  private patchJobAfterRun(job: ScheduledJob, run: ScheduledJobRun): void {
    const latest = this.deps.stateService.getScheduledJob(job.id);
    if (!latest) return;
    this.deps.stateService.upsertScheduledJob({
      ...latest,
      lastRunAt: run.finishedAt || run.startedAt || run.queuedAt,
      lastRunStatus: run.status,
      lastRunId: run.id,
      nextRunAt: latest.enabled ? this.computeNextRunAt(latest.schedule, new Date()) : null,
      updatedAt: new Date().toISOString(),
    });
  }

  private async executeActions(job: ScheduledJob, timeoutSeconds: number, retryCount: number): Promise<ScheduledJobTargetCheckResult> {
    const actions = normalizeActions(job.actions, job.target);
    if (actions.length === 0) {
      return { ok: false, exitCode: 1, log: '', error: '任务至少需要一个动作' };
    }

    const logs: string[] = [];
    let lastExitCode: number | undefined;
    let lastHttpStatus: number | undefined;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const title = action.name || defaultActionName(action);
      logs.push(`[${index + 1}/${actions.length}] ${title}`);
      const sandboxKey = actions.length === 1 ? job.id : `${job.id}-${index + 1}-${action.id}`;
      const result = await this.executeTargetWithRetry(action, timeoutSeconds, sandboxKey, retryCount);
      lastExitCode = result.exitCode;
      lastHttpStatus = result.httpStatus;
      if (result.log) logs.push(result.log);
      if (!result.ok) {
        if (result.error) logs.push(result.error);
        return {
          ok: false,
          exitCode: result.exitCode,
          httpStatus: result.httpStatus,
          log: logs.join('\n'),
          error: `${title} 执行失败：${result.error || `退出码 ${result.exitCode ?? 'unknown'}`}`,
        };
      }
    }
    return {
      ok: true,
      exitCode: lastExitCode,
      httpStatus: lastHttpStatus,
      log: logs.join('\n'),
    };
  }

  private async executeTargetWithRetry(
    target: ScheduledJobTarget,
    timeoutSeconds: number,
    sandboxKey: string,
    retryCount: number,
  ): Promise<ScheduledJobTargetCheckResult> {
    const logs: string[] = [];
    let last: ScheduledJobTargetCheckResult | null = null;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      const attemptSandboxKey = retryCount === 0 ? sandboxKey : `${sandboxKey}-try-${attempt + 1}`;
      const result = await this.executeTarget(target, timeoutSeconds, attemptSandboxKey);
      last = result;
      if (retryCount > 0) logs.push(`尝试 ${attempt + 1}/${retryCount + 1}`);
      if (result.log) logs.push(result.log);
      if (result.ok) return { ...result, log: logs.join('\n') };
      if (result.error) logs.push(result.error);
    }
    return {
      ok: false,
      exitCode: last?.exitCode,
      httpStatus: last?.httpStatus,
      log: logs.join('\n'),
      error: last?.error || `重试 ${retryCount} 次后仍失败`,
    };
  }

  private async executeTarget(target: ScheduledJobTarget, timeoutSeconds: number, sandboxKey?: string): Promise<ScheduledJobTargetCheckResult> {
    if (target.type === 'command') {
      const sandbox = resolveCommandSandbox(this.deps.config.repoRoot, sandboxKey || 'manual', target.cwd);
      const result = await this.deps.shell.exec(buildDockerSandboxCommand({
        command: target.command,
        containerCwd: sandbox.containerCwd,
        dockerNetwork: this.deps.config.dockerNetwork,
        hostSandboxRoot: sandbox.hostSandboxRoot,
      }), {
        timeout: timeoutSeconds * 1000,
      });
      const log = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        log,
        error: result.exitCode === 0 ? undefined : `执行失败，退出码 ${result.exitCode}`,
      };
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutSeconds * 1000);
    try {
      const url = normalizeTargetUrl(target.url, this.deps.config.masterPort);
      const headers = { ...(target.headers || {}) };
      const init: RequestInit = { method: target.method || 'POST', headers, signal: ctrl.signal };
      if (target.body && target.method !== 'GET') {
        init.body = target.body;
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
      const res = await fetch(url, init);
      const text = await res.text();
      return {
        ok: res.ok,
        httpStatus: res.status,
        log: `HTTP ${res.status} ${res.statusText}\n${text}`.trim(),
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeTargetUrl(url: string, masterPort: number): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `http://127.0.0.1:${masterPort}${url}`;
  return url;
}

function normalizeActions(actions?: ScheduledJobAction[], legacyTarget?: ScheduledJobTarget): ScheduledJobAction[] {
  const source = Array.isArray(actions) && actions.length > 0
    ? actions
    : legacyTarget
      ? [{ ...legacyTarget, id: 'action_1', name: defaultActionName(legacyTarget) }]
      : [];
  return source
    .filter((action) => action && (action.type === 'http' || action.type === 'command'))
    .map((action, index) => ({
      ...action,
      id: action.id || `action_${index + 1}`,
      name: action.name?.trim() || defaultActionName(action),
    }));
}

function defaultActionName(action: ScheduledJobTarget): string {
  return action.type === 'http' ? '调用 HTTP 接口' : '执行命令脚本';
}

function resolveCommandSandbox(repoRoot: string, sandboxKey: string, requestedCwd?: string): {
  containerCwd: string;
  hostCwd: string;
  hostSandboxRoot: string;
} {
  const sandboxRoot = path.resolve(repoRoot, '.cds', 'task-sandboxes', safePathSegment(sandboxKey), 'work');
  const relativeCwd = (requestedCwd || '').trim();
  if (relativeCwd && (path.isAbsolute(relativeCwd) || /^[a-zA-Z]:[\\/]/.test(relativeCwd))) {
    throw new Error('命令工作目录必须是 sandbox 内的相对路径');
  }
  if (relativeCwd.replace(/\\/g, '/').split('/').some((part) => part === '..')) {
    throw new Error('命令工作目录不能跳出 sandbox');
  }
  const cwd = path.resolve(sandboxRoot, relativeCwd || '.');
  if (!isPathInside(sandboxRoot, cwd)) {
    throw new Error('命令工作目录不能跳出 sandbox');
  }
  fs.mkdirSync(cwd, { recursive: true });

  const realRoot = fs.realpathSync.native(sandboxRoot);
  const realCwd = fs.realpathSync.native(cwd);
  if (!isPathInside(realRoot, realCwd)) {
    throw new Error('命令工作目录不能通过符号链接跳出 sandbox');
  }
  return {
    containerCwd: toContainerCwd(relativeCwd),
    hostCwd: realCwd,
    hostSandboxRoot: realRoot,
  };
}

function buildDockerSandboxCommand(input: {
  command: string;
  containerCwd: string;
  dockerNetwork?: string;
  hostSandboxRoot: string;
}): string {
  const args = [
    'docker',
    'run',
    '--rm',
    ...(input.dockerNetwork ? ['--network', input.dockerNetwork] : []),
    '-v',
    `${input.hostSandboxRoot}:/workspace:rw`,
    '-w',
    input.containerCwd,
    resolveCommandSandboxImage(),
    'sh',
    '-lc',
    input.command,
  ];
  return args.map(shellQuote).join(' ');
}

function resolveCommandSandboxImage(): string {
  const configured = process.env.CDS_TASK_SANDBOX_IMAGE?.trim();
  return configured || DEFAULT_COMMAND_SANDBOX_IMAGE;
}

function toContainerCwd(relativeCwd: string): string {
  const parts = relativeCwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? path.posix.join('/workspace', ...parts) : '/workspace';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'sandbox';
}

function isPathInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function truncateLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  return `${log.slice(0, MAX_LOG_CHARS)}\n...[日志已截断]`;
}

function getZonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value || '0');
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

function zonedLocalToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i += 1) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess -= actual - wanted;
  }
  return guess;
}

function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
