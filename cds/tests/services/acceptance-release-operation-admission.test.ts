import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { acceptanceReleaseOperationAdmission } from '../../src/services/acceptance-release-admission.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import type { BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';
let dir: string, state: StateService;
const id = 'ar_' + 'a'.repeat(32), sha = 'b'.repeat(40);
const release: BranchOperationRequest = { branchId: 'b', projectId: 'p', kind: 'acceptance-release', trigger: 'system',
  source: 'acceptance-resource-release', commitSha: sha, acceptanceRunId: id };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-own-release-admission-op-'));
  state = new StateService(path.join(dir, 'state.json')); state.load(); });
afterEach(async () => { await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
function occupy() {
  // A controlled persisted record tests scope, not report/owner/Daemon evidence.
  state.getState().acceptanceResourceRuns = { [id]: { ...release, targetSha: sha, id, seq: 4, stage: 'finished', profileId: 'init',
    resource: { containerId: 'c'.repeat(64) }, terminal: { reportId: 'owned' }, releaseIntent: { version: 1, phase: 'prepared' } } as any };
}
const coordinator = () => new BranchOperationCoordinator(undefined, undefined, undefined,
  request => acceptanceReleaseOperationAdmission(state, request));
describe('persistent intent admission precedes in-flight coordination', () => {
  it.each(['deploy', 'deploy-profile', 'stop', 'delete', 'restart', 'reset', 'force-rebuild', 'scheduler-cooling', 'janitor-remove', 'candidate-reconcile'] as const)
  ('rejects %s before joining, queueing or cancelling a current writer', kind => {
    const c = coordinator(); const old = c.begin({ branchId: 'b', projectId: 'p', kind: 'deploy', trigger: 'manual',
      commitSha: sha, configHash: "owned-config", commitPinned: true }).lease!;
    occupy(); const result = c.begin({ branchId: 'b', projectId: 'p', kind, trigger: kind === 'deploy' ? 'webhook' : 'manual',
      commitSha: sha, configHash: "owned-config", commitPinned: true, profileId: kind === 'deploy-profile' ? 'api' : undefined });
    expect(result.status).toBe('rejected'); expect(result.reason).toBe('acceptance_release_reconciliation_required');
    expect(old.isCurrent()).toBe(true); expect(old.signal?.aborted).toBe(false); expect(c.getPendingWebhookDeploy('b')).toBeUndefined();
    c.complete(old, 'completed');
  });
  it('grants only the uniquely scoped release retry, not ownership/cleanup authority', () => {
    occupy(); expect(coordinator().begin(release).status).toBe('started');
    expect(coordinator().begin({ branchId: 'other', projectId: 'p', kind: 'deploy', trigger: 'manual' }).status).toBe('started');
  });
  it.each(['wrong-run', 'wrong-project', 'wrong-sha', 'unknown-phase', 'missing-report', 'missing-resource', 'duplicate', 'pending-publication'])
  ('does not redeem an ambiguous or mismatched release: %s', variant => {
    occupy(); const req = { ...release }, row = state.getState().acceptanceResourceRuns![id];
    if (variant === 'wrong-run') req.acceptanceRunId = 'ar_' + 'd'.repeat(32);
    if (variant === 'wrong-project') req.projectId = 'foreign';
    if (variant === 'wrong-sha') req.commitSha = 'e'.repeat(40);
    if (variant === 'unknown-phase') (row.releaseIntent as any).phase = 'unknown';
    if (variant === 'missing-report') delete row.terminal;
    if (variant === 'missing-resource') delete row.resource;
    if (variant === 'duplicate') state.getState().acceptanceResourceRuns!['ar_' + 'd'.repeat(32)] = { ...row, id: 'ar_' + 'd'.repeat(32) };
    if (variant === 'pending-publication') state.getState().acceptanceResourcePublications = { [id]: { draft: row } };
    expect(coordinator().begin(req).status).toBe('rejected');
  });
  it('absence of release intent keeps existing join compatibility', () => {
    const c = coordinator(), req: BranchOperationRequest = { branchId: 'b', kind: 'deploy', trigger: 'manual', commitSha: sha, configHash: "owned-config", commitPinned: true };
    const old = c.begin(req).lease!; expect(c.begin(req).status).toBe('joined'); c.complete(old, 'completed');
  });
});
