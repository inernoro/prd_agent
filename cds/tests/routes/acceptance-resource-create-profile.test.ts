import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { acceptanceReleaseBlockReason, acceptanceReleaseOperationAdmission } from '../../src/services/acceptance-release-admission.js';
import { createAcceptanceResourceRunsRouter } from '../../src/routes/acceptance-resource-runs.js';

// Native own HTTP + actual State JSON. No real Docker or database proof.
describe('P5-05 conditional owned profile creation', () => {
  const sha = 'a'.repeat(40), profileId = 'owned-init';
  let dir: string, state: StateService, ledger: AcceptanceResourceRunService, coordinator: BranchOperationCoordinator;
  let server: http.Server, owner: Awaited<ReturnType<AcceptanceResourceRunService['begin']>>, remote: boolean;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-create-profile-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: 'own' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'own/create', createdAt: '2026-10-11T00:00:00Z', worktreePath: dir, status: 'idle', services: {} });
    state.setBranchExtraProfiles('b1', [{ id: 'seed', projectId: 'p1' }] as any);
    ledger = new AcceptanceResourceRunService(state);
    owner = await ledger.begin({ projectId: 'p1', branchId: 'b1', targetSha: sha, profileId, isolationRunId: 'owned_run' });
    coordinator = new BranchOperationCoordinator(undefined, undefined, undefined, request => acceptanceReleaseOperationAdmission(state, request)); remote = false;
    const app = express(); app.use((req, _res, next) => { (req as any).cdsProjectKey = { projectId: req.header('x-test-project') || 'p1' }; next() });
    app.use('/api', createAcceptanceResourceRunsRouter({ stateService: state, release: { coordinator, canExecute: () => !remote, lifecycle: {} as any } }));
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  });
  afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }) });
  function proposal(overrides: Record<string, unknown> = {}) { return { dockerImage: 'ghcr.io/test/init:sha-' + sha, containerPort: 8899, env: { CDS_CONFIGURE_ONLY: 'true', PRIVATE: 'private-value' }, ...overrides } }
  function request(profile = proposal(), token = owner.ownerToken, project = 'p1') {
    return new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
      const data = JSON.stringify({ ownerToken: token, profile });
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api/acceptance-resource-runs/' + owner.run.id + '/create-profile', method: 'POST', agent: false,
        headers: { 'x-test-project': project, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk }); res.on('end', () => { let body; try { body = JSON.parse(raw) } catch { body = null }; resolve({ status: res.statusCode!, body, raw }) });
      });
      req.setTimeout(5000, () => req.destroy(new Error('own HTTP budget'))); req.on('error', reject); req.end(data);
    });
  }
  it('conditionally appends only the original profile and preserves another accepted addition', async () => {
    state.setBranchExtraProfiles('b1', [...state.getBranch('b1')!.extraProfiles!, { id: 'concurrent', projectId: 'p1' }] as any);
    const result = await request(); expect(result.status).toBe(201); expect(result.body.run.stage).toBe('active'); expect(result.body.run.creationIntent.phase).toBe('configured');
    expect(result.raw).not.toMatch(/ownerHash|ownerToken|private-value|dockerImage/);
    const branch = state.getBranch('b1')!; expect(branch.extraProfiles!.map(p => p.id)).toEqual(['seed', 'concurrent', profileId]);
    expect(branch.extraProfiles!.at(-1)).toMatchObject({ id: profileId, projectId: 'p1', prebuiltImage: true, prebuiltCommitPolicy: 'exact', activeDeployMode: 'express', command: '', env: { IMP_HEALTH_RUN_ID: 'owned_run', IMP_TARGET_SHA: sha } });
    const reloaded = new StateService(path.join(dir, 'state.json')); reloaded.load(); await reloaded.flush(); expect(reloaded.getBranch('b1')!.extraProfiles).toEqual(branch.extraProfiles);
    expect((await request()).status).toBe(409);
  });
  it.each(['project', 'owner', 'remote', 'busy', 'collision', 'override'])('refuses %s before publishing', async kind => {
    if (kind === 'remote') remote = true;
    if (kind === 'busy') coordinator.begin({ projectId: 'p1', branchId: 'b1', kind: 'deploy', trigger: 'manual' });
    if (kind === 'collision') state.getBranch('b1')!.extraProfiles!.push({ id: profileId, projectId: 'p1' } as any);
    if (kind === 'override') state.getBranch('b1')!.profileOverrides = { [profileId]: { env: { FOREIGN: 'yes' } } };
    const before = structuredClone(state.getBranch('b1'));
    const result = await request(proposal(), kind === 'owner' ? 'f'.repeat(64) : owner.ownerToken, kind === 'project' ? 'p2' : 'p1');
    expect(result.status).toBe(kind === 'project' || kind === 'owner' ? 403 : kind === 'remote' ? 503 : 409);
    expect(state.getBranch('b1')).toEqual(before); expect((ledger.get(owner.run.id)! as any).creationIntent).toBeUndefined();
  });
  it.each([{ dockerImage: 'ghcr.io/test/init:branch-main' }, { command: 'pnpm dev' }, { cacheMounts: [] }, { entrypoint: 'sh' }, { containerPort: 0 }, { env: { CDS_FINALIZE_RUNTIME: 'true' } }, { env: { IMP_TARGET_SHA: 'b'.repeat(40) } }])('refuses unsafe proposal %j', async invalid => {
    expect((await request(proposal(invalid))).status).toBe(400); expect(state.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed']);
  });
  it.each(['image', 'healthPath', 'envKey'])('rejects owner capability in %s before persisting a proposal', async field => {
    const invalid = field === 'image' ? { dockerImage: 'ghcr.io/' + owner.ownerToken + '/init:sha-' + sha }
      : field === 'healthPath' ? { healthPath: '/health/' + owner.ownerToken }
      : { env: { ['SECRET_' + owner.ownerToken]: 'value' } };
    expect((await request(proposal(invalid))).status).toBe(400);
    expect(state.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed']);
    expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(owner.ownerToken);
  });
  it('never places the owner capability in a profile', async () => { expect((await request(proposal({ env: { ANY: owner.ownerToken } }))).status).toBe(400); expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(owner.ownerToken) });
  it.each([1, 2])('keeps the profile unpublished until ACK %i and blocks ordinary writes', async barrier => {
    const flush = state.flush.bind(state); let count = 0, enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { resume = resolve });
    vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count === barrier) { enter(); await gate } });
    const pending = request(); await entered;
    try {
      expect(state.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed']); expect((ledger.get(owner.run.id)! as any).creationIntent).toBeUndefined();
      expect(acceptanceReleaseBlockReason(state, 'b1')).toBe('acceptance_creation_reconciliation_required'); expect(() => state.setBranchExtraProfiles('b1', [])).toThrow('acceptance_creation_reconciliation_required');
      const cloneFile = path.join(dir, 'readback-' + barrier + '.json'); fs.copyFileSync(path.join(dir, 'state.json'), cloneFile); const readback = new StateService(cloneFile); readback.load(); await readback.flush();
      expect(readback.getBranch('b1')!.extraProfiles!.some(p => p.id === profileId)).toBe(barrier === 2); expect(acceptanceReleaseBlockReason(readback, 'b1')).toBe('acceptance_creation_reconciliation_required');
    } finally { resume() }
    expect((await pending).status).toBe(201);
  });
  it('preserves other graph changes observed during the first ACK', async () => {
    const flush = state.flush.bind(state); let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { resume = resolve }); vi.spyOn(state, 'flush').mockImplementationOnce(async () => { await flush(); enter(); await gate });
    const pending = request(); await entered; state.getBranch('b1')!.extraProfiles!.push({ id: 'new-other', projectId: 'p1' } as any); state.save([{ kind: 'branches', id: 'b1' }]); resume();
    expect((await pending).status).toBe(201); expect(state.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed', 'new-other', profileId]);
  });
  it('retracts post-ACK target drift without deleting another owner profile', async () => {
    const flush = state.flush.bind(state); let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { resume = resolve }); vi.spyOn(state, 'flush').mockImplementationOnce(async () => { await flush(); enter(); await gate });
    const pending = request(); await entered; state.getBranch('b1')!.extraProfiles!.push({ id: profileId, projectId: 'p1', name: 'foreign' } as any); resume();
    expect((await pending).status).toBe(409); expect(state.getBranch('b1')!.extraProfiles!.at(-1)!.name).toBe('foreign'); expect((ledger.get(owner.run.id)! as any).creationIntent).toBeUndefined();
  });
  it.each([1, 2])('retracts a failed ACK %i without publishing a profile', async barrier => {
    const flush = state.flush.bind(state); let count = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count === barrier) throw new Error('own ACK failed') });
    expect((await request()).status).toBe(500);
    expect(state.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed']);
    expect(ledger.get(owner.run.id)!.creationIntent).toBeUndefined();
    const restored = new StateService(path.join(dir, 'state.json')); restored.load(); await restored.flush();
    expect(restored.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed']);
    expect(acceptanceReleaseBlockReason(state, 'b1')).toBeNull();
  });
  it('keeps an unknown compensation occupied and refuses an automatic retry', async () => {
    const flush = state.flush.bind(state); let count = 0;
    const spy = vi.spyOn(state, 'flush').mockImplementation(async () => { await flush(); if (++count >= 2) throw new Error('own ACK unknown') });
    expect((await request()).status).toBe(500); spy.mockRestore();
    expect(state.getBranch('b1')!.extraProfiles!.map(p => p.id)).toEqual(['seed']);
    expect(acceptanceReleaseBlockReason(state, 'b1')).toBe('acceptance_creation_reconciliation_required');
    expect((await request()).body.error).toBe('acceptance_run_recovery_required');
    state.save(); await state.flush();
    const restored = new StateService(path.join(dir, 'state.json')); restored.load(); await restored.flush();
    expect(acceptanceReleaseBlockReason(restored, 'b1')).toBe('acceptance_creation_reconciliation_required');
    expect(restored.getState().acceptanceResourceRuns![owner.run.id].creationIntent).toBeUndefined();
  });
  it('cannot erase a configured intent through the ordinary row writer', async () => {
    expect((await request()).status).toBe(201);
    const row = structuredClone(state.getState().acceptanceResourceRuns![owner.run.id]); const seq = row.seq;
    delete row.creationIntent; row.seq++;
    await expect(state.writeAcceptanceResourceRunDurably(row, seq, () => {})).rejects.toThrow('acceptance_creation_intent_changed');
    expect(acceptanceReleaseBlockReason(state, 'b1')).toBe('acceptance_creation_reconciliation_required');
  });
  it('cannot register a merely configured profile using an unrelated latest run', async () => {
    expect((await request()).status).toBe(201); const branch = state.getBranch('b1')!;
    branch.services[profileId] = { profileId, containerId: 'c'.repeat(64), containerName: 'own', status: 'running', hostPort: 10000, deployedCommitSha: sha };
    state.addDeploymentRun({ id: 'dr_other', projectId: 'p1', branchId: 'b1', profileId: 'ordinary-other', commitSha: sha, status: 'running', startedAt: new Date().toISOString(), seq: 1, events: [] } as any);
    await expect(ledger.register(owner.run.id, owner.ownerToken)).rejects.toThrow('acceptance_resource_unconfirmed'); expect(ledger.get(owner.run.id)!.stage).toBe('active');
  });
});
