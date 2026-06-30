import { describe, expect, it } from 'vitest';
import { hasBranchDeleteCleanupIntent, shouldPruneDeletedBranchStartupResidue } from '../../src/services/startup-reconcile.js';
import type { BranchEntry } from '../../src/types.js';

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
