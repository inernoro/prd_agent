import { spawn, type ChildProcess } from 'node:child_process';
import type { IShellExecutor } from '../types.js';
import {
  normalizeLogText,
  type ServerEventLogSink,
  type ServerEventSeverity,
} from './server-event-log-store.js';

const VALID_DOCKER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeDockerRef(value: string): string | null {
  const clean = String(value || '').replace(/^\/+/, '').trim();
  return VALID_DOCKER_REF.test(clean) ? clean : null;
}

export function summarizeDockerInspect(raw: unknown): Record<string, unknown> | undefined {
  const doc = Array.isArray(raw) ? raw[0] : raw;
  if (!doc || typeof doc !== 'object') return undefined;
  const item = doc as Record<string, any>;
  const labels = item.Config?.Labels && typeof item.Config.Labels === 'object'
    ? item.Config.Labels as Record<string, string>
    : {};
  return {
    id: typeof item.Id === 'string' ? item.Id.slice(0, 24) : undefined,
    name: typeof item.Name === 'string' ? item.Name.replace(/^\/+/, '') : undefined,
    image: item.Config?.Image,
    labels: {
      managed: labels['cds.managed'],
      type: labels['cds.type'],
      branchId: labels['cds.branch.id'],
      profileId: labels['cds.profile.id'],
      serviceId: labels['cds.service.id'],
      network: labels['cds.network'],
    },
    state: item.State
      ? {
        status: item.State.Status,
        running: item.State.Running,
        paused: item.State.Paused,
        restarting: item.State.Restarting,
        oomKilled: item.State.OOMKilled,
        dead: item.State.Dead,
        pid: item.State.Pid,
        exitCode: item.State.ExitCode,
        error: item.State.Error,
        startedAt: item.State.StartedAt,
        finishedAt: item.State.FinishedAt,
        health: item.State.Health
          ? {
            status: item.State.Health.Status,
            failingStreak: item.State.Health.FailingStreak,
          }
          : undefined,
      }
      : undefined,
    restartPolicy: item.HostConfig?.RestartPolicy,
    networkMode: item.HostConfig?.NetworkMode,
  };
}

export async function collectContainerDiagnostics(
  shell: IShellExecutor,
  containerRef: string,
  tailLines = 200,
): Promise<{
  inspect?: Record<string, unknown>;
  logs?: ReturnType<typeof normalizeLogText>;
  error?: { message: string };
}> {
  const safe = safeDockerRef(containerRef);
  if (!safe) return { error: { message: `unsafe container reference: ${containerRef}` } };

  let inspect: Record<string, unknown> | undefined;
  const inspectResult = await shell.exec(`docker inspect ${shellQuote(safe)}`, { timeout: 5000 });
  if (inspectResult.exitCode === 0 && inspectResult.stdout.trim()) {
    try {
      inspect = summarizeDockerInspect(JSON.parse(inspectResult.stdout));
    } catch {
      inspect = { parseError: inspectResult.stdout.slice(0, 2000) };
    }
  }

  const logsResult = await shell.exec(
    `docker logs --timestamps --tail ${Math.max(1, Math.min(tailLines, 1000))} ${shellQuote(safe)}`,
    { timeout: 7000 },
  );
  const rawLogs = `${logsResult.stdout || ''}${logsResult.stderr || ''}`;
  return {
    inspect,
    logs: rawLogs ? normalizeLogText(rawLogs, tailLines) : undefined,
    error: inspectResult.exitCode !== 0 && logsResult.exitCode !== 0
      ? { message: `${inspectResult.stderr || inspectResult.stdout || ''}${logsResult.stderr || logsResult.stdout || ''}`.slice(0, 1200) }
      : undefined,
  };
}

