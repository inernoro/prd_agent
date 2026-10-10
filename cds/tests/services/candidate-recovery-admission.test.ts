import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { candidateOperationAdmission } from '../../src/services/candidate-operation-admission.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
let dir: string, state: StateService, runId: string;
const sha = 'a'.repeat(40);
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-recovery-admission-'));
  state = new StateService(path.join(dir, 'state.json')); state.load();
  state.addBranch({ id: 'branch', projectId: 'project', branch: 'test', worktreePath: '/unused',
    status: 'error', services: {}, createdAt: new Date().toISOString() });
  runId = (await new DeploymentRunService(state).begin({ projectId: 'project', branchId: 'branch', trigger: 'manual',
    commitSha: sha, operationId: 'op_original', configHash: 'frozen' })).id;
  state.updateDeploymentRun(runId, run => {
    run.status = 'failed'; run.finishedAt = new Date().toISOString();
    run.candidate = { phase: 'reconciling', operationId: run.operationId!, targetSha: sha, configHash: 'frozen', networkName: 'net',
      updatedAt: new Date().toISOString(), serving: {}, services: {}, recoveryProof: { version: 1, serving: {}, artifacts: {} } };
  });
  await state.flush(); const reloaded = new StateService(path.join(dir, 'state.json')); reloaded.load(); state = reloaded;
});
afterEach(async () => { await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
const request = () => ({ projectId: 'project', branchId: 'branch', kind: 'candidate-reconcile' as const, trigger: 'system' as const,
  source: 'candidate-reconciler', reconcileRunId: runId });
describe('P3 recovery admission reads terminal scoped JSON, never grants Daemon cleanup by itself', () => {
  it('grants only the recovery lease while normal deployment admission remains closed', () => {
    const coordinator = new BranchOperationCoordinator(null, req => candidateOperationAdmission(state, req));
    expect(coordinator.begin({ projectId: 'project', branchId: 'branch', kind: 'deploy', trigger: 'manual' }).status).toBe('rejected');
    const recovery = coordinator.begin(request()); expect(recovery.status).toBe('started');
    expect(coordinator.begin(request()).status).toBe('rejected');
    coordinator.complete(recovery.lease!, 'completed');
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(coordinator.begin({ projectId: 'project', branchId: 'branch', kind: 'deploy', trigger: 'manual' }).status).toBe('rejected');
  });
  it.each(['active-run', 'running-run', 'missing-terminal', 'released', 'legacy-proof', 'unknown-proof', 'operation-drift',
    'target-drift', 'config-drift', 'foreign-project', 'wrong-run', 'second-journal', 'unknown-phase', 'missing-operation'])('rejects ambiguous or mismatched recovery scope: %s', variant => {
    const run = state.getDeploymentRun(runId)!; const req = request();
    if (variant === 'unknown-phase') (run.candidate as any).phase = 'future';
    if (variant === 'missing-operation') { delete run.operationId; delete (run.candidate as any).operationId; }
    if (variant === 'active-run') run.status = 'starting';
    if (variant === 'running-run') run.status = 'running';
    if (variant === 'missing-terminal') delete run.finishedAt;
    if (variant === 'released') run.candidate!.phase = 'released';
    if (variant === 'legacy-proof') delete run.candidate!.recoveryProof;
    if (variant === 'unknown-proof') (run.candidate!.recoveryProof as any).version = 2;
    if (variant === 'operation-drift') run.operationId = 'new-owner';
    if (variant === 'target-drift') run.commitSha = 'b'.repeat(40);
    if (variant === 'config-drift') run.configHash = 'other';
    if (variant === 'foreign-project') req.projectId = 'foreign';
    if (variant === 'wrong-run') req.reconcileRunId = 'dr_other';
    if (variant === 'second-journal') state.addDeploymentRun({ ...structuredClone(run), id: 'dr_second' });
    expect(candidateOperationAdmission(state, req)).toContain('candidate_reconciliation_scope');
  });
});
