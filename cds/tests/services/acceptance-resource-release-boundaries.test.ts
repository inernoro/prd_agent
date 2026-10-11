import { describe, expect, it, vi } from 'vitest';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import type { BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';
import type { ExecResult, IShellExecutor } from '../../src/types.js';
import { PendingDeployJournal } from '../../src/services/pending-deploy-journal.js';

const ID = 'a'.repeat(64);
const release = { branchId: 'b', projectId: 'p', kind: 'acceptance-release' as const, trigger: 'system' as const,
  source: 'acceptance-resource-release', acceptanceRunId: 'ar_' + 'b'.repeat(32), commitSha: 'c'.repeat(40) };
const missing = (identity: string): ExecResult => ({ exitCode: 1, stdout: '', stderr: 'Error: No such object: ' + identity });

describe('acceptance release execution prerequisites (guide 2.93)', () => {
  it.each([
    { ...missing(ID), exitCode: 124 }, { ...missing(ID), exitCode: 130 }, { ...missing(ID), exitCode: 0 },
    { ...missing(ID), stdout: 'partial output' }, missing('d'.repeat(64)),
    { ...missing(ID), stderr: missing(ID).stderr + '\nCannot connect to the Docker daemon' },
    { ...missing(ID), stderr: 'permission denied\n' + missing(ID).stderr },
    { ...missing(ID), stderr: 'No such object' },
    { ...missing(ID), stderr: missing(ID).stderr + '\n' + missing(ID).stderr },
  ])('does not equate unknown inspect outcome with exact absence: %#', async result => {
    const exec = vi.fn(async (_command: string) => result);
    const lifecycle = new OwnedContainerLifecycle({ exec } as unknown as IShellExecutor, 'instance');
    await expect(lifecycle.confirmAbsent(ID, () => {})).rejects.toThrow('container_absence_unconfirmed');
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each(['No such object: ', 'Error: No such object: ', 'Error response from daemon: No such container: '])
  ('accepts only a standard missing diagnostic for the requested identity: %s', async prefix => {
    const exec = vi.fn(async (_command: string) => ({ exitCode: 1, stdout: '', stderr: prefix + ID + '\n' }));
    await expect(new OwnedContainerLifecycle({ exec } as unknown as IShellExecutor, 'instance')
      .confirmAbsent(ID, () => {})).resolves.toBeUndefined();
  });
  it('never removes after a timed-out pre-inspect, even if it contains a missing diagnostic', async () => {
    const exec = vi.fn(async (_command: string) => ({ ...missing(ID), exitCode: 124 }));
    const lifecycle = new OwnedContainerLifecycle({ exec } as unknown as IShellExecutor, 'instance');
    await expect(lifecycle.remove({ id: ID, name: 'bootstrap', image: 'sha256:' + 'e'.repeat(64),
      owner: { projectId: 'p', branchId: 'b', profileId: 'bootstrap' }, wasRunning: false,
      writableMounts: [], fingerprint: 'sha256:' + 'f'.repeat(64) }, () => {})).rejects.toThrow('container_inspect');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    { source: 'other' }, { trigger: 'webhook' }, { profileId: 'bootstrap' }, { projectId: '' },
    { projectId: undefined }, { acceptanceRunId: '' }, { acceptanceRunId: undefined },
    { branchId: '../b' }, { commitSha: 'c'.repeat(7) },
  ])('rejects malformed internal release scope without starting an operation: %#', patch => {
    const coordinator = new BranchOperationCoordinator();
    expect(coordinator.begin({ ...release, ...patch } as BranchOperationRequest).status).toBe('rejected');
    expect(coordinator.getActiveOperations()).toEqual([]);
  });
  it.each([
    { kind: 'deploy', trigger: 'manual' }, { kind: 'deploy', trigger: 'webhook' },
    { kind: 'deploy-profile', trigger: 'manual', profileId: 'api' },
    ...['stop', 'delete', 'reset', 'force-rebuild', 'restart'].map(kind => ({ kind, trigger: 'manual' })),
  ])('rejects conflicting operations rather than preempting, joining or queueing: %#', incoming => {
    const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin(release as BranchOperationRequest).lease!;
    const request = { branchId: 'b', projectId: 'p', ...incoming } as BranchOperationRequest;
    expect(coordinator.begin(request).status).toBe('rejected');
    expect(lease.isCurrent()).toBe(true);
    expect(lease.signal?.aborted).toBe(false);
    expect(coordinator.getPendingWebhookDeploy('b')).toBeUndefined();
    coordinator.complete(lease, 'completed');
    expect(coordinator.begin(request).status).toBe('started');
  });
  it('waits for the original executor after branch cancellation', () => {
    const coordinator = new BranchOperationCoordinator();
    const old = coordinator.begin({ branchId: 'b', kind: 'deploy-profile', profileId: 'api', trigger: 'manual' }).lease!;
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('rejected');
    coordinator.cancelBranch('b', 'cancel');
    expect(coordinator.getActiveOperations()).toEqual([]);
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('rejected');
    coordinator.complete(old, 'cancelled');
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('started');
  });
  it('holds cancelled release until its exact original lease settles', () => {
    const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin(release as BranchOperationRequest).lease!;
    coordinator.cancelBranch('b', 'cancel');
    const stop: BranchOperationRequest = { branchId: 'b', kind: 'stop', trigger: 'manual' };
    expect(coordinator.begin(stop).status).toBe('rejected');
    coordinator.complete({ ...lease }, 'cancelled');
    expect(coordinator.begin(stop).status).toBe('rejected');
    coordinator.complete(lease, 'cancelled');
    expect(coordinator.begin(stop).status).toBe('started');
  });
  it('does not overtake an already accepted pending dispatch', () => {
    const coordinator = new BranchOperationCoordinator();
    const old = coordinator.begin({ branchId: 'b', kind: 'deploy', trigger: 'manual' }).lease!;
    expect(coordinator.begin({ branchId: 'b', kind: 'deploy', trigger: 'webhook' }).status).toBe('merged');
    expect(coordinator.complete(old, 'completed')).toBeTruthy();
    expect(coordinator.getActiveOperations()).toEqual([]);
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('rejected');
    expect(coordinator.getActiveOperations()).toEqual([]);
  });
  it('does not consume or cancel a reserved rebuild continuation', () => {
    const coordinator = new BranchOperationCoordinator();
    const old = coordinator.begin({ branchId: 'b', kind: 'force-rebuild', trigger: 'manual', continueWith: 'deploy' }).lease!;
    coordinator.complete(old, 'completed');
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('rejected');
    expect(coordinator.begin({ branchId: 'b', kind: 'deploy', trigger: 'manual' }).status).toBe('started');
  });
  it('preserves priority on different branches and rejects stale completion', () => {
    const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin(release as BranchOperationRequest).lease!;
    const other = coordinator.begin({ branchId: 'other', kind: 'deploy', trigger: 'manual' }).lease!;
    expect(coordinator.begin({ branchId: 'other', kind: 'stop', trigger: 'manual' }).status).toBe('started');
    expect(other.isCurrent()).toBe(false);
    expect(lease.isCurrent()).toBe(true);
    coordinator.complete(lease, 'completed');
    const next = coordinator.begin({ branchId: 'b', kind: 'deploy', trigger: 'manual' }).lease!;
    coordinator.complete(lease, 'completed');
    expect(next.isCurrent()).toBe(true);
  });
  it.each(['queued', 'claimed'] as const)('does not overtake durable %s work absent from coordinator memory', async phase => {
    const journal = new PendingDeployJournal({ load: async () => null, save: async () => {} });
    await journal.ready();
    const pending = { operationId: 'op_pending', branchId: 'b', generation: 1, mergedCount: 1,
      updatedAt: new Date().toISOString(), request: { branchId: 'b', projectId: 'p', profileId: 'api',
        kind: 'deploy-profile' as const, trigger: 'webhook' as const, commitSha: 'd'.repeat(40) } };
    await journal.upsert(pending);
    if (phase === 'claimed') expect(await journal.claim(pending)).toBe(true);
    const before = journal.snapshot();
    const coordinator = new BranchOperationCoordinator(undefined, undefined, journal);
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('rejected');
    expect(coordinator.getActiveOperations()).toEqual([]);
    expect(journal.snapshot()).toEqual(before);
    expect(coordinator.begin({ ...release, branchId: 'other', trigger: 'manual' } as BranchOperationRequest).status).toBe('started');
    if (phase === 'queued') expect(await journal.claim(pending)).toBe(true);
    await journal.settle(pending, { outcome: 'completed', reason: 'deployment_completed' });
    expect(coordinator.begin(release as BranchOperationRequest).status).toBe('started');
  });
});