function eventSeverity(action: string, attrs: Record<string, string>): ServerEventSeverity {
  const normalized = action.toLowerCase();
  if (normalized.includes('oom') || normalized === 'die' || normalized === 'kill' || normalized === 'destroy') return 'error';
  if (normalized.startsWith('health_status') && !normalized.includes('healthy')) return 'error';
  if (normalized === 'stop' || normalized === 'restart') return 'warn';
  const exitCode = attrs.exitCode || attrs.exitcode;
  if (exitCode && exitCode !== '0') return 'error';
  return 'info';
}

function shouldCaptureDiagnostics(action: string): boolean {
  const normalized = action.toLowerCase();
  return normalized === 'die'
    || normalized === 'oom'
    || normalized === 'kill'
    || normalized === 'stop'
    || normalized === 'destroy'
    || normalized === 'restart'
    || (normalized.startsWith('health_status') && !normalized.includes('healthy'));
}

export class DockerEventMonitor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly shell: IShellExecutor,
    private readonly store: ServerEventLogSink | null | undefined,
  ) {}

  start(): void {
    if (!this.store || this.child) return;
    this.stopping = false;
    this.spawnMonitor();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }

  private spawnMonitor(): void {
    if (this.stopping || !this.store) return;
    const child = spawn('docker', [
      'events',
      '--filter',
      'label=cds.managed=true',
      '--format',
      '{{json .}}',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) void this.handleLine(line.trim());
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (!message) return;
      this.store?.record({
        category: 'docker',
        severity: 'warn',
        source: 'docker-events',
        action: 'monitor.stderr',
        message,
      });
    });
    child.on('error', (err) => {
      this.store?.record({
        category: 'docker',
        severity: 'error',
        source: 'docker-events',
        action: 'monitor.error',
        message: err.message,
      });
    });
    child.on('close', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      this.store?.record({
        category: 'docker',
        severity: 'warn',
        source: 'docker-events',
        action: 'monitor.closed',
        message: `docker events exited code=${code ?? 'null'} signal=${signal ?? 'null'}; restarting monitor`,
      });
      this.restartTimer = setTimeout(() => this.spawnMonitor(), 5000);
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (!this.store) return;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      this.store.record({
        category: 'docker',
        severity: 'warn',
        source: 'docker-events',
        action: 'parse-failed',
        message: line,
      });
      return;
    }

    const action = String(evt.Action || evt.status || 'unknown');
    const attrs = (evt.Actor?.Attributes && typeof evt.Actor.Attributes === 'object')
      ? evt.Actor.Attributes as Record<string, string>
      : {};
    const containerName = attrs.name || attrs['container'];
    const branchId = attrs['cds.branch.id'];
    const profileId = attrs['cds.profile.id'];
    const serviceId = attrs['cds.service.id'];
    const severity = eventSeverity(action, attrs);
    const ref = containerName || evt.id || evt.Actor?.ID;
    const diagnostics = ref && shouldCaptureDiagnostics(action)
      ? await collectContainerDiagnostics(this.shell, ref, 300)
      : {};
    const state = diagnostics.inspect?.state as Record<string, unknown> | undefined;

    this.store.record({
      category: 'docker',
      severity,
      source: 'docker-events',
      action,
      message: `docker ${action}${containerName ? `: ${containerName}` : ''}`,
      branchId: branchId || null,
      profileId: profileId || null,
      serviceId: serviceId || null,
      containerName: containerName || null,
      status: typeof state?.status === 'string' ? state.status : attrs.exitCode ? 'exited' : undefined,
      exitCode: Number.isFinite(Number(state?.exitCode ?? attrs.exitCode)) ? Number(state?.exitCode ?? attrs.exitCode) : undefined,
      oomKilled: typeof state?.oomKilled === 'boolean' ? state.oomKilled : action.toLowerCase().includes('oom') || undefined,
      docker: {
        id: evt.id || evt.Actor?.ID,
        type: evt.Type,
        action,
        from: evt.from,
        time: evt.time,
        timeNano: evt.timeNano,
        attributes: attrs,
      },
      inspect: diagnostics.inspect,
      logs: diagnostics.logs,
      error: diagnostics.error,
    });
  }
}
