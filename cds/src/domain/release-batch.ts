import type { ReleaseArtifact, ReleasePreflightCheck } from '../types.js';

export type ReleaseBatchTargetStatus = 'pending' | 'checking' | 'ready' | 'running' | 'success'
  | 'failed' | 'cancelled' | 'interrupted' | 'rollback_running' | 'rolled_back' | 'rollback_failed';
export type ReleaseBatchStatus = 'draft' | 'checking' | 'ready' | 'blocked' | 'running' | 'success'
  | 'partial_success' | 'failed' | 'cancelled' | 'interrupted' | 'rolled_back' | 'rollback_failed' | 'inconsistent';

export interface ReleaseBatchAttempt {
  id: string;
  kind: 'deploy' | 'rollback';
  operator?: string;
  createdAt: string;
  runId?: string;
  error?: string;
}

export interface ReleaseBatchTarget {
  targetId: string;
  targetName: string;
  configFingerprint: string;
  status: ReleaseBatchTargetStatus;
  checks?: ReleasePreflightCheck[];
  preflightId?: string;
  previousReleaseId?: string;
  previousCommitSha?: string;
  runId?: string;
  rollbackRunId?: string;
  error?: string;
  observedCommitSha?: string;
  observedAt?: string;
  observationError?: string;
  attempts: ReleaseBatchAttempt[];
}

/** Server-owned immutable source. Never accepted from an HTTP request. */
export interface ReleaseBatchSource {
  projectId: string;
  artifact: ReleaseArtifact;
}

export interface ReleaseBatch {
  id: string;
  projectId: string;
  versionId: string;
  commitSha: string;
  branchId: string;
  branchName: string;
  reportId: string;
  source: ReleaseBatchSource;
  status: ReleaseBatchStatus;
  createdAt: string;
  updatedAt: string;
  operator: string;
  creationKey: string;
  creationFingerprint: string;
  cancelRequested?: boolean;
  cancelledBy?: string;
  requests: Record<string, { action: string; targetId?: string; operator?: string }>;
  targets: ReleaseBatchTarget[];
}

export interface AcceptedReleaseVersion {
  versionId: string;
  commitSha: string;
  branchId: string;
  branchName: string;
  reportId: string;
  reportTitle: string;
  createdAt: string;
}

/** The batch result and the observed version are independent facts. */
export function summarizeReleaseBatch(batch: ReleaseBatch): ReleaseBatchStatus {
  const rows = batch.targets;
  if (rows.some(row => row.status === 'rollback_running' || row.status === 'running')) return 'running';
  if (rows.some(row => row.status === 'rollback_failed')) return 'rollback_failed';
  if (batch.cancelRequested) return 'cancelled';
  if (rows.every(row => row.status === 'rolled_back')) {
    return rows.every(row => row.previousCommitSha && row.observedCommitSha === row.previousCommitSha && !row.observationError)
      && new Set(rows.map(row => row.observedCommitSha)).size === 1 ? 'rolled_back' : 'inconsistent';
  }
  if (rows.some(row => row.status === 'rolled_back') && rows.some(row => row.status === 'success')) return 'inconsistent';
  if (rows.every(row => row.status === 'success')) {
    return rows.every(row => row.observedCommitSha === batch.commitSha && !row.observationError) ? 'success' : 'inconsistent';
  }
  if (rows.some(row => row.status === 'success' || row.status === 'rolled_back')) return 'partial_success';
  if (rows.some(row => row.status === 'interrupted')) return 'interrupted';
  return 'failed';
}
