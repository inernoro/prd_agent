import type { DeploymentRun } from '../types.js';

export const DEPLOYMENT_TIMING_STAGES = ['ci-runner', 'ci-build', 'artifact', 'capacity', 'pull', 'startup', 'readiness', 'switch', 'cleanup'] as const;
export type DeploymentTimingStage = typeof DEPLOYMENT_TIMING_STAGES[number];
export type DeploymentTimingBoundary = 'git-pull' | 'exact-artifact' | 'source-slot-wait' | 'capacity-check' | 'prebuilt-start' | 'startup-signal' | 'application-ready' | 'route-ack' | 'owned-recycle' | 'candidate-recovery';
export type DeploymentTimingOutcome = 'open' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface DeploymentTimingInterval {
  id: string;
  stage: DeploymentTimingStage;
  boundary: DeploymentTimingBoundary;
  profileId: string | null;
  commitShaAtStart: string | null;
  startedAt: string;
  endedAt?: string;
  startOffsetMs: number | null;
  endOffsetMs?: number | null;
  durationMs: number | null;
  outcome: DeploymentTimingOutcome;
}
export interface DeploymentTimingRecord {
  version: 1;
  operationId: string;
  epochId: string;
  intervals: DeploymentTimingInterval[];
  truncated: boolean;
}
export interface DeploymentTimingObserver {
  begin(stage: DeploymentTimingStage, boundary: DeploymentTimingBoundary, profileId?: string | null): (outcome: 'completed' | 'failed' | 'cancelled') => void;
  measure<T>(stage: DeploymentTimingStage, boundary: DeploymentTimingBoundary, profileId: string | null,
    work: () => Promise<T>, successful?: (value: T) => boolean): Promise<T>;
}
export const TIMING_INTERVAL_LIMIT = 512;
const boundaryStage: Record<DeploymentTimingBoundary, DeploymentTimingStage> = {
  'git-pull': 'pull', 'exact-artifact': 'artifact', 'source-slot-wait': 'capacity', 'capacity-check': 'capacity',
  'prebuilt-start': 'startup', 'startup-signal': 'readiness', 'application-ready': 'readiness',
  'route-ack': 'switch', 'owned-recycle': 'cleanup', 'candidate-recovery': 'cleanup',
};
export function isTimingBoundary(stage: DeploymentTimingStage, boundary: DeploymentTimingBoundary): boolean {
  return Object.hasOwn(boundaryStage, boundary) && boundaryStage[boundary] === stage;
}
export interface DeploymentStageSummary {
  status: 'not-observed' | 'observed' | 'incomplete';
  completedWallMs: number | null;
  workMs: number | null;
  intervals: number;
  open: number;
  unknown: number;
  completed: number;
  failed: number;
  cancelled: number;
}
/** Completed interval union is partial observed wall time, never whole delivery duration. */
export function summarizeDeploymentTiming(record: DeploymentRun['timing']): {
  version: 1; incomplete: boolean; truncated: boolean; stages: Record<DeploymentTimingStage, DeploymentStageSummary>;
} {
  const stages = Object.fromEntries(DEPLOYMENT_TIMING_STAGES.map(stage => [stage, {
    status: 'not-observed', completedWallMs: null, workMs: null, intervals: 0, open: 0, unknown: 0, completed: 0, failed: 0, cancelled: 0,
  }])) as Record<DeploymentTimingStage, DeploymentStageSummary>;
  const valid = record?.version === 1 && Array.isArray(record.intervals);
  const truncated = Boolean(record?.truncated) || Boolean(valid && record!.intervals.length > TIMING_INTERVAL_LIMIT);
  let incomplete = !valid || truncated;
  const ranges = new Map<DeploymentTimingStage, [number, number][]>();
  for (const interval of valid ? record!.intervals.slice(0, TIMING_INTERVAL_LIMIT) : []) {
    if (!interval || !DEPLOYMENT_TIMING_STAGES.includes(interval.stage)) { incomplete = true; continue; }
    const summary = stages[interval.stage]; summary.intervals++;
    if (interval.outcome === 'open') { summary.open++; incomplete = true; continue; }
    const start = interval.startOffsetMs, end = interval.endOffsetMs, duration = interval.durationMs;
    if (!isTimingBoundary(interval.stage, interval.boundary) || !['completed', 'failed', 'cancelled'].includes(interval.outcome)
      || start == null || end == null || duration == null || !Number.isFinite(start) || !Number.isFinite(end)
      || !Number.isFinite(duration) || start < 0 || end < start || duration < 0 || Math.abs(end - start - duration) > 0.01) {
      summary.unknown++; incomplete = true; continue;
    }
    summary.workMs = (summary.workMs ?? 0) + duration;
    summary[interval.outcome as 'completed' | 'failed' | 'cancelled']++;
    const group = ranges.get(interval.stage) || []; group.push([start, end]); ranges.set(interval.stage, group);
  }
  for (const stage of DEPLOYMENT_TIMING_STAGES) {
    const summary = stages[stage], group = ranges.get(stage);
    if (group?.length) {
      group.sort((a, b) => a[0] - b[0]); let total = 0, start = group[0][0], end = group[0][1];
      for (const next of group.slice(1)) {
        if (next[0] <= end) end = Math.max(end, next[1]);
        else { total += end - start; [start, end] = next; }
      }
      summary.completedWallMs = total + end - start;
    }
    summary.status = summary.intervals === 0 ? 'not-observed' : summary.open || summary.unknown || truncated ? 'incomplete' : 'observed';
    if (summary.status !== 'observed') incomplete = true;
  }
  return { version: 1, incomplete, truncated, stages };
}

/** Optional observation preserves the exact work promise when no observer is installed. */
export function measureDeploymentStage<T>(observer: DeploymentTimingObserver | undefined, stage: DeploymentTimingStage,
  boundary: DeploymentTimingBoundary, profileId: string | null, work: () => Promise<T>, successful?: (value: T) => boolean): Promise<T> {
  return observer ? observer.measure(stage, boundary, profileId, work, successful) : work();
}
