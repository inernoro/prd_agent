import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';

describe('guide2.94 dedicated resource release publication (no Daemon evidence)', () => {
  let dir: string, file: string, state: StateService, id: string;
  const profileId = 'owned-bootstrap', sha = 'a'.repeat(40), containerId = 'b'.repeat(64);
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-own-release-publication-'));
    file = path.join(dir, 'state.json'); state = new StateService(file); state.load();
    state.addProject({ id: 'p', slug: 'p', name: 'owned' } as any);
    state.addBranch({ id: 'b', projectId: 'p', branch: 'owned', createdAt: '2026-10-11T00:00:00Z',
      worktreePath: dir, status: 'running', services: {} });
    const kernel = new AcceptanceResourceRunService(state, () => new Date('2026-10-11T00:01:00Z'));
    const owner = await kernel.begin({ projectId: 'p', branchId: 'b', profileId, targetSha: sha, isolationRunId: 'owned_run' });
    id = owner.run.id; const branch = state.getBranch('b')!;
    branch.extraProfiles = [{ id: profileId, projectId: 'p', env: { IMP_HEALTH_RUN_ID: 'owned_run', IMP_TARGET_SHA: sha } },
      { id: 'keep', projectId: 'p' }] as any;
    branch.profileOverrides = { [profileId]: { activeDeployMode: 'express' }, keep: { activeDeployMode: 'source' } };
    branch.services[profileId] = { profileId, containerId, containerName: 'owned-bootstrap', hostPort: 10001,
      status: 'running', deployedCommitSha: sha, deployedImage: 'sha256:' + 'c'.repeat(64) };
    branch.services.keep = { profileId: 'keep', containerName: 'keep', hostPort: 10002, status: 'running' };
    state.addBranch({ id: 'other', projectId: 'p', branch: 'other', status: 'idle', createdAt: '2026-10-11', worktreePath: dir, services: {} });
    state.addDeploymentRun({ id: 'dr_owned', projectId: 'p', branchId: 'b', commitSha: sha, status: 'running',
      startedAt: '2026-10-11T00:02:00Z', events: [], seq: 1 } as any);
    await kernel.register(id, owner.ownerToken);
    const report = await state.createAcceptanceReportAsync({ title: 'owned', format: 'md', content: 'real owned report',
      projectId: 'p', branchId: 'b', commitSha: sha, acceptanceRunId: id, verdict: 'fail' });
    await kernel.finish(id, owner.ownerToken, report.id);
    // A controlled previously-confirmed intent fixture isolates persistence from future stop/rm orchestration.
    const previous = state.getState().acceptanceResourceRuns![id];
    const identity = [profileId, containerId, 'owned-bootstrap', 10001, sha, 'sha256:' + 'c'.repeat(64)];
    const intent = { version: 1, phase: 'removed', startedAt: '2026-10-11T00:03:00Z',
      serviceDigest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      reference: { id: containerId, name: 'owned-bootstrap', image: 'sha256:' + 'c'.repeat(64),
        owner: { projectId: 'p', branchId: 'b', profileId }, wasRunning: true, writableMounts: [],
        fingerprint: 'sha256:' + 'd'.repeat(64) } };
    await state.writeAcceptanceResourceRunDurably({ ...previous, seq: previous.seq + 1, releaseIntent: intent } as any,
      previous.seq, () => {});
  });
  afterEach(async () => { vi.restoreAllMocks(); await state.flush().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const current = () => state.getState().acceptanceResourceRuns![id];
  const released = () => ({ ...structuredClone(current()), seq: current().seq + 1, stage: 'released' as const });
  async function publish(row = released(), fence = () => {}, afterFlush?: () => Promise<void>) {
    // Explicit feature-absence adapter: old State has no dedicated transaction; not a live HTTP defect.
    const fn = (state as any).writeAcceptanceResourceReleaseDurably;
    expect(fn).toBeTypeOf('function');
    return fn.call(state, row, current().seq, fence, afterFlush);
  }
  async function reload() {
    const restored = new StateService(file); restored.load(); await restored.flush(); return restored;
  }
  function present(s = state) {
    expect(s.getBranch('b')!.extraProfiles!.some(p => p.id === profileId)).toBe(true);
    expect(s.getBranch('b')!.services[profileId]).toBeTruthy();
    expect(s.getBranch('b')!.profileOverrides![profileId]).toBeTruthy();
  }
  function removed(s = state) {
    expect(s.getBranch('b')!.extraProfiles!.some(p => p.id === profileId)).toBe(false);
    expect(s.getBranch('b')!.services[profileId]).toBeUndefined();
    expect(s.getBranch('b')!.profileOverrides![profileId]).toBeUndefined();
    expect(s.getBranch('b')!.extraProfiles!.some(p => p.id === 'keep')).toBe(true);
    expect(s.getBranch('b')!.services.keep.status).toBe('running');
    expect(s.getBranch('b')!.profileOverrides!.keep.activeDeployMode).toBe('source');
  }
  it('rejects a plain run writer publishing released without atomic graph deletion', async () => {
    await expect(state.writeAcceptanceResourceRunDurably(released(), current().seq, () => {}))
      .rejects.toThrow('acceptance_release_transaction_required');
    present(); expect(current().stage).toBe('finished');
  });
  it('publishes only the owned three entries and released in one durable snapshot', async () => {
    const observations: string[] = [];
    state.onSave(() => observations.push(current().stage + ':' + Boolean(state.getBranch('b')!.services[profileId])));
    await publish(); removed(); expect(current().stage).toBe('released');
    expect(observations).not.toContain('released:true');
    expect(observations).not.toContain('finished:false');
    const loaded = await reload(); removed(loaded);
    expect(loaded.getState().acceptanceResourceRuns![id].stage).toBe('released');
    expect(loaded.getBranch('other')!.status).toBe('idle');
  });
  it.each([1, 2])('keeps public state until barrier %i acknowledges and preserves concurrent fields', async barrier => {
    expect((state as any).writeAcceptanceResourceReleaseDurably).toBeTypeOf('function');
    const original = state.flush.bind(state); let call = 0, enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => enter = r); const held = new Promise<void>(r => release = r);
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      await original(); if (++call === barrier) { enter(); await held; }
    });
    const publication = publish();
    try {
      await entered; present(); expect(current().stage).toBe('finished');
      state.getBranch('b')!.errorMessage = 'same-branch field retained';
      state.getBranch('b')!.extraProfiles!.push({ id: 'new-extra', projectId: 'p' } as any);
      state.getBranch('other')!.errorMessage = 'other branch retained';
      state.save([{ kind: 'branches', id: 'b' }, { kind: 'branches', id: 'other' }]); await original();
      const loaded = await reload();
      if (barrier === 1) { present(loaded); expect(loaded.getState().acceptanceResourceRuns![id].stage).toBe('finished');
        expect(loaded.getState().acceptanceResourcePublications![id].draft.stage).toBe('released'); }
      else { removed(loaded); expect(loaded.getState().acceptanceResourceRuns![id].stage).toBe('released'); }
    } finally { release(); }
    await publication; removed();
    const loaded = await reload(); removed(loaded);
    expect(loaded.getBranch('b')!.extraProfiles!.some(p => p.id === 'new-extra')).toBe(true);
    expect(loaded.getBranch('b')!.errorMessage).toBe('same-branch field retained');
    expect(loaded.getBranch('other')!.errorMessage).toBe('other branch retained');
  });
  it.each([1, 2])('a barrier %i failure retains the previously persisted intent and original graph', async barrier => {
    const original = state.flush.bind(state); let call = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      if (++call === barrier) throw new Error('owned_disk_failure'); await original();
    });
    await expect(publish()).rejects.toThrow('owned_disk_failure');
    present(); expect(current().stage).toBe('finished');
    const loaded = await reload(); present(loaded);
    expect((loaded.getState().acceptanceResourceRuns![id] as any).releaseIntent.phase).toBe('removed');
    expect(loaded.getState().acceptanceResourcePublications?.[id]).toBeUndefined();
  });
  it.each([1, 2])('a real EISDIR at barrier %i cannot erase the persisted removed intent', async barrier => {
    const original = state.flush.bind(state); let call = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      if (++call !== barrier) return original();
      const backup = file + '.owned-before-failure'; fs.renameSync(file, backup); fs.mkdirSync(file);
      try { await original(); }
      finally { fs.rmdirSync(file); fs.renameSync(backup, file); }
    });
    await expect(publish()).rejects.toThrow(); present(); expect(current().stage).toBe('finished');
    const loaded = await reload(); present(loaded);
    expect((loaded.getState().acceptanceResourceRuns![id] as any).releaseIntent.phase).toBe('removed');
    expect(loaded.getState().acceptanceResourceRuns![id].stage).toBe('finished');
  });
  it('every committed snapshot carries the directed branch patch and complete split-store hints', async () => {
    const store = (state as any).backingStore;
    const original = store.save.bind(store);
    const snapshots: { released: boolean; present: boolean; hints: unknown[] }[] = [];
    vi.spyOn(store, 'save').mockImplementation((snapshot: any, hints: any) => {
      snapshots.push({ released: snapshot.acceptanceResourceRuns[id].stage === 'released',
        present: Boolean(snapshot.branches.b.services[profileId]), hints: hints || [] });
      return original(snapshot, hints);
    });
    await publish();
    expect(snapshots.some(v => v.released)).toBe(true);
    for (const snapshot of snapshots.filter(v => v.released)) {
      expect(snapshot.present).toBe(false);
      expect(snapshot.hints).toContainEqual({ kind: 'global' });
      expect(snapshot.hints).toContainEqual({ kind: 'branches', id: 'b' });
    }
  });
  it('a post-ACK target drift retracts the draft without overwriting the changed service', async () => {
    const branch = state.getBranch('b')!; const old = branch.services[profileId].containerId;
    const fence = () => { if (branch.services[profileId].containerId !== old) throw new Error('owned_target_drift'); };
    await expect(publish(released(), fence, async () => {
      branch.services[profileId].containerId = 'e'.repeat(64); state.save(); await state.flush();
    })).rejects.toThrow('owned_target_drift');
    present(); expect(branch.services[profileId].containerId).toBe('e'.repeat(64));
    const loaded = await reload(); present(loaded);
    expect(loaded.getBranch('b')!.services[profileId].containerId).toBe('e'.repeat(64));
    expect(loaded.getState().acceptanceResourceRuns![id].stage).toBe('finished');
    expect((loaded.getState().acceptanceResourceRuns![id] as any).releaseIntent.phase).toBe('removed');
  });
  it('freezes the input row before asynchronous IO', async () => {
    const row = released() as any;
    await publish(row, () => {}, async () => { row.id = 'ar_' + 'e'.repeat(32); row.profileId = 'keep'; row.terminal.bodyDigest = 'f'.repeat(64); });
    removed(); expect(current().stage).toBe('released');
    expect(state.getState().acceptanceResourceRuns![row.id]).toBeUndefined();
  });
  it('refuses an in-place canonical seq mutation during ACK and retains the newer row', async () => {
    const oldSeq = current().seq;
    await expect(publish(released(), () => {}, async () => { current().seq += 10; state.save(); await state.flush(); }))
      .rejects.toThrow('acceptance_run_conflict');
    present(); expect(current().stage).toBe('finished'); expect(current().seq).toBe(oldSeq + 10);
    const loaded = await reload(); present(loaded);
    expect(loaded.getState().acceptanceResourceRuns![id].seq).toBe(oldSeq + 10);
  });
  it.each(['intent', 'phase', 'container', 'config', 'terminal', 'owner', 'seq'] as const)
  ('rejects a released draft with changed %s before deleting any entry', async field => {
    const row = released() as any;
    if (field === 'intent') delete row.releaseIntent;
    if (field === 'phase') row.releaseIntent.phase = 'prepared';
    if (field === 'container') row.resource.containerId = 'e'.repeat(64);
    if (field === 'config') state.getBranch('b')!.profileOverrides![profileId].activeDeployMode = 'source';
    if (field === 'terminal') row.terminal.bodyDigest = 'e'.repeat(64);
    if (field === 'owner') row.ownerHash = 'e'.repeat(64);
    if (field === 'seq') row.seq++;
    await expect(publish(row)).rejects.toThrow('acceptance_release'); present();
  });
});
