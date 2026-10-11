import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { createSnapshotsRouter } from '../../src/routes/snapshots.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { ContainerService } from '../../src/services/container.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

// Controlled persisted intent isolates admission; it is not evidence of physical container removal.
describe('guide2.94 persisted acceptance intent blocks ordinary writers', () => {
  let dir: string, state: StateService, server: http.Server, shell: MockShellExecutor;
  const id = 'ar_' + 'a'.repeat(32), sha = 'b'.repeat(40), profileId = 'owned-init';
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-own-intent-admission-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p', slug: 'p', name: 'owned' } as any);
    for (const branchId of ['b', 'other']) state.addBranch({ id: branchId, projectId: 'p', branch: branchId,
      status: 'idle', worktreePath: dir, createdAt: '2026-10-11T00:00:00Z', services: {} });
    const b = state.getBranch('b')!;
    b.extraProfiles = [{ id: profileId, projectId: 'p', name: 'owned', dockerImage: 'owned:fixed', containerPort: 80 } as any];
    b.profileOverrides = { [profileId]: { env: { PRIVATE: 'owned-secret' } } };
    b.services[profileId] = { profileId, containerName: 'owned-init', containerId: 'c'.repeat(64), hostPort: 10001, status: 'running' };
    await state.writeAcceptanceResourceRunDurably({ id, seq: 1, projectId: 'p', branchId: 'b', profileId, targetSha: sha,
      branchIdentity: 'd'.repeat(64), isolationRunId: 'owned_run', ownerHash: 'e'.repeat(64), startedAt: '2026-10-11T00:01:00Z', stage: 'finished',
      resource: { configDigest: 'f'.repeat(64), containerId: 'c'.repeat(64), deploymentRunId: 'dr_owned' },
      terminal: { reportId: 'report', metaDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64), verdict: 'fail', finishedAt: '2026-10-11T00:02:00Z' },
      releaseIntent: { version: 1, phase: 'removed', startedAt: '2026-10-11T00:03:00Z', serviceDigest: '3'.repeat(64),
        reference: { owner: { projectId: 'p', branchId: 'b', profileId }, id: 'c'.repeat(64), name: 'owned-init', image: 'sha256:' + '4'.repeat(64),
          wasRunning: true, writableMounts: [], fingerprint: 'sha256:' + '5'.repeat(64) } } }, undefined, () => {});
    shell = new MockShellExecutor(); await mount();
  });
  async function mount() {
    const config: any = { repoRoot: dir, worktreeBase: path.join(dir, 'worktrees'), masterPort: 9900,
      workerPort: 5500, portStart: 10001, dockerNetwork: 'owned', rootDomains: ['owned.test'], previewDomain: 'owned.test', sharedEnv: {}, jwt: { secret: 'owned', issuer: 'owned' } };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).cdsProjectKey = { projectId: req.header('x-test-project') || 'p', keyId: 'owned' }; next(); });
    app.use('/api', createBranchRouter({ stateService: state, shell, config, worktreeService: new WorktreeService(shell, dir),
      containerService: new ContainerService(shell, config), registry: { getAll: () => [], getOnline: () => [], selectExecutor: () => null } as any }));
    app.use('/api', createProjectsRouter({ stateService: state, shell, config }));
    app.use('/api', createSnapshotsRouter({ stateService: state }));
    server = app.listen(0); await new Promise<void>(r => server.once('listening', r));
  }
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await new Promise<void>(r => server.close(() => r())); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(method: string, url: string, body?: unknown, project = 'p') {
    return new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api' + url, method, agent: false,
        headers: { 'x-test-project': project, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c); res.on('end', () => {
          let body; try { body = JSON.parse(raw); } catch { body = null; } resolve({ status: res.statusCode!, body, raw });
        });
      }); req.setTimeout(5000, () => req.destroy(new Error('owned HTTP deadline'))); req.on('error', reject); req.end(data);
    });
  }
  const intents = () => state.getState().acceptanceResourceRuns![id];
  const graph = () => JSON.stringify([state.getBranch('b')!.extraProfiles, state.getBranch('b')!.profileOverrides, state.getBranch('b')!.services]);
  it.each([
    ['PUT', '/branches/b/extra-services?redeploy=1', { extraProfiles: [] }],
    ['PUT', '/branches/b/profile-overrides/owned-init', { env: { PRIVATE: 'changed' } }],
    ['DELETE', '/branches/b/profile-overrides/owned-init', undefined],
    ['POST', '/branches/b/copy-config-from/other?redeploy=1', {}],
    ['POST', '/branches/b/stop/', {}], ['POST', '/branches/b/deploy', {}],
    ['POST', '/branches/b/deploy/owned-init', {}], ['POST', '/branches/b/restart', {}],
    ['POST', '/branches/b/reset', {}], ['DELETE', '/branches/b', undefined],
    ['PUT', '/Branches/b/ExTrA-Services', { extraProfiles: [] }],
    ['POST', '/BrAnChEs/b/SToP/', {}], ['POST', '/BRANCHES/b/DePlOy', {}],
    ['POST', '/branches/b/DePlOy/owned-init', {}],
    ['POST', '/Branches/b/CoPy-CoNfIg-FrOm/other', {}],
    ['PUT', '/Branches/b/PrOfIlE-OvErRiDeS/owned-init', { env: {} }],
    ['DELETE', '/BrAnChEs/b', undefined],
    ['DELETE', '/projects/p', undefined], ['POST', '/import-config', { config: { buildProfiles: [] } }],
    ['POST', '/import-and-init', { config: { buildProfiles: [] } }],
  ])('returns finite 409 before mutation: %s %s', async (method, url, body) => {
    const before = graph(); const result = await request(method as string, url as string, body);
    expect(result.status).toBe(409); expect(result.body.error).toBe('acceptance_release_reconciliation_required');
    expect(result.raw).not.toMatch(/owned-secret|ownerHash|reference|fingerprint/);
    expect(graph()).toBe(before); expect(shell.commands).toEqual([]);
  });
  it('keeps reads/notes and another branch writable; project access precedes gate', async () => {
    expect((await request('PUT', '/branches/b/extra-services', { extraProfiles: [] }, 'foreign')).status).toBe(403);
    expect((await request('PUT', '/Branches/b/ExTrA-Services', { extraProfiles: [] }, 'foreign')).status).toBe(403);
    expect((await request('PUT', '/Branches/B/extra-services', { extraProfiles: [] })).status).toBe(404);
    expect((await request('GET', '/branches/b/extra-services')).status).toBe(200);
    expect((await request('PATCH', '/branches/b', { notes: 'safe metadata' })).status).toBe(200);
    expect((await request('PUT', '/branches/other/extra-services', { extraProfiles: [] })).status).toBe(200);
  });
  it('loads occupancy from persisted JSON, not an in-memory operation', async () => {
    await new Promise<void>(r => server.close(() => r())); await state.flush();
    state = new StateService(path.join(dir, 'state.json')); state.load(); await mount();
    const before = graph(); expect((await request('PUT', '/branches/b/extra-services', { extraProfiles: [] })).status).toBe(409);
    expect(graph()).toBe(before);
  });
  it.each(['prepared', 'stopped', 'removed', 'unknown'])('retains unfinished or unknown phase occupancy: %s', async phase => {
    (intents().releaseIntent as any).phase = phase;
    expect((await request('PUT', '/branches/b/extra-services', { extraProfiles: [] })).status).toBe(409);
  });
  it.each(['extras', 'override', 'clear-override', 'branch-delete', 'project-delete'])('State writer refuses %s before mutation', method => {
    const before = graph(), project = JSON.stringify(state.getProject('p'));
    const action = method === 'extras' ? () => state.setBranchExtraProfiles('b', []) :
      method === 'override' ? () => state.setBranchProfileOverride('b', profileId, { env: { PRIVATE: 'changed' } }) :
      method === 'clear-override' ? () => state.clearBranchProfileOverride('b', profileId) :
      method === 'branch-delete' ? () => state.removeBranch('b') : () => state.removeProject('p');
    expect(action).toThrow('acceptance_release_reconciliation_required'); expect(graph()).toBe(before);
    expect(JSON.stringify(state.getProject('p'))).toBe(project);
  });
  it('pending first intent publication blocks before canonical intent appears', async () => {
    const row = structuredClone(intents()); delete intents().releaseIntent;
    state.getState().acceptanceResourcePublications = { [id]: { draft: row, previous: structuredClone(intents()) } };
    expect((await request('PUT', '/branches/b/extra-services', { extraProfiles: [] })).status).toBe(409);
  });
  it('reading a source branch does not copy its temporary run-owned profile/override', async () => {
    const before = graph();
    expect((await request('POST', '/branches/other/copy-config-from/b', {})).status).toBe(200);
    expect(state.getBranch('other')!.extraProfiles || []).toEqual([]);
    expect(state.getBranch('other')!.profileOverrides?.[profileId]).toBeUndefined(); expect(graph()).toBe(before);
  });
  it('rollback is rejected before automatic snapshot or configuration changes', async () => {
    const snapshot = state.createConfigSnapshot({ trigger: 'manual', label: 'owned', projectId: 'p' });
    const before = graph(), count = state.getConfigSnapshots().length;
    expect((await request('POST', '/config-snapshots/' + snapshot.id + '/rollback', {})).status).toBe(409);
    expect(graph()).toBe(before); expect(state.getConfigSnapshots().length).toBe(count);
  });
  it('dry-run import remains a pure observation', async () => {
    expect((await request('POST', '/import-config', { config: { buildProfiles: [] }, dryRun: true })).status).toBe(200);
    expect(shell.commands).toEqual([]);
  });
  it.each(['clear', 'owner', 'reference', 'backward-phase'])('ordinary run writer cannot change persisted intent identity: %s', async change => {
    const before = structuredClone(intents()), next = structuredClone(before); next.seq++;
    if (change === 'clear') delete next.releaseIntent;
    if (change === 'owner') next.ownerHash = '6'.repeat(64);
    if (change === 'reference') (next.releaseIntent!.reference as any).id = '7'.repeat(64);
    if (change === 'backward-phase') next.releaseIntent!.phase = 'prepared';
    await expect(state.writeAcceptanceResourceRunDurably(next, before.seq, () => {}))
      .rejects.toThrow('acceptance_release_intent_changed');
    expect(intents()).toEqual(before);
  });
  it('an intent established while self-redeploy awaits prevents late rollback/override cleanup', async () => {
    const intent = structuredClone(intents().releaseIntent); delete intents().releaseIntent;
    const b = state.getBranch('b')!;
    b.extraProfiles!.push({ id: 'remove-other', projectId: 'p', name: 'other', dockerImage: 'owned:fixed', containerPort: 81 } as any);
    b.services['remove-other'] = { profileId: 'remove-other', containerName: 'other', hostPort: 10002, status: 'running' };
    b.profileOverrides!['remove-other'] = { notes: 'retain during later occupancy' };
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(r => entered = r), held = new Promise<void>(r => release = r);
    vi.stubGlobal('fetch', vi.fn(async () => { entered(); await held; return { ok: false, status: 409, text: async () => '{}' }; }));
    const writing = request('PUT', '/branches/b/extra-services?redeploy=1', { extraProfiles: [b.extraProfiles![0]] });
    await entry; intents().releaseIntent = intent;
    const before = graph(); release(); const result = await writing;
    expect(result.status).toBe(409); expect(result.body.error).toBe('acceptance_release_reconciliation_required');
    expect(graph()).toBe(before); expect(b.profileOverrides!['remove-other']).toBeTruthy();
    vi.unstubAllGlobals();
  });
  it('a defensive State rejection is converted to finite HTTP rather than an unhandled promise', async () => {
    delete intents().releaseIntent;
    vi.spyOn(state, 'setBranchExtraProfiles').mockImplementationOnce(() => { throw new Error('acceptance_release_reconciliation_required'); });
    expect((await request('PUT', '/branches/b/extra-services', { extraProfiles: [] })).status).toBe(409);
    expect((await request('GET', '/branches/b/extra-services')).status).toBe(200);
  });
  it('acknowledged release permits a legitimate successor configuration', async () => {
    intents().stage = 'released';
    state.getBranch('b')!.services[profileId].containerId = '9'.repeat(64);
    expect((await request('PUT', '/branches/b/extra-services', { extraProfiles: [] })).status).toBe(200);
  });
});
