import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { CandidateJournal } from '../../src/services/service-candidate-journal.js';
import { createCandidateRuntime } from '../../src/services/service-candidate.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
const sha = 'a'.repeat(40);
let dir: string; let state: StateService; let runId: string; let branch: BranchEntry;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-candidate-journal-')); state = new StateService(path.join(dir, 'state.json')); state.load();
  state.addProject({ id: 'project', slug: 'project', name: 'project' } as any);
  branch = { id: 'branch', branch: 'test', projectId: 'project', githubCommitSha: sha, status: 'running', createdAt: '2026-10-11', worktreePath: '/unused',
    services: { api: { profileId: 'api', containerName: 'old', hostPort: 10001, status: 'running', buildLog: 'secret-log', deployedImage: 'old' } } };
  state.addBranch(branch);
  const run = await new DeploymentRunService(state).begin({ projectId: 'project', branchId: 'branch', trigger: 'manual',
    commitSha: sha, operationId: 'op-test', configHash: 'config-frozen' }); runId = run.id;
});
afterEach(async () => { vi.restoreAllMocks(); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
const candidate = (port = 10002) => createCandidateRuntime(branch, [{ id: 'api' } as BuildProfile], 'op-test', () => port);
describe('P3 durable private candidate reservations', () => {
  it('keeps the canonical phase at its durable value and rejects a competing advance while flushing', async () => {
    const journal = new CandidateJournal(state); const graph = candidate();
    await journal.prepare(runId, graph);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.spyOn(state, 'flush').mockImplementationOnce(() => gate);
    const pending = journal.advance(runId, 'prepared', 'starting', graph);
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('prepared');
      await expect(journal.advance(runId, 'prepared', 'reconciling')).rejects.toThrow();
    } finally { release(); await pending; flush.mockRestore(); }
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('starting');
  });
  it('does not publish a phase whose frozen configuration changed while the write was pending', async () => {
    const journal = new CandidateJournal(state); const graph = candidate();
    await journal.prepare(runId, graph);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.spyOn(state, 'flush').mockImplementationOnce(() => gate);
    const pending = journal.advance(runId, 'prepared', 'starting', graph);
    const rejected = expect(pending).rejects.toThrow('candidate_journal_phase');
    await new Promise(resolve => setImmediate(resolve)); state.getDeploymentRun(runId)!.configHash = 'new-owner-config';
    release(); await rejected; flush.mockRestore(); await state.flush();
    expect(state.getDeploymentRun(runId)!.configHash).toBe('new-owner-config');
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('prepared');
    const restored = new StateService(path.join(dir, 'state.json')); restored.load();
    expect(restored.getDeploymentRun(runId)!.candidate!.phase).toBe('prepared');
  });

  it('cannot lose a real disk error to a competing onSave flush observer', async () => {
    const file = path.join(dir, 'state.json'); fs.unlinkSync(file); fs.mkdirSync(file);
    let observed: Promise<string> | undefined;
    state.onSave(() => { observed = state.flush().then(() => 'resolved', () => 'rejected'); });
    try {
      await expect(new CandidateJournal(state).prepare(runId, candidate())).rejects.toThrow();
      expect(await observed).toBe('rejected');
    } finally {
      fs.rmdirSync(file); state.save(); await state.flush(); await observed;
    }
  });
  it('rejects unknown run states before recording candidate identities', async () => {
    state.getDeploymentRun(runId)!.status = 'unknown' as any;
    await expect(new CandidateJournal(state).prepare(runId, candidate())).rejects.toThrow('candidate_journal_owner');
    expect(state.getDeploymentRun(runId)!.candidate).toBeUndefined();
  });
  it('persists both identities before returning without replacing live services or storing logs/config', async () => {
    const graph = candidate(); (graph.services.api as any).env = { token: 'private' };
    await new CandidateJournal(state).prepare(runId, graph);
    const reloaded = new StateService(path.join(dir, 'state.json')); reloaded.load();
    const record = reloaded.getDeploymentRun(runId)!.candidate!;
    expect(record.phase).toBe('prepared'); expect(record.services.api.containerName).toBe(graph.services.api.containerName);
    expect(record.serving.api.containerName).toBe('old'); expect(reloaded.getBranch('branch')!.services.api.containerName).toBe('old');
    expect(JSON.stringify(record)).not.toContain('private'); expect(JSON.stringify(record)).not.toContain('secret-log');
    graph.services.api.hostPort = 10010; expect(record.services.api.hostPort).toBe(10002);
  });
  it('does not permit creation to proceed before the durability barrier, and propagates flush failure', async () => {
    let release!: () => void; const blocker = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(state, 'flush').mockImplementation(() => blocker);
    let returned = false; const pending = new CandidateJournal(state).prepare(runId, candidate()).then(() => { returned = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(returned).toBe(false); release(); await pending; expect(returned).toBe(true);
    state.getDeploymentRun(runId)!.candidate = undefined;
    vi.mocked(state.flush).mockRejectedValueOnce(new Error('disk-unavailable'));
    await expect(new CandidateJournal(state).prepare(runId, candidate())).rejects.toThrow('disk-unavailable');
  });
  it('retains reservations for failed runs across reload and rejects a second candidate collision', async () => {
    await new CandidateJournal(state).prepare(runId, candidate());
    state.updateDeploymentRun(runId, run => { run.status = 'failed'; });
    await state.flush();
    const restored = new StateService(path.join(dir, 'state.json')); restored.load();
    expect(restored.allocatePort(10002)).not.toBe(10002);
    const second = await new DeploymentRunService(restored).begin({ projectId: 'project', branchId: 'branch', trigger: 'manual',
      commitSha: sha, operationId: 'op-next', configHash: 'config-frozen' });
    const graph = createCandidateRuntime(branch, [{ id: 'api' } as BuildProfile], 'op-next', () => 10002);
    await expect(new CandidateJournal(restored).prepare(second.id, graph)).rejects.toThrow('candidate_journal_identity');
  });
  it('rejects target drift and another run identity before persisting a candidate', async () => {
    const graph = candidate(); graph.deploymentTargetSha = 'b'.repeat(40);
    await expect(new CandidateJournal(state).prepare(runId, graph)).rejects.toThrow('candidate_journal_target');
    const foreign = createCandidateRuntime(branch, [{ id: 'api' } as BuildProfile], 'op-foreign', () => 10002);
    await expect(new CandidateJournal(state).prepare(runId, foreign)).rejects.toThrow('candidate_journal_identity');
    expect(state.getDeploymentRun(runId)!.candidate).toBeUndefined();
  });
  it('cannot skip phases or claim readiness without the complete exact runtime graph', async () => {
    const journal = new CandidateJournal(state); const graph = candidate();
    await journal.prepare(runId, graph);
    await expect(journal.advance(runId, 'prepared', 'released')).rejects.toThrow('candidate_journal_phase');
    await journal.advance(runId, 'prepared', 'starting', graph);
    await expect(journal.advance(runId, 'starting', 'ready')).rejects.toThrow('candidate_ready');
    await expect(journal.advance(runId, 'starting', 'ready', graph)).rejects.toThrow('candidate_ready');
    Object.assign(graph.services.api, { status: 'running', deployedPrebuilt: true, deployedCommitSha: sha, deployedImage: 'image:sha-' + sha });
    await journal.advance(runId, 'starting', 'ready', graph);
    expect(state.getDeploymentRun(runId)!.candidate!.services.api.deployedImage).toBe('image:sha-' + sha);
    graph.services.api.deployedImage = 'mutated';
    expect(state.getDeploymentRun(runId)!.candidate!.services.api.deployedImage).toBe('image:sha-' + sha);
  });
  it('rejects configuration drift during phase updates without releasing reservations', async () => {
    const journal = new CandidateJournal(state); await journal.prepare(runId, candidate());
    state.getDeploymentRun(runId)!.configHash = 'changed';
    await expect(journal.advance(runId, 'prepared', 'starting', candidate())).rejects.toThrow('candidate_journal_phase');
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('prepared');
  });
  it('does not prune or explicitly discard a terminal run whose candidates remain unresolved', async () => {
    await new CandidateJournal(state).prepare(runId, candidate());
    state.updateDeploymentRun(runId, run => { run.status = 'failed'; }); await state.flush();
    expect(() => state.removeDeploymentRunsForBranch('branch')).toThrow('candidate_reconciliation_required');
    // Newer terminal runs can be pruned; the oldest failed candidate ledger must survive the cap.
    for (let i = 0; i < 51; i++) {
      const run = await new DeploymentRunService(state, { idFactory: () => 'dr_next_' + i }).begin({ projectId: 'project', branchId: 'branch', trigger: 'manual' });
      state.updateDeploymentRun(run.id, current => { current.status = 'failed'; }); await state.flush();
    }
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('prepared');
    expect(state.getDeploymentRuns().length).toBeLessThanOrEqual(50);
    const restored = new StateService(path.join(dir, 'state.json')); restored.load();
    expect(restored.getDeploymentRun(runId)!.candidate!.services.api.hostPort).toBe(10002);
  });
});
