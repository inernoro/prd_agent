import { describe, expect, it } from 'vitest';
import { hasBranchDeleteCleanupIntent, reconcileBranchStatusFromServices, shouldPruneDeletedBranchStartupResidue } from '../../src/services/startup-reconcile.js';
import type { BranchEntry, DeploymentRun } from '../../src/types.js';

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'prd-agent-cursor-file-convert-agent-3f07',
    projectId: 'default',
    branch: 'cursor/file-convert-agent-3f07',
    worktreePath: '/tmp/worktree',
    status: 'stopping',
    createdAt: new Date().toISOString(),
    lastStopSource: 'system',
    lastStopReason: '删除分支流程已开始：GitHub webhook 删除远程分支后自动清理 CDS preview',
    services: {
      admin: {
        profileId: 'admin',
        containerName: 'cds-prd-agent-cursor-file-convert-agent-3f07-admin-prd-agent',
        hostPort: 42845,
        status: 'running',
      },
      api: {
        profileId: 'api',
        containerName: 'cds-prd-agent-cursor-file-convert-agent-3f07-api-prd-agent',
        hostPort: 42828,
        status: 'running',
      },
    },
    ...overrides,
  };
}

describe('startup reconciliation of a first deployment failure', () => {
  const empty = () => branch({ services: {}, status: 'idle', githubCommitSha: 'a'.repeat(40),
    lastStopSource: undefined, lastStopReason: undefined });
  const failure = (b: BranchEntry): DeploymentRun => ({ id: 'dr_first', projectId: b.projectId!, branchId: b.id,
    trigger: 'manual', status: 'failed', phase: 'starting', seq: 1, firstEventSeq: 1,
    commitSha: b.githubCommitSha, startedAt: '2026-10-15T03:00:00Z', updatedAt: '2026-10-15T03:01:00Z',
    finishedAt: '2026-10-15T03:01:00Z', events: [], failure: { code: 'candidate_create_identity', owner: 'cds',
      summary: 'candidate_create_identity: creation identity cannot be overwritten', retryable: false, evidenceRefs: [] } });

  it('does not erase a failure just because there was never a published service', () => {
    const b = empty(); b.status = 'error'; b.errorMessage = 'original first deployment error';
    expect(reconcileBranchStatusFromServices(b).changed).toBe(false);
    expect(b.status).toBe('error'); expect(b.errorMessage).toBe('original first deployment error');
  });
  it.each(['idle', 'starting', 'building'] as const)('restores an already-erased first failure from the same branch and exact target run: %s', status => {
    const b = empty(); b.status = status; const run = failure(b); const original = JSON.stringify(run);
    expect(reconcileBranchStatusFromServices(b, run).changed).toBe(true);
    expect(b.status).toBe('error'); expect(b.errorMessage).toBe(run.failure!.summary);
    expect(JSON.stringify(run)).toBe(original);
  });
  it.each(['branch', 'project', 'target', 'completed', 'cancelled', 'stopped', 'stopping'])('does not restore unrelated or superseded failures: %s', variant => {
    const b = empty(); const run = failure(b);
    if (variant === 'branch') run.branchId = 'other';
    if (variant === 'project') run.projectId = 'other';
    if (variant === 'target') run.commitSha = 'b'.repeat(40);
    if (variant === 'completed') run.status = 'completed';
    if (variant === 'cancelled') run.status = 'cancelled';
    if (variant === 'stopped') b.lastStoppedAt = '2026-10-15T03:02:00Z';
    if (variant === 'stopping') b.status = 'stopping';
    reconcileBranchStatusFromServices(b, run); expect(b.status).toBe('idle');
  });
  it('continues to derive a successfully published graph from actual service states', () => {
    const b = branch({ status: 'error', errorMessage: 'old failure' });
    reconcileBranchStatusFromServices(b, failure(b));
    expect(b.status).toBe('running'); expect(b.errorMessage).toBeUndefined();
  });
});

describe('startup reconcile delete cleanup residue', () => {
  it('recognizes branch delete cleanup intent from persisted stop metadata', () => {
    expect(hasBranchDeleteCleanupIntent(branch())).toBe(true);
  });

  it('prunes a deleted branch residue when all app containers are gone', () => {
    expect(shouldPruneDeletedBranchStartupResidue(branch(), new Map())).toBe(true);
  });

  it('does not prune when any app container still exists', () => {
    const containers = new Map([
      ['prd-agent-cursor-file-convert-agent-3f07/admin', {
        branchId: 'prd-agent-cursor-file-convert-agent-3f07',
        profileId: 'admin',
        containerName: 'cds-prd-agent-cursor-file-convert-agent-3f07-admin-prd-agent',
        running: true,
      }],
    ]);

    expect(shouldPruneDeletedBranchStartupResidue(branch(), containers)).toBe(false);
  });

  it('does not prune remote-executor branches because master cannot observe executor containers', () => {
    const remote = branch({ executorId: 'executor-a' });

    expect(shouldPruneDeletedBranchStartupResidue(remote, new Map())).toBe(false);
  });

  it('requires both stopping status and an allowed delete source', () => {
    const staleSource = branch({ status: 'error', lastStopSource: 'system' });
    const wrongSource = branch({ status: 'stopping', lastStopSource: 'user' });

    expect(hasBranchDeleteCleanupIntent(staleSource)).toBe(false);
    expect(hasBranchDeleteCleanupIntent(wrongSource)).toBe(false);
    expect(shouldPruneDeletedBranchStartupResidue(staleSource, new Map())).toBe(false);
    expect(shouldPruneDeletedBranchStartupResidue(wrongSource, new Map())).toBe(false);
  });

  it('does not treat a normal manual stop as delete residue', () => {
    const stopped = branch({
      status: 'idle',
      lastStopSource: 'user',
      lastStopReason: '用户手动停止',
    });

    expect(hasBranchDeleteCleanupIntent(stopped)).toBe(false);
    expect(shouldPruneDeletedBranchStartupResidue(stopped, new Map())).toBe(false);
  });
});
