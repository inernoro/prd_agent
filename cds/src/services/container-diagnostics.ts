import { spawn, type ChildProcess } from 'node:child_process';
import type { IShellExecutor } from '../types.js';
import {
  normalizeLogText,
  type ServerEventLogSink,
  type ServerEventSeverity,
} from './server-event-log-store.js';
import {
  classifyDockerLifecycleEvent,
  type DockerLifecycleClassification,
} from './docker-lifecycle-classifier.js';

const VALID_DOCKER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const INTENT_TTL_MS = 5 * 60 * 1000;

export type ContainerLifecycleIntentKind =
  | 'cds-stop'
  | 'cds-remove'
  | 'cds-pre-run-replace'
  | 'cds-stale-cleanup'
  | 'cds-infra-recreate';

export interface ContainerLifecycleIntent {
  containerName: string;
  kind: ContainerLifecycleIntentKind;
  reason: string;
  requestedAt: string;
  projectId?: string | null;
  branchId?: string | null;
  profileId?: string | null;
  serviceId?: string | null;
  requestId?: string | null;
  operationId?: string | null;
  actor?: string | null;
  trigger?: string | null;
  operation?: string | null;
  source?: string | null;
  details?: Record<string, unknown>;
}

const lifecycleIntents = new Map<string, ContainerLifecycleIntent>();

function normalizeContainerName(value: string): string {
  return String(value || '').replace(/^\/+/, '').trim();
}

function pruneLifecycleIntents(now = Date.now()): void {
  for (const [name, intent] of lifecycleIntents.entries()) {
    if (now - Date.parse(intent.requestedAt) > INTENT_TTL_MS) lifecycleIntents.delete(name);
  }
}

export function recordContainerLifecycleIntent(intent: Omit<ContainerLifecycleIntent, 'containerName' | 'requestedAt'> & {
  containerName: string;
  requestedAt?: string;
}): void {
  const containerName = normalizeContainerName(intent.containerName);
  if (!containerName) return;
  pruneLifecycleIntents();
  lifecycleIntents.set(containerName, {
    containerName,
    kind: intent.kind,
    reason: intent.reason,
    requestedAt: intent.requestedAt || new Date().toISOString(),
    projectId: intent.projectId ?? null,
    branchId: intent.branchId ?? null,
    profileId: intent.profileId ?? null,
    serviceId: intent.serviceId ?? null,
    requestId: intent.requestId ?? null,
    operationId: intent.operationId ?? null,
    actor: intent.actor ?? null,
    trigger: intent.trigger ?? null,
    operation: intent.operation ?? null,
    source: intent.source ?? null,
    details: intent.details,
  });
}

export function findRecentContainerLifecycleIntent(containerName: string | undefined | null): ContainerLifecycleIntent | undefined {
  const clean = normalizeContainerName(containerName || '');
  if (!clean) return undefined;
  pruneLifecycleIntents();
  return lifecycleIntents.get(clean);
}

export function clearContainerLifecycleIntentsForTest(): void {
  lifecycleIntents.clear();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeDockerRef(value: string): string | null {
  const clean = normalizeContainerName(value);
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

function dockerLifecycleSeverity(
  baseSeverity: ServerEventSeverity,
  action: string,
  classification?: DockerLifecycleClassification,
  lifecycleIntent?: ContainerLifecycleIntent,
): ServerEventSeverity {
  if (!classification) return baseSeverity;
  if (classification.unexpected) return 'error';

  const normalized = action.toLowerCase();
  const lifecycleAction = normalized.includes('oom')
    || normalized === 'die'
    || normalized === 'kill'
    || normalized === 'destroy'
    || normalized === 'stop';
  if (lifecycleIntent && lifecycleAction) return 'warn';
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

function shouldRecordDockerEvent(action: string): boolean {
  const normalized = action.toLowerCase();
  if (normalized.startsWith('exec_') || normalized === 'attach') return false;
  return normalized === 'create'
    || normalized === 'start'
    || normalized === 'stop'
    || normalized === 'die'
    || normalized === 'kill'
    || normalized === 'oom'
    || normalized === 'destroy'
    || normalized === 'restart'
    || normalized === 'pause'
    || normalized === 'unpause'
    || normalized.startsWith('health_status');
}

export class DockerEventMonitor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly shell: IShellExecutor,
    private readonly store: ServerEventLogSink | null | undefined,
    private readonly onManagedEvent?: (event: {
      action: string;
      containerName?: string;
      branchId?: string;
      profileId?: string;
      serviceId?: string;
      attrs: Record<string, string>;
      status?: string;
      exitCode?: number;
      oomKilled?: boolean;
      inspect?: Record<string, unknown>;
      lifecycleIntent?: ContainerLifecycleIntent;
    }) => void | Promise<void>,
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
    if (!shouldRecordDockerEvent(action)) return;
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
    const lifecycleIntent = findRecentContainerLifecycleIntent(containerName);
    const normalizedAction = action.toLowerCase();
    const exitCode = Number.isFinite(Number(state?.exitCode ?? attrs.exitCode))
      ? Number(state?.exitCode ?? attrs.exitCode)
      : undefined;
    const oomKilled = typeof state?.oomKilled === 'boolean'
      ? state.oomKilled
      : action.toLowerCase().includes('oom') || undefined;
    const status = typeof state?.status === 'string'
      ? state.status
      : attrs.exitCode ? 'exited' : undefined;
    const classification = ['die', 'kill', 'destroy', 'oom'].includes(normalizedAction)
      ? classifyDockerLifecycleEvent({
        action,
        containerName,
        status,
        exitCode,
        oomKilled,
        attrs,
        lifecycleIntent,
      })
      : undefined;
    const recordedSeverity = dockerLifecycleSeverity(severity, action, classification, lifecycleIntent);

    this.store.record({
      category: 'docker',
      severity: recordedSeverity,
      source: 'docker-events',
      action,
      message: `docker ${action}${containerName ? `: ${containerName}` : ''}${lifecycleIntent ? ` (matched ${lifecycleIntent.kind})` : ''}`,
      projectId: lifecycleIntent?.projectId || null,
      branchId: branchId || null,
      profileId: profileId || null,
      serviceId: serviceId || null,
      requestId: lifecycleIntent?.requestId || null,
      operationId: lifecycleIntent?.operationId || null,
      operationKind: lifecycleIntent?.operation || lifecycleIntent?.kind || null,
      operationTrigger: lifecycleIntent?.trigger || null,
      operationActor: lifecycleIntent?.actor || null,
      operationSource: lifecycleIntent?.source || null,
      containerName: containerName || null,
      status,
      exitCode,
      oomKilled,
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
      details: {
        ...(lifecycleIntent ? { lifecycleIntent } : {}),
        ...(classification ? {
          classification: {
            source: classification.source,
            stopClass: classification.stopClass,
            unexpected: classification.unexpected,
            nextServiceStatus: classification.nextServiceStatus,
            nextBranchStatus: classification.nextBranchStatus,
            reason: classification.reason,
          },
        } : {}),
      },
    });

    try {
      await this.onManagedEvent?.({
        action,
        containerName,
        branchId,
        profileId,
        serviceId,
        attrs,
        status,
        exitCode,
        oomKilled,
        inspect: diagnostics.inspect,
        lifecycleIntent,
      });
    } catch (err) {
      this.store.record({
        category: 'docker',
        severity: 'warn',
        source: 'docker-events',
        action: 'state-sync.failed',
        message: `docker event state sync failed: ${(err as Error).message}`,
        branchId: branchId || null,
        profileId: profileId || null,
        serviceId: serviceId || null,
        containerName: containerName || null,
      });
    }
  }
}
