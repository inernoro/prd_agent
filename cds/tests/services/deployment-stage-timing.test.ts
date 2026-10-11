import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { summarizeDeploymentTiming } from '../../src/services/deployment-stage-timing.js';

describe('actual run stage timing facts', () => {
  let root: string, state: StateService, service: DeploymentRunService, mono: number, wall: number, current: boolean;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-stage-')); state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'b', projectId: 'default', branch: 'main', worktreePath: root, services: {}, status: 'idle', createdAt: new Date().toISOString() } as any);
    mono = 100; wall = Date.parse('2026-10-11T01:00:00Z'); current = true;
    service = new DeploymentRunService(state, { now: () => new Date(wall), timingClock: () => mono, maxEvents: 2 });
    await service.begin({ projectId: 'default', branchId: 'b', trigger: 'manual', operationId: 'op_own', commitSha: 'a'.repeat(40) });
  });
  afterEach(async () => { await state.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  function run() { return service.list()[0]; }
  function observer() { return service.createTimingObserver(run().id, 'op_own', () => current); }
  it('measures parallel observed wall intervals by union, preserving separate work duration', () => {
    const t = observer(); const a = t.begin('startup', 'prebuilt-start', 'a'); mono = 200; const b = t.begin('startup', 'prebuilt-start', 'b');
    mono = 400; a('completed'); mono = 500; b('completed');
    const summary = summarizeDeploymentTiming(run().timing);
    expect(summary.stages.startup).toMatchObject({ status: 'observed', completedWallMs: 400, workMs: 600, open: 0, unknown: 0 });
    expect(summary.stages['ci-runner']).toMatchObject({ status: 'not-observed', completedWallMs: null, workMs: null });
    expect(summary.stages['ci-build'].completedWallMs).toBeNull();
  });
  it('uses monotonic measurement when the wall clock moves backwards, not zero or negative inferred time', () => {
    const finish = observer().begin('pull', 'git-pull'); mono += 150; wall -= 60000; finish('completed');
    expect(run().timing!.intervals[0].durationMs).toBe(150);
    expect(summarizeDeploymentTiming(run().timing).stages.pull.completedWallMs).toBe(150);
  });
  it('retains facts outside trimmed log history and reloads actual StateJSON', async () => {
    const finish = observer().begin('artifact', 'exact-artifact'); mono += 27; finish('failed');
    for (let i = 0; i < 8; i++) service.append(run().id, { phase: 'log', level: 'info', status: 'preparing', message: 'noise' });
    expect(run().events).toHaveLength(2); await state.flush();
    const reload = new StateService(path.join(root, 'state.json')); reload.load();
    expect(reload.getDeploymentRun(run().id)?.timing?.intervals[0]).toMatchObject({ stage: 'artifact', outcome: 'failed', durationMs: 27, commitShaAtStart: 'a'.repeat(40) });
  });
  it('records work failure without replacing its exception or leaking arbitrary command/env strings', async () => {
    const error = Error('PRIVATE_COMMAND_TOKEN');
    await expect(observer().measure('artifact', 'exact-artifact', null, async () => { mono += 9; throw error; })).rejects.toBe(error);
    expect(run().timing!.intervals[0]).toMatchObject({ outcome: 'failed', durationMs: 9 });
    expect(summarizeDeploymentTiming(run().timing).stages.artifact).toMatchObject({ status: 'observed', completed: 0, failed: 1, cancelled: 0 });
    expect(JSON.stringify(run().timing)).not.toContain('PRIVATE_COMMAND_TOKEN');
  });
  it('closes its own interval across the existing durable draft publication without stale object references', async () => {
    const finish = observer().begin('startup', 'prebuilt-start', 'api');
    await state.updateDeploymentRunDurably(run().id, draft => { draft.phase = 'candidate-created'; }, () => state.flush(), () => {});
    mono += 33; finish('completed');
    expect(run().timing!.intervals[0]).toMatchObject({ outcome: 'completed', durationMs: 33 });
  });
  it('does not write after cancellation or successor run object/op replacement', () => {
    const finish = observer().begin('pull', 'git-pull'); current = false; mono += 10; finish('completed');
    expect(run().timing!.intervals[0].outcome).toBe('open');
    current = true; service.cancel(run().id, 'cancelled');
    expect(run().timing!.intervals[0]).toMatchObject({ outcome: 'unknown', durationMs: null });
    const before = JSON.stringify(run()); finish('completed'); expect(JSON.stringify(run())).toBe(before);
  });
  it('does not adopt changed start facts under a retained interval id', async () => {
    const finish = observer().begin('startup', 'prebuilt-start', 'api');
    await state.updateDeploymentRunDurably(run().id, draft => { draft.timing!.intervals[0].profileId = 'worker'; }, () => state.flush(), () => {});
    const before = JSON.stringify(run()); mono += 33; finish('completed'); expect(JSON.stringify(run())).toBe(before);
  });
  it('does not close ambiguous duplicated interval ids', () => {
    const finish = observer().begin('startup', 'prebuilt-start', 'api');
    run().timing!.intervals.push(structuredClone(run().timing!.intervals[0]));
    const before = JSON.stringify(run()); mono += 33; finish('completed'); expect(JSON.stringify(run())).toBe(before);
  });
  it('does not write timing into a moved run scope even if the lease reader is still current', () => {
    const finish = observer().begin('pull', 'git-pull'); run().projectId = 'foreign';
    const before = JSON.stringify(run()); mono += 40; finish('completed'); expect(JSON.stringify(run())).toBe(before);
  });
  it('does not let a same-id replacement inherit a stale timing callback', () => {
    const finish = observer().begin('pull', 'git-pull');
    const original = run(); state.getState().deploymentRuns![original.id] = structuredClone(original);
    const before = JSON.stringify(run()); mono += 40; finish('completed'); expect(JSON.stringify(run())).toBe(before);
  });
  it.each(['id', 'operationId'] as const)('does not adopt a changed run %s', field => {
    const finish = observer().begin('pull', 'git-pull');
    if (field === 'id') run().id = 'dr_other'; else delete run().operationId;
    const before = JSON.stringify(run()); mono += 40; finish('completed'); expect(JSON.stringify(run())).toBe(before);
  });
  it('bounds interval retention and reports truncation, never full measured coverage', () => {
    const t = observer(); for (let i = 0; i < 520; i++) { const finish = t.begin('readiness', 'application-ready', 'api'); mono += 1; finish('completed'); }
    expect(run().timing!.intervals).toHaveLength(512); expect(run().timing!.truncated).toBe(true);
    expect(summarizeDeploymentTiming(run().timing)).toMatchObject({ incomplete: true, truncated: true });
  });
  it('marks unfinished stages unknown at terminal without inventing an external completion time', () => {
    observer().begin('startup', 'prebuilt-start', 'api'); mono += 10000;
    service.fail(run().id, { code: 'interrupted', owner: 'cds', summary: 'interrupted', retryable: true });
    expect(run().timing!.intervals[0]).toMatchObject({ outcome: 'unknown', durationMs: null });
    expect(run().timing!.intervals[0].endedAt).toBeUndefined();
    expect(summarizeDeploymentTiming(run().timing).stages.startup).toMatchObject({ completedWallMs: null, unknown: 1, status: 'incomplete' });
  });
  it('preserves a work rejection if the observer ownership reader itself throws', async () => {
    const error = Error('original work failure'); const t = service.createTimingObserver(run().id, 'op_own', () => { throw Error('observer unavailable'); });
    await expect(t.measure('pull', 'git-pull', null, async () => { throw error; })).rejects.toBe(error);
  });
  it('preserves a work result if a success observer throws', async () => {
    const result = await observer().measure('readiness', 'application-ready', null, async () => 5, () => { throw Error('observer unavailable'); });
    expect(result).toBe(5);
  });
  it('keeps an illegal clock observation unknown while preserving business completion', async () => {
    expect(await observer().measure('pull', 'git-pull', null, async () => { mono = NaN; return 7; })).toBe(7);
    expect(run().timing!.intervals[0]).toMatchObject({ outcome: 'completed', durationMs: null });
    expect(summarizeDeploymentTiming(run().timing).stages.pull.status).toBe('incomplete');
  });
  it('does not mutate detached summaries or guess legacy measurements', () => {
    const empty = summarizeDeploymentTiming(undefined); expect(Object.values(empty.stages)).toHaveLength(9);
    expect(Object.values(empty.stages).every(s => s.completedWallMs === null)).toBe(true);
    const finish = observer().begin('pull', 'git-pull'); mono += 12; finish('completed');
    const summary = summarizeDeploymentTiming(run().timing); summary.stages.pull.completedWallMs = 999;
    expect(summarizeDeploymentTiming(run().timing).stages.pull.completedWallMs).toBe(12);
  });
});
