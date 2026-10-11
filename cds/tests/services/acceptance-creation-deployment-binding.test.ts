import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { BranchOperationCoordinator, type BranchOperationLease } from '../../src/services/branch-operation-coordinator.js';
import { acceptanceReleaseBlockReason, acceptanceReleaseOperationAdmission } from '../../src/services/acceptance-release-admission.js';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

// Actual services and State JSON. No HTTP deployment dispatch or Daemon proof.
describe('guide2.96 original creation deployment binding', () => {
  const sha = 'a'.repeat(40); let root: string, state: StateService, service: AcceptanceResourceRunService;
  let runs: DeploymentRunService, coordinator: BranchOperationCoordinator, lease: BranchOperationLease, shell: MockShellExecutor;
  let owner: Awaited<ReturnType<AcceptanceResourceRunService['begin']>>, deploymentId: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-creation-bind-')); state = new StateService(path.join(root, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: 'own' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'own/bind', worktreePath: root, createdAt: '2026-10-12T00:00:00Z', status: 'idle', services: {} });
    coordinator = new BranchOperationCoordinator(undefined, undefined, undefined, request => acceptanceReleaseOperationAdmission(state, request));
    shell = new MockShellExecutor(); service = new AcceptanceResourceRunService(state, undefined, undefined, { coordinator, lifecycle: new OwnedContainerLifecycle(shell, 'owned-instance'), canExecute: () => true });
    owner = await service.begin({ projectId: 'p1', branchId: 'b1', profileId: 'init', targetSha: sha, isolationRunId: 'owned_run' });
    await service.createProfile(owner.run.id, owner.ownerToken, { dockerImage: 'ghcr.io/test/init:sha-' + sha, containerPort: 8899 });
    runs = new DeploymentRunService(state); deploymentId = (await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual', commitSha: sha })).id;
  });
  afterEach(async () => { vi.restoreAllMocks(); coordinator.clearForTest(); await state.flush(); fs.rmSync(root, { recursive: true, force: true }) });
  function acquire() {
    lease = coordinator.begin({ projectId: 'p1', branchId: 'b1', kind: 'acceptance-create', trigger: 'system', source: 'acceptance-resource-deploy', acceptanceRunId: owner.run.id, commitSha: sha }).lease!;
    expect(lease).toBeDefined();
  }
  function bind() { return (service as any).bindCreationDeployment(owner.run.id, owner.ownerToken, deploymentId, lease) }
  it('atomically binds the actual pending deployment and original configured run', async () => {
    acquire(); const result = await bind(); expect(result.creationIntent).toMatchObject({ phase: 'deploying', deploymentRunId: deploymentId, operationId: lease.operationId });
    expect((runs.get(deploymentId)! as any).acceptanceOrigin).toEqual({ version: 1, acceptanceRunId: owner.run.id, profileId: 'init', targetSha: sha, profileDigest: result.creationIntent.profileDigest, operationId: lease.operationId });
    expect(runs.get(deploymentId)!.operationId).toBe(lease.operationId);
    const restored = new StateService(path.join(root, 'state.json')); restored.load(); await restored.flush();
    expect((restored.getDeploymentRun(deploymentId)! as any).acceptanceOrigin).toEqual((runs.get(deploymentId)! as any).acceptanceOrigin);
    expect(restored.getState().acceptanceResourceRuns![owner.run.id].creationIntent!.deploymentRunId).toBe(deploymentId);
    expect(JSON.stringify(state.getState())).not.toContain(owner.ownerToken); expect(shell.commands).toHaveLength(0);
  });
  it.each(['ordinaryLease','cancel','foreignRun','wrongSha','terminalRun','config','override','service'])('refuses %s without binding either side', async change => {
    acquire();
    if (change === 'ordinaryLease') lease = { ...lease, request: { ...lease.request, kind: 'deploy' } };
    if (change === 'cancel') coordinator.cancelBranch('b1', 'own cancel');
    const deployment = runs.get(deploymentId)!;
    if (change === 'foreignRun') deployment.projectId = 'other';
    if (change === 'wrongSha') deployment.commitSha = 'b'.repeat(40);
    if (change === 'terminalRun') deployment.status = 'running';
    if (change === 'config') state.getBranch('b1')!.extraProfiles![0].containerPort = 8900;
    if (change === 'override') state.getBranch('b1')!.profileOverrides = { init: { env: { DRIFT: 'yes' } } };
    if (change === 'service') state.getBranch('b1')!.services.init = { profileId: 'init', status: 'running', containerName: 'foreign', hostPort: 10000 };
    await expect(bind()).rejects.toThrow(); expect((deployment as any).acceptanceOrigin).toBeUndefined(); expect(service.get(owner.run.id)!.creationIntent!.phase).toBe('configured');
  });
  it.each([1,2])('keeps both public rows old until ACK %i', async barrier => {
    acquire(); const flush = state.flush.bind(state); let count = 0, enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { resume = resolve });
    vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count === barrier) { enter(); await gate } });
    const pending = bind(); await entered;
    try {
      expect(service.get(owner.run.id)!.creationIntent!.phase).toBe('configured'); expect((runs.get(deploymentId)! as any).acceptanceOrigin).toBeUndefined();
      const copy = path.join(root, 'ack-' + barrier + '.json'); fs.copyFileSync(path.join(root, 'state.json'), copy); const restored = new StateService(copy); restored.load(); await restored.flush();
      expect(Boolean((restored.getDeploymentRun(deploymentId)! as any).acceptanceOrigin)).toBe(barrier === 2);
      expect(restored.getState().acceptanceResourceRuns![owner.run.id].creationIntent!.phase).toBe(barrier === 2 ? 'deploying' : 'configured');
      expect(acceptanceReleaseBlockReason(restored, 'b1')).toBe('acceptance_creation_reconciliation_required'); expect(shell.commands).toHaveLength(0);
    } finally { resume() }
    await pending;
  });
  it.each(['runMutation','branchReplacement','leaseCancel'])('retracts %s after the second ACK', async change => {
    acquire(); const flush = state.flush.bind(state); let count = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count === 2) {
      if (change === 'runMutation') runs.get(deploymentId)!.status = 'failed';
      if (change === 'branchReplacement') state.getState().branches.b1 = { ...state.getBranch('b1')! };
      if (change === 'leaseCancel') coordinator.cancelBranch('b1', 'after ACK');
    } });
    await expect(bind()).rejects.toThrow(); expect((runs.get(deploymentId)! as any).acceptanceOrigin).toBeUndefined(); expect(service.get(owner.run.id)!.creationIntent!.phase).toBe('configured');
    if (change === 'runMutation') expect(runs.get(deploymentId)!.status).toBe('failed');
  });
  it('does not treat a bound run as inspect and registration evidence', async () => {
    acquire(); await bind(); runs.get(deploymentId)!.status = 'running';
    state.getBranch('b1')!.services.init = { profileId: 'init', containerId: 'c'.repeat(64), containerName: 'own', status: 'running', deployedCommitSha: sha, hostPort: 10000 };
    await expect(service.register(owner.run.id, owner.ownerToken)).rejects.toThrow('acceptance_resource_unconfirmed'); expect(service.get(owner.run.id)!.stage).toBe('active');
  });
  it.each([1,2])('retracts a failed ACK %i with deployment entity compensation hints', async barrier => {
    acquire(); const flush = state.flush.bind(state); let count = 0;
    const saves = vi.spyOn((state as any).backingStore, 'save');
    vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count === barrier) throw new Error('own ACK failed') });
    await expect(bind()).rejects.toThrow('own ACK failed');
    expect(saves.mock.calls.at(-1)![1]).toContainEqual({ kind: 'deploymentRuns', id: deploymentId });
    const restored = new StateService(path.join(root, 'state.json')); restored.load(); await restored.flush();
    expect((restored.getDeploymentRun(deploymentId)! as any).acceptanceOrigin).toBeUndefined();
    expect(restored.getState().acceptanceResourceRuns![owner.run.id].creationIntent!.phase).toBe('configured');
  });
  it('retains unknown compensation occupancy and refuses automatic rebinding', async () => {
    acquire(); const flush = state.flush.bind(state); let count = 0;
    const spy = vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count >= 2) throw new Error('own ACK unknown') });
    await expect(bind()).rejects.toThrow('own ACK unknown'); spy.mockRestore();
    expect(service.get(owner.run.id)!.creationIntent!.phase).toBe('configured'); expect((runs.get(deploymentId)! as any).acceptanceOrigin).toBeUndefined();
    await expect(bind()).rejects.toThrow('acceptance_run_recovery_required');
    state.save(); await state.flush(); const restored = new StateService(path.join(root, 'state.json')); restored.load(); await restored.flush();
    expect(acceptanceReleaseBlockReason(restored, 'b1')).toBe('acceptance_creation_reconciliation_required');
    expect(restored.getState().acceptanceResourcePublications![owner.run.id].draft.creationIntent!.phase).toBe('deploying');
    expect((restored.getDeploymentRun(deploymentId)! as any).acceptanceOrigin).toBeUndefined();
    expect(coordinator.begin({ projectId: 'p1', branchId: 'b1', kind: 'acceptance-create', trigger: 'system', source: 'acceptance-resource-deploy', acceptanceRunId: owner.run.id, commitSha: sha }).status).toBe('rejected');
  });
  it('preserves unrelated saves during the committed snapshot ACK', async () => {
    state.addBranch({ id: 'other', projectId: 'p1', branch: 'own/other', worktreePath: root, createdAt: '2026-10-12T00:00:00Z', status: 'idle', services: {} });
    acquire(); const flush = state.flush.bind(state); let count = 0, enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { resume = resolve });
    vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count === 2) { enter(); await gate } });
    const pending = bind(); await entered;
    try { state.getBranch('other')!.notes = 'independent accepted write'; state.save([{ kind: 'branches', id: 'other' }]); }
    finally { resume() }
    await pending; await state.flush(); const restored = new StateService(path.join(root, 'state.json')); restored.load(); await restored.flush();
    expect(restored.getBranch('other')!.notes).toBe('independent accepted write');
    expect((restored.getDeploymentRun(deploymentId)! as any).acceptanceOrigin.acceptanceRunId).toBe(owner.run.id);
  });
  it('rejects a copied lease and a foreign capability', async () => {
    acquire(); const original = lease; lease = { ...lease };
    await expect(bind()).rejects.toThrow('acceptance_creation_lease'); lease = original;
    await expect(service.bindCreationDeployment(owner.run.id, 'f'.repeat(64), deploymentId, lease)).rejects.toThrow('acceptance_owner_required');
    expect((runs.get(deploymentId)! as any).acceptanceOrigin).toBeUndefined();
  });
  it.each(['foreignOwner', 'wrongCommit', 'ordinarySource'])('does not admit a configured continuation with %s', async change => {
    const request: any = { projectId: 'p1', branchId: 'b1', kind: 'acceptance-create', trigger: 'system', source: 'acceptance-resource-deploy', acceptanceRunId: owner.run.id, commitSha: sha };
    if (change === 'foreignOwner') request.acceptanceRunId = 'ar_' + 'f'.repeat(32);
    if (change === 'wrongCommit') request.commitSha = 'b'.repeat(40);
    if (change === 'ordinarySource') request.source = 'acceptance-resource-create';
    expect(coordinator.begin(request).status).toBe('rejected'); expect(shell.commands).toHaveLength(0);
  });

  it.each(['operationId','commitSha'])('refuses an ordinary legal transition changing bound %s', async field => {
    acquire(); await bind(); const before = structuredClone(runs.get(deploymentId)!);
    expect(() => runs.transition(deploymentId, 'preparing', { phase: 'prepare', message: 'own state transition',
      [field]: field === 'operationId' ? 'op_owned_foreign' : 'b'.repeat(40) })).toThrow('acceptance_deployment_identity_changed');
    expect(runs.get(deploymentId)).toEqual(before); await state.flush();
    const restored = new StateService(path.join(root, 'state.json')); restored.load(); await restored.flush();
    expect(restored.getDeploymentRun(deploymentId)).toEqual(before);
  });

  it.each(['id','projectId','branchId','startedAt','originRemoval','originRewrite'])('rejects a bound %s mutation without publishing partial state', async field => {
    acquire(); await bind(); const before = structuredClone(runs.get(deploymentId)!);
    expect(() => state.updateDeploymentRun(deploymentId, draft => {
      if (field === 'originRemoval') delete draft.acceptanceOrigin;
      else if (field === 'originRewrite') draft.acceptanceOrigin!.profileId = 'other';
      else (draft as any)[field] = 'foreign';
    })).toThrow('acceptance_deployment_identity_changed'); expect(runs.get(deploymentId)).toEqual(before);
  });
  it.each(['operationId','commitSha'])('rejects a durable terminal changing original %s before flush', async field => {
    acquire(); await bind(); runs.transition(deploymentId, 'preparing', { phase: 'prepare', message: 'own' });
    runs.transition(deploymentId, 'building', { phase: 'build', message: 'own' }); runs.transition(deploymentId, 'starting', { phase: 'start', message: 'own' });
    runs.transition(deploymentId, 'verifying', { phase: 'ready', message: 'own' });
    const before = structuredClone(runs.get(deploymentId)!), flush = vi.fn(async () => {});
    await expect(runs.completeDurably(deploymentId, { phase: 'complete', message: 'own',
      [field]: field === 'operationId' ? 'op_owned_foreign' : 'b'.repeat(40) }, flush, () => {})).rejects.toThrow('acceptance_deployment_identity_changed');
    expect(flush).not.toHaveBeenCalled(); expect(runs.get(deploymentId)).toEqual(before);
    await runs.completeDurably(deploymentId, { phase: 'complete', message: 'own', operationId: lease.operationId, commitSha: sha }, () => state.flush(), () => lease.assertCurrent());
    expect(runs.get(deploymentId)!.status).toBe('running'); expect(runs.get(deploymentId)!.operationId).toBe(lease.operationId);
  });

});
