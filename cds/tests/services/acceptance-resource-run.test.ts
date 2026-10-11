import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';

describe('P5-05 creation ownership and terminal receipt kernel', () => {
  let dir: string, file: string, state: StateService, ledger: AcceptanceResourceRunService;
  const sha = 'a'.repeat(40), container = 'b'.repeat(64);
  const input = { projectId: 'p1', branchId: 'b1', profileId: 'owned-bootstrap', targetSha: sha, isolationRunId: 'owned_run' };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acceptance-owner-')); file = path.join(dir, 'state.json');
    state = new StateService(file); state.load(); state.addProject({ id: 'p1', slug: 'p1', name: 'owned' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'owned/receipt', createdAt: '2026-10-10T00:00:00.000Z', worktreePath: dir, status: 'idle', services: {} });
    ledger = new AcceptanceResourceRunService(state, () => new Date('2026-10-11T00:00:00.000Z'));
  });
  afterEach(async () => { vi.restoreAllMocks(); await state.flush().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });

  async function registered() {
    const owner = await ledger.begin(input);
    const b = state.getBranch('b1')!;
    b.extraProfiles = [{ id: input.profileId, projectId: 'p1', env: { IMP_HEALTH_RUN_ID: input.isolationRunId, IMP_TARGET_SHA: sha, PRIVATE_VALUE: 'not-a-public-value' } } as any];
    b.services[input.profileId] = { profileId: input.profileId, containerId: container, containerName: 'owned-container', hostPort: 10000, status: 'running', deployedCommitSha: sha };
    state.addDeploymentRun({ id: 'dr_owned', projectId: 'p1', branchId: 'b1', commitSha: sha, status: 'running', startedAt: '2026-10-11T00:00:01.000Z', events: [], seq: 1 } as any);
    await ledger.register(owner.run.id, owner.ownerToken);
    return owner;
  }
  async function report(acceptanceRunId: string, overrides: Record<string, unknown> = {}) {
    return state.createAcceptanceReportAsync({ title: 'owned completion', format: 'md', content: 'owned real file report', projectId: 'p1', branchId: 'b1', commitSha: sha, acceptanceRunId, verdict: 'fail', ...overrides } as any);
  }
  async function reload() {
    await state.flush();
    const restored = new StateService(file); restored.load();
    // load may schedule migrations; finish that store's writes before deleting its owned directory.
    await restored.flush(); return restored;
  }

  it('persists before resource creation; public view and disk contain no owner capability', async () => {
    const owner = await ledger.begin(input);
    const reloaded = await reload();
    expect(new AcceptanceResourceRunService(reloaded).get(owner.run.id)).toEqual(owner.run);
    expect(JSON.stringify(ledger.get(owner.run.id))).not.toContain('ownerHash');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(owner.ownerToken);
    await expect(ledger.requireCleanupEvidence(owner.run.id, owner.ownerToken)).rejects.toThrow('terminal_receipt');
  });
  it.each(['profile', 'runtime'])('refuses to retroactively claim an existing %s', async kind => {
    const b = state.getBranch('b1')!;
    if (kind === 'profile') b.extraProfiles = [{ id: input.profileId } as any];
    else b.services[input.profileId] = {} as any;
    await expect(ledger.begin(input)).rejects.toThrow('already_exists');
    expect(state.getState().acceptanceResourceRuns).toBeUndefined();
  });
  it('rejects wrong scope and short SHA', async () => {
    await expect(ledger.begin({ ...input, projectId: 'foreign' })).rejects.toThrow('scope_mismatch');
    await expect(ledger.begin({ ...input, targetSha: 'aaaaaaa' })).rejects.toThrow('scope_invalid');
  });
  it('counts an invisible in-flight owner and rejects the second allocation', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = state.flush.bind(state); vi.spyOn(state, 'flush').mockImplementationOnce(async () => { await gate; await original(); });
    const first = ledger.begin(input);
    let before: unknown, rejected: unknown;
    try {
      before = state.getState().acceptanceResourceRuns;
      try { await ledger.begin(input); } catch (error) { rejected = error; }
    } finally { release(); }
    expect((await first).run.stage).toBe('active');
    expect(before).toBeUndefined(); expect((rejected as Error)?.message).toContain('resource_owned');
  });
  it('does not accept strangers or deployment completion as an acceptance terminal', async () => {
    const owner = await registered();
    await expect(ledger.finish(owner.run.id, 'c'.repeat(64), 'any')).rejects.toThrow('owner_required');
    await expect(ledger.requireCleanupEvidence(owner.run.id, owner.ownerToken)).rejects.toThrow('terminal_receipt');
    expect(ledger.get(owner.run.id)?.stage).toBe('registered');
  });
  it.each(['containerId', 'sha', 'env', 'deployment'])('refuses unconfirmed actual resource %s', async field => {
    const owner = await registered();
    const b = state.getBranch('b1')!;
    if (field === 'containerId') delete b.services[input.profileId].containerId;
    if (field === 'sha') b.services[input.profileId].deployedCommitSha = 'c'.repeat(40);
    if (field === 'env') b.extraProfiles![0].env!.IMP_HEALTH_RUN_ID = 'foreign_run';
    if (field === 'deployment') state.getDeploymentRun('dr_owned')!.status = 'verifying';
    const meta = await report(owner.run.id);
    await expect(ledger.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow('resource_unconfirmed');
  });
  it.each([
    { acceptanceRunId: 'foreign_run' }, { projectId: 'foreign' }, { branchId: 'foreign' }, { commitSha: 'c'.repeat(40) }, { verdict: null },
  ])('rejects unbound report %j', async override => {
    const owner = await registered(); const meta = await report(owner.run.id, override);
    await expect(ledger.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow('report_mismatch');
    expect(ledger.get(owner.run.id)?.terminal).toBeUndefined();
  });
  it('requires readable archived body, rather than metadata existence', async () => {
    const owner = await registered(); const meta = await report(owner.run.id);
    fs.unlinkSync(path.join(state.getReportsBase(), meta.id + '.md'));
    await expect(ledger.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow('report_unreadable');
  });
  it('persists an exact receipt; failed acceptance may be terminal but never becomes pass', async () => {
    const owner = await registered(); const meta = await report(owner.run.id);
    await ledger.finish(owner.run.id, owner.ownerToken, meta.id);
    const restored = await reload(); const service = new AcceptanceResourceRunService(restored);
    const evidence = await service.requireCleanupEvidence(owner.run.id, owner.ownerToken);
    expect(evidence.terminal?.verdict).toBe('fail'); expect(evidence.stage).toBe('finished');
    expect(evidence.daemonVerificationRequired).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('not-a-public-value'); expect(JSON.stringify(evidence)).not.toContain('ownerHash');
    expect(restored.getBranch('b1')?.extraProfiles).toHaveLength(1);
  });
  it('does not expose terminal success during the durable barrier or lose another entity write', async () => {
    const owner = await registered(); const meta = await report(owner.run.id);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
    const original = state.flush.bind(state); vi.spyOn(state, 'flush').mockImplementationOnce(async () => { entered(); await gate; await original(); });
    const finishing = ledger.finish(owner.run.id, owner.ownerToken, meta.id);
    let before: string | undefined, rejected: unknown;
    try {
      await began; before = ledger.get(owner.run.id)?.stage;
      try { await ledger.finish(owner.run.id, owner.ownerToken, meta.id); } catch (error) { rejected = error; }
      state.getBranch('b1')!.errorMessage = 'other entity changed'; state.save();
    } finally { release(); }
    await finishing;
    expect(before).toBe('registered'); expect((rejected as Error)?.message).toContain('run_busy');
    const restored = await reload();
    expect(new AcceptanceResourceRunService(restored).get(owner.run.id)?.stage).toBe('finished');
    expect(restored.getBranch('b1')?.errorMessage).toBe('other entity changed');
  });
  it('retains the registered row after a real state file write failure', async () => {
    const owner = await registered(); const meta = await report(owner.run.id); await state.flush();
    fs.unlinkSync(file); fs.mkdirSync(file);
    try { await expect(ledger.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow(); }
    finally { fs.rmdirSync(file); }
    expect(ledger.get(owner.run.id)?.stage).toBe('registered'); state.save(); await state.flush();
    const restored = await reload();
    expect(new AcceptanceResourceRunService(restored).get(owner.run.id)?.stage).toBe('registered');
  });
  it('refuses branch replacement during report IO before publishing terminal', async () => {
    const owner = await registered(); const meta = await report(owner.run.id);
    const read = state.readAcceptanceReportContentAsync.bind(state);
    vi.spyOn(state, 'readAcceptanceReportContentAsync').mockImplementationOnce(async id => {
      const text = await read(id); state.getBranch('b1')!.createdAt = '2026-10-11T03:00:00.000Z'; return text;
    });
    await expect(ledger.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow('branch_changed');
    expect(state.getState().acceptanceResourceRuns?.[owner.run.id].stage).toBe('registered');
  });
  it.each(['body', 'meta', 'container', 'config'])('invalidates a terminal receipt on later %s drift', async field => {
    const owner = await registered(); const meta = await report(owner.run.id); await ledger.finish(owner.run.id, owner.ownerToken, meta.id);
    if (field === 'body') fs.writeFileSync(path.join(state.getReportsBase(), meta.id + '.md'), 'later overwritten body');
    if (field === 'meta') state.getAcceptanceReport(meta.id)!.title = 'changed';
    if (field === 'container') state.getBranch('b1')!.services[input.profileId].containerId = 'd'.repeat(64);
    if (field === 'config') state.getBranch('b1')!.extraProfiles![0].env!.PRIVATE_VALUE = 'changed secret';
    await expect(ledger.requireCleanupEvidence(owner.run.id, owner.ownerToken)).rejects.toThrow(/(report|resource)_changed/);
  });
  it('rejects at the fixed capacity without dropping unfinished ownership records', async () => {
    const owner = await ledger.begin(input); const row = state.getState().acceptanceResourceRuns![owner.run.id];
    const table = state.getState().acceptanceResourceRuns!;
    for (let i = 1; i < 512; i++) table['ar_' + i] = { ...structuredClone(row), id: 'ar_' + i, branchId: 'other_' + i };
    await expect(ledger.begin({ ...input, profileId: 'other-bootstrap' })).rejects.toThrow('run_capacity');
    expect(Object.keys(table)).toHaveLength(512); expect(table[owner.run.id].stage).toBe('active');
  });
  it('keeps the real read permit after an observer timeout and refuses duplicate IO across service instances', async () => {
    const owner = await registered(); const meta = await report(owner.run.id);
    let release!: (content: string) => void; const pending = new Promise<string>(resolve => { release = resolve; });
    const read = vi.spyOn(state, 'readAcceptanceReportContentAsync').mockReturnValueOnce(pending);
    const bounded = new AcceptanceResourceRunService(state, () => new Date(), 50);
    try {
      await expect(bounded.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow('report_timeout');
      expect(ledger.get(owner.run.id)?.stage).toBe('registered');
      await expect(ledger.finish(owner.run.id, owner.ownerToken, meta.id)).rejects.toThrow('report_pending');
      expect(read).toHaveBeenCalledTimes(1);
    } finally { release('late real body'); await pending; }
    await Promise.resolve();
    expect(ledger.get(owner.run.id)?.stage).toBe('registered');
    await ledger.finish(owner.run.id, owner.ownerToken, meta.id);
    expect(ledger.get(owner.run.id)?.stage).toBe('finished'); expect(read).toHaveBeenCalledTimes(2);
  });
  it('caps shared operation and unfinished read counts at eight without queuing a ninth', async () => {
    const owners: Array<{ id: string; token: string; reportId: string }> = [];
    for (let i = 0; i < 9; i++) {
      const branchId = 'owned_' + i;
      state.addBranch({ id: branchId, projectId: 'p1', branch: branchId, createdAt: '2026-10-10T00:00:00.000Z', worktreePath: dir, status: 'idle', services: {} });
      const owner = await ledger.begin({ ...input, branchId }); const b = state.getBranch(branchId)!;
      b.extraProfiles = [{ id: input.profileId, projectId: 'p1', env: { IMP_HEALTH_RUN_ID: input.isolationRunId, IMP_TARGET_SHA: sha } } as any];
      b.services[input.profileId] = { profileId: input.profileId, containerId: i.toString(16).padStart(64, '0'), containerName: branchId, hostPort: 10000 + i, status: 'running', deployedCommitSha: sha };
      state.addDeploymentRun({ id: 'dr_' + i, projectId: 'p1', branchId, commitSha: sha, status: 'running', startedAt: '2026-10-11T00:00:01.000Z', events: [], seq: 1 } as any);
      await ledger.register(owner.run.id, owner.ownerToken);
      const meta = await report(owner.run.id, { branchId });
      owners.push({ id: owner.run.id, token: owner.ownerToken, reportId: meta.id });
    }
    let release!: (text: string) => void; const pending = new Promise<string>(resolve => { release = resolve; });
    const read = vi.spyOn(state, 'readAcceptanceReportContentAsync').mockReturnValue(pending);
    const bounded = new AcceptanceResourceRunService(state, () => new Date(), 100);
    const attempts = owners.slice(0, 8).map(o => bounded.finish(o.id, o.token, o.reportId).catch(e => e as Error));
    try {
      await Promise.resolve();
      const ninth = owners[8];
      await expect(ledger.finish(ninth.id, ninth.token, ninth.reportId)).rejects.toThrow('operation_capacity');
      const outcomes = await Promise.all(attempts);
      expect(outcomes.every(outcome => outcome instanceof Error && outcome.message.includes('report_timeout'))).toBe(true);
      expect(read).toHaveBeenCalledTimes(8);
      await expect(ledger.finish(ninth.id, ninth.token, ninth.reportId)).rejects.toThrow('report_capacity');
      expect(read).toHaveBeenCalledTimes(8);
    } finally { release('late body'); await pending; await Promise.all(attempts); }
    expect(owners.every(o => ledger.get(o.id)?.stage === 'registered')).toBe(true);
  });
});
