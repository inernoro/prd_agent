import { summarizeDeploymentTiming } from '../../src/services/deployment-stage-timing.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectCiTiming, summarizeCiTiming, CiTimingCollector, type CiTimingTarget } from '../../src/services/deployment-ci-timing.js';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
const target: CiTimingTarget = { installationId: 1, repository: 'owner/repo', branch: 'main', headSha: 'a'.repeat(40) };
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 11) + seconds * 1000).toISOString();
const run = () => ({ id: 77, run_attempt: 2, path: '.github/workflows/branch-image.yml', event: 'push', head_sha: target.headSha, head_branch: 'main', repository: { full_name: target.repository }, head_repository: { full_name: target.repository } });
const job = (id = 1, start = 10, end = 40) => ({ id, run_id: 77, run_attempt: 2, head_sha: target.headSha, created_at: at(0), started_at: at(start), completed_at: at(end), status: 'completed', conclusion: 'success', PRIVATE_LABEL: 'TOKEN' });
const record = () => projectCiTiming(target, run(), { total_count: 2, jobs: [job(), job(2, 20, 50)] })!;
afterEach(() => { vi.useRealTimers(); });
describe('provider CI facts independent of local timing epoch', () => {
  it('uses job wait/execution unions, separate work sums and exact immutable provenance', () => {
    const value = record(), summary = summarizeCiTiming(value);
    expect(summary.runner).toMatchObject({ status: 'observed', completedWallMs: 20000, workMs: 30000 });
    expect(summary.build).toMatchObject({ status: 'observed', completedWallMs: 40000, workMs: 60000, completed: 2 });
    expect(value).toMatchObject({ repository: target.repository, headSha: target.headSha, runId: 77, runAttempt: 2 });
    expect(JSON.stringify(value)).not.toContain('TOKEN');
    expect(summary).toMatchObject({ incomplete: false, clock: 'github-provider', runnerMeaning: 'job-pre-start', buildMeaning: 'job-execution' });
  });
  it.each(['head_sha', 'head_branch', 'path', 'event', 'repository', 'head_repository', 'run_attempt'])('refuses unmatched or unbound workflow %s', field => {
    const raw: any = run(); raw[field] = field.endsWith('repository') ? { full_name: 'fork/other' } : field === 'run_attempt' ? 0 : 'other';
    expect(projectCiTiming(target, raw, { total_count: 1, jobs: [job()] })).toBeNull();
  });
  it('does not replace missing created_at with run or step timestamps', () => {
    const raw: any = job(); delete raw.created_at; raw.steps = [{ started_at: at(0) }];
    const value = projectCiTiming(target, { ...run(), created_at: at(0) }, { total_count: 1, jobs: [raw] });
    const summary = summarizeCiTiming(value);
    expect(summary.runner).toMatchObject({ status: 'incomplete', completedWallMs: null, unknown: 1 });
    expect(summary.build.completedWallMs).toBe(30000); expect(summary.incomplete).toBe(true);
  });
  it.each([{ ...job(), run_attempt: 1 }, { ...job(), head_sha: 'b'.repeat(40) }, { ...job(), id: 0 }, { ...job(), run_id: 78 }])('retains unknown denominator for invalid job identity', raw => {
    const value = projectCiTiming(target, run(), { total_count: 1, jobs: [raw] });
    expect(summarizeCiTiming(value)).toMatchObject({ incomplete: true, truncated: true });
    expect(value!.jobs).toHaveLength(0);
  });
  it('preserves failure outcomes, pending jobs, missing denominator and truncation', () => {
    const value = projectCiTiming(target, run(), { total_count: 3, jobs: [{ ...job(), conclusion: 'failure' }, { ...job(2), status: 'in_progress', completed_at: null }] });
    const summary = summarizeCiTiming(value);
    expect(summary).toMatchObject({ incomplete: true, truncated: true });
    expect(summary.build).toMatchObject({ failed: 1, open: 1, completed: 0, completedWallMs: 30000 });
  });
  it('rejects invalid dates/order and raw numeric coercions; never fabricates zero', () => {
    const raw = { ...job(), created_at: null, started_at: 'not-a-date', completed_at: at(0) };
    const summary = summarizeCiTiming(projectCiTiming(target, run(), { total_count: 1, jobs: [raw] }));
    expect(summary.runner.completedWallMs).toBeNull(); expect(summary.build.completedWallMs).toBeNull();
    expect(summarizeCiTiming(null).runner).toMatchObject({ status: 'not-observed', completedWallMs: null });
  });
  it('bounds job facts, marks duplicate ids and returns detached summaries', () => {
    const value = projectCiTiming(target, run(), { total_count: 101, jobs: Array.from({ length: 101 }, (_, n) => job(n + 1)) })!;
    expect(value.jobs).toHaveLength(100); expect(value.truncated).toBe(true);
    expect(projectCiTiming(target, run(), { total_count: 2, jobs: [job(), job()] })!.truncated).toBe(true);
    const a = summarizeCiTiming(value); a.build.workMs = 1; expect(summarizeCiTiming(value).build.workMs).not.toBe(1);
  });
});
describe('independent provider and local summary clocks', () => {
  it('does not erase malformed local facts when external CI fills the final stages', () => {
    const boundaries = { artifact: 'exact-artifact', capacity: 'capacity-check', pull: 'git-pull', startup: 'prebuilt-start', readiness: 'application-ready', switch: 'route-ack', cleanup: 'owned-recycle' };
    const local: any = { version: 1, operationId: 'op_ci', epochId: 'local', truncated: false, intervals: Object.entries(boundaries).map(([stage, boundary]) => ({ id: stage, stage, boundary, profileId: null, commitShaAtStart: target.headSha, startedAt: at(0), startOffsetMs: 0, endOffsetMs: 100, durationMs: 100, outcome: 'completed' })) };
    expect(summarizeDeploymentTiming(local, record()).incomplete).toBe(false);
    local.intervals.push({ stage: 'INVALID' }); expect(summarizeDeploymentTiming(local, record()).incomplete).toBe(true);
  });
  it('keeps invalid calendar dates unknown and caps projection before mapping a stored array', () => {
    const invalid = { ...job(), created_at: '2026-02-30T00:00:00Z' };
    expect(projectCiTiming(target, run(), { total_count: 1, jobs: [invalid] })!.jobs[0].createdAt).toBeNull();
    const huge = record(); huge.jobs = Array.from({ length: 200 }, (_, n) => ({ ...huge.jobs[0], id: n + 1 }));
    expect(summarizeCiTiming(huge)).toMatchObject({ truncated: true, provenance: { jobs: 100 } });
  });
});
describe('bounded nonblocking CI observation', () => {
  it('keeps timed-out underlying work occupying capacity, bounds waiting and expires without late publish', async () => {
    vi.useFakeTimers(); let release!: (v: any) => void; const fetch = vi.fn(() => new Promise<any>(r => { release = r; })); const publish = vi.fn();
    const collector = new CiTimingCollector(fetch, { maxActive: 1, maxQueued: 1, timeoutMs: 30 });
    expect(collector.capture(target, publish)).toBe(true); await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(1);
    expect(collector.capture({ ...target, headSha: 'b'.repeat(40) }, publish)).toBe(true);
    expect(collector.capture({ ...target, headSha: 'c'.repeat(40) }, publish)).toBe(false);
    await vi.advanceTimersByTimeAsync(31); expect(publish.mock.calls).toEqual([[null], [null]]); expect(fetch).toHaveBeenCalledTimes(1);
    release(record()); await vi.advanceTimersByTimeAsync(0); expect(publish).toHaveBeenCalledTimes(2);
  });
  it('scopes cached evidence by installation/repo/branch/fullSHA and never shares mutable result', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => record()); const collector = new CiTimingCollector(fetch); const a = vi.fn(), b = vi.fn();
    collector.capture(target, a); await vi.advanceTimersByTimeAsync(0); a.mock.calls[0][0].jobs[0].id = 99;
    collector.capture(target, b); await vi.advanceTimersByTimeAsync(0); expect(b.mock.calls[0][0].jobs[0].id).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
    collector.capture({ ...target, installationId: 2 }, b); await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('defaults to four held calls, sixteen queued and one deadline from acceptance; overflow never starts', async () => {
    vi.useFakeTimers(); const fetch = vi.fn((_t: CiTimingTarget, _s: AbortSignal) => new Promise<any>(() => {})), publish = vi.fn(); const collector = new CiTimingCollector(fetch);
    for (let n = 0; n < 4; n++) collector.capture({ ...target, branch: 'b'+n }, publish);
    await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(4);
    for (let n = 4; n < 20; n++) expect(collector.capture({ ...target, branch: 'b'+n }, publish)).toBe(true);
    expect(collector.capture({ ...target, branch: 'b20' }, publish)).toBe(false);
    await vi.advanceTimersByTimeAsync(3001); expect(publish).toHaveBeenCalledTimes(20); expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
  });
  it('bounds completed cache and expires old entries without pending completion poisoning it', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async (t: CiTimingTarget) => ({ ...record(), headBranch: t.branch })); const collector = new CiTimingCollector(fetch), publish = vi.fn();
    for (let n = 0; n < 65; n++) { collector.capture({ ...target, branch: 'b'+n }, publish); await vi.advanceTimersByTimeAsync(0); }
    collector.capture({ ...target, branch: 'b0' }, publish); await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(66);
    collector.capture({ ...target, branch: 'b64' }, publish); await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(66);
    await vi.advanceTimersByTimeAsync(30001); collector.capture({ ...target, branch: 'b64' }, publish); await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(67);
  });
  it('contains provider and publish exceptions without raw logging or runtime impact', async () => {
    vi.useFakeTimers(); const c = new CiTimingCollector(async () => { throw Error('PRIVATE_SECRET'); }); const p = vi.fn(() => { throw Error('publisher'); });
    expect(c.capture(target, p)).toBe(true); await vi.advanceTimersByTimeAsync(0); expect(p).toHaveBeenCalledWith(null);
  });
});
describe('original owned run publication', () => {
  let root: string;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  async function fixture() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ci-owned-')); const state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'b', projectId: 'default', branch: 'main', worktreePath: root, services: {}, status: 'idle', createdAt: at(0) } as any);
    const service = new DeploymentRunService(state); const own = await service.begin({ projectId: 'default', branchId: 'b', trigger: 'manual', operationId: 'op_ci', commitSha: target.headSha });
    let current = true; const publish = service.createCiTimingPublisher(own.id, 'op_ci', target, () => current);
    return { state, service, own, publish, cancelLease: () => { current = false; } };
  }
  it('persists and reloads exact CI facts, without local epoch adoption or copied private fields', async () => {
    const f = await fixture(); f.publish(record()); await f.state.flush(); const reload = new StateService(path.join(root, 'state.json')); reload.load();
    expect(reload.getDeploymentRun(f.own.id)!.ciTiming).toMatchObject({ headSha: target.headSha, runAttempt: 2 });
    expect(f.own.timing).toBeUndefined();
  });
  it.each(['sha', 'op'])('does not adopt a run unbound at capture start even if %s later matches', async kind => {
    const f = await fixture(); const original = { sha: f.own.commitSha, op: f.own.operationId };
    if (kind === 'sha') f.own.commitSha = 'b'.repeat(40); else f.own.operationId = 'op_other';
    const late = f.service.createCiTimingPublisher(f.own.id, 'op_ci', target, () => true);
    f.own.commitSha = original.sha; f.own.operationId = original.op; late(record()); expect(f.own.ciTiming).toBeUndefined();
  });
  it.each(['terminal', 'lease', 'sha', 'op', 'project', 'branch'])('rejects late or changed %s ownership', async kind => {
    const f = await fixture();
    if (kind === 'terminal') f.service.cancel(f.own.id, 'cancel'); else if (kind === 'lease') f.cancelLease();
    else if (kind === 'sha') f.own.commitSha = 'b'.repeat(40); else if (kind === 'op') f.own.operationId = 'op_other';
    else if (kind === 'project') f.own.projectId = 'other'; else f.own.branchId = 'other';
    f.publish(record()); expect(f.own.ciTiming).toBeUndefined();
  });
});
