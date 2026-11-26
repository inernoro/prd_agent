import {
  ARTIFACT_VERIFICATION_SIGNALS, ARTIFACT_VERIFICATION_SOURCE, ARTIFACT_VERIFICATION_STEPS, ARTIFACT_WAIT_REASONS,
  type ArtifactVerificationEventDetails, type ArtifactVerificationProbe, type ArtifactVerificationSignal, type ArtifactVerificationStep,
} from '../shared/artifact-verification-metrics.js';
import type { DeploymentRun } from '../types.js';
import type { ArtifactAdmission } from './artifact-admission.js';
import type { BranchOperationRequest } from './branch-operation-coordinator.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export function artifactVerificationMonitorEnabled(): boolean {
  return process.env.CDS_ARTIFACT_VERIFICATION_MONITOR !== '0';
}

function boundedCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3_600_000 ? value : undefined;
}

/** Remote timings are advisory. Only numeric fields and fixed diagnostic codes enter the event log. */
export function readArtifactVerificationProbe(value: unknown): ArtifactVerificationProbe | undefined {
  if (!value || typeof value !== 'object') return;
  const probe = value as Partial<ArtifactVerificationProbe>;
  const pullRequests = boundedCounter(probe.pullRequests);
  const pullsSucceeded = boundedCounter(probe.pullsSucceeded);
  const reusedImages = boundedCounter(probe.reusedImages);
  if (pullRequests === undefined || pullsSucceeded === undefined || reusedImages === undefined || pullsSucceeded > pullRequests
    || !probe.stepsMs || typeof probe.stepsMs !== 'object') return;

  const stepsMs: ArtifactVerificationProbe['stepsMs'] = {};
  for (const step of ARTIFACT_VERIFICATION_STEPS) {
    const value = boundedCounter(probe.stepsMs[step]);
    if (value !== undefined) stepsMs[step] = value;
  }
  return {
    stepsMs, pullRequests, pullsSucceeded, reusedImages,
    lastStep: probe.lastStep && ARTIFACT_VERIFICATION_STEPS.includes(probe.lastStep) ? probe.lastStep : undefined,
    signals: Array.isArray(probe.signals) ? ARTIFACT_VERIFICATION_SIGNALS.filter(signal => probe.signals!.includes(signal)) : undefined,
  };
}

export class ArtifactVerificationAttempt {
  private readonly startedAt = performance.now();
  private readonly local: ArtifactVerificationProbe = { stepsMs: {}, pullRequests: 0, pullsSucceeded: 0, reusedImages: 0 };
  private executorId = 'unknown';
  private requiredProfiles = 0;
  private executorProbe?: ArtifactVerificationProbe;

  constructor(readonly retry: boolean = false) {}

  onExecutor(id: string, requiredProfiles: number): void {
    this.executorId = id;
    this.requiredProfiles = requiredProfiles;
  }
  useRemoteProbe(value: unknown): void { this.executorProbe = readArtifactVerificationProbe(value); }
  signal(signal: ArtifactVerificationSignal): void {
    this.local.signals = [...new Set([...this.local.signals ?? [], signal])];
  }
  requestPull(): void { this.local.pullRequests++; }
  succeedPull(): void { this.local.pullsSucceeded++; }
  reuseImage(): void { this.local.reusedImages++; }
  snapshot(): ArtifactVerificationProbe { return this.local; }

  async time<T>(step: ArtifactVerificationStep, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    this.local.lastStep = step;
    try { return await work(); }
    finally { this.local.stepsMs[step] = (this.local.stepsMs[step] ?? 0) + Math.round(performance.now() - start); }
  }

  record(sink: ServerEventLogSink | null | undefined, run: DeploymentRun,
    request: Pick<BranchOperationRequest, 'actor' | 'kind' | 'source' | 'requestId'>, result?: ArtifactAdmission) {
    const probe = this.executorId === 'local' ? this.snapshot() : this.executorProbe;
    const outcome = result?.state || 'interrupted';
    const executionMs = Math.round(performance.now() - this.startedAt);
    const details: ArtifactVerificationEventDetails = {
      ...probe, runId: run.id, executorId: this.executorId, retry: this.retry, requiredProfiles: this.requiredProfiles,
      signals: [...new Set([...(probe?.signals ?? []), ...(this.local.signals ?? [])])],
      outcome, executionMs, elapsedSinceAcceptedMs: Math.max(0, Date.now() - Date.parse(run.startedAt)),
      reason: result?.reason && ARTIFACT_WAIT_REASONS.includes(result.reason) ? result.reason : undefined,
    };
    const level = result?.reason === 'verification-unavailable' ? 'warn' : 'info';
    const profileId = result?.profileIds?.[0];
    const counts = probe ? ` · 拉取请求 ${probe.pullRequests} · 复用 ${probe.reusedImages}` : '';
    const message = `镜像核验${outcome === 'ready' ? '通过' : outcome === 'waiting' ? '等待重试' : '中断'} · ${executionMs} 毫秒 · 执行器 ${this.executorId}${profileId ? ` · 服务 ${profileId}` : ''}${counts}`;
    try {
      sink?.record({
        category: 'system', severity: level,
        source: ARTIFACT_VERIFICATION_SOURCE, action: 'artifact-verification.attempt',
        message,
        projectId: run.projectId, branchId: run.branchId, profileId, commitSha: run.commitSha,
        requestId: request.requestId, operationId: run.operationId, operationTrigger: run.trigger,
        operationKind: request.kind, operationActor: request.actor, operationSource: request.source, status: outcome,
        details: { ...details },
      });
    } catch { /* The diagnostic sink must not change deployment admission. */ }
    return { level, message, details } as const;
  }
}
