import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PendingDeployJournal, pendingJournalFileIO } from '../../src/services/pending-deploy-journal.js';
import { BranchOperationCoordinator, type PendingWebhookDeploy } from '../../src/services/branch-operation-coordinator.js';
const tick = () => new Promise<void>(r => setImmediate(r));
const intent = (profileId = 'api', generation = 2): PendingWebhookDeploy => ({ operationId: `op_${profileId}`, branchId: 'owned', generation,
  request: { projectId: 'p', branchId: 'owned', profileId, kind: 'deploy-profile', trigger: 'webhook', commitSha: 'a'.repeat(40) }, mergedCount: 1, updatedAt: new Date().toISOString() });
async function memory() {
  let disk: unknown = null; const io = { load: async () => structuredClone(disk), save: vi.fn(async d => { disk = structuredClone(d); }) };
  const journal = new PendingDeployJournal(io); await journal.ready(); return { journal, io, disk: () => disk };
}
afterEach(() => vi.useRealTimers());
describe('durable pending intent journal', () => {
  it('retains latest API and independent worker across complete-to-dispatch and new OS process reload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-own-pending-')); const file = path.join(root, 'pending.json');
    try {
      const journal = new PendingDeployJournal(pendingJournalFileIO(file)); await journal.ready();
      const c = new BranchOperationCoordinator(undefined, undefined, journal);
      const active = c.begin({ branchId: 'owned', projectId: 'p', kind: 'deploy', trigger: 'manual' });
      await c.begin(intent().request).persistence;
      await c.begin({ ...intent().request, commitSha: 'b'.repeat(40) }).persistence;
      await c.begin(intent('worker').request).persistence;
      const handed = c.complete(active.lease!, 'completed'); expect(handed?.request.profileId).toBe('api');
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).queued).toHaveLength(2); // memory complete is not an ACK erase
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const program = `import {PendingDeployJournal,pendingJournalFileIO} from '${pathToFileURL(path.resolve('src/services/pending-deploy-journal.ts')).href}';import{BranchOperationCoordinator}from '${pathToFileURL(path.resolve('src/services/branch-operation-coordinator.ts')).href}';const j=new PendingDeployJournal(pendingJournalFileIO(process.argv[2]));await j.ready();const c=new BranchOperationCoordinator(undefined,undefined,j);console.log(JSON.stringify({pid:process.pid,data:j.snapshot(),decision:c.begin({branchId:'owned',projectId:'p',kind:'deploy',trigger:'manual'}),pending:c.getPendingWebhookDeploy('owned')}));`;
      const observer = path.join(root, 'observer.mjs'); fs.writeFileSync(observer, program);
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', observer, file], { timeout: 8000 });
      const child = JSON.parse(stdout); expect(child.pid).not.toBe(process.pid); expect(child.data.queued.map(p => p.request.profileId)).toEqual(['api', 'worker']);
      expect(child.pending.request.commitSha).toBe('b'.repeat(40)); expect(child.decision.reason).toBe('pending_recovery_required');
      expect(await c.claimPending(handed!)).toBe(true); expect(JSON.parse(fs.readFileSync(file, 'utf8')).claims[0].pending.operationId).toBe(handed!.operationId);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('persists an artifact waiter before ACK and claims its original operation when artifacts become ready', async () => {
    const { journal, io } = await memory();
    const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const decision = c.begin({ ...intent().request, trigger: 'manual', commitPinned: false }, { waitForArtifacts: true });
    expect(decision.status).toBe('merged'); expect(decision.persistence).toBeDefined();
    await decision.persistence;
    expect(io.save).toHaveBeenCalledOnce();
    expect(journal.queued()[0]).toMatchObject({ operationId: decision.operationId, generation: decision.generation });
    const pending = c.drainReady()[0];
    expect(pending.operationId).toBe(decision.operationId);
    expect(await c.claimPending(pending)).toBe(true);
    expect(journal.snapshot().claims[0].pending.generation).toBe(decision.generation);
  });
  it.each([false, true])('State acceptance failure retains the original journal until terminal State ACK; failure=%s', async failState => {
    const { journal } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const decision = c.begin(intent().request, { waitForArtifacts: true }); await decision.persistence;
    let release!: () => void, reject!: (error: Error) => void;
    const stateAck = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    const abandoning = c.abandonAdmission(decision.operationId, decision.generation, () => stateAck);
    const rejection = failState ? expect(abandoning).rejects.toThrow('State ACK unknown') : undefined;
    await tick(); expect(journal.queued()).toHaveLength(1);
    const stop = c.begin({ projectId: 'p', branchId: 'owned', kind: 'stop', trigger: 'manual' });
    expect(stop.status).toBe('started'); c.complete(stop.lease!, 'completed');
    expect(c.begin(intent().request).reason).toBe('pending_settlement_unacknowledged'); expect(c.drainReady()).toEqual([]);
    if (failState) { reject(new Error('State ACK unknown')); await rejection; expect(journal.queued()).toHaveLength(1); }
    else { release(); await abandoning; expect(journal.queued()).toEqual([]); }
    if (failState) expect(c.begin(intent().request).status).toBe('rejected');
  });
  it.each(['claiming', 'ready', 'sent'] as const)('failed State admission fences an already drained %s dispatch until terminal ACK', async phase => {
    const { journal } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const decision = c.begin(intent().request, { waitForArtifacts: true }); await decision.persistence;
    const pending = c.drainReady()[0]; expect(pending).toBeDefined();
    if (phase !== 'claiming') expect(await c.claimPending(pending)).toBe(true);
    if (phase === 'sent') expect(c.markPendingSent(pending)).toBe(true);
    const ended = vi.fn(); c.onOperationEnded(ended);
    let release!: () => void; const stateAck = new Promise<void>(resolve => release = resolve);
    const abandoning = c.abandonAdmission(decision.operationId, decision.generation, () => stateAck);
    try {
      await tick(); expect(ended).toHaveBeenCalledWith(decision.operationId, decision.generation, 'failed');
      expect(c.getClaimedPendingReplay({ operationId: pending.operationId, generation: pending.generation })).toBeUndefined();
      expect(c.markPendingSent(pending)).toBe(false);
      expect(c.begin({ ...pending.request, pendingOperationId: pending.operationId, pendingGeneration: pending.generation }).status).toBe('rejected');
      expect(c.begin({ ...pending.request, commitSha: 'c'.repeat(40) }).reason).toBe('pending_settlement_unacknowledged');
      expect(journal.snapshot().queued.length + journal.snapshot().claims.length).toBe(1);
    } finally { release(); await abandoning; }
    expect(journal.snapshot().queued).toEqual([]); expect(journal.snapshot().claims).toEqual([]);
  });
  it('rejects a durable whole replay whose dispatch was revoked by a newer profile rebuild, even while cancel ACK is held', async () => {
    const { journal, io } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const request = { ...intent().request, kind: 'deploy' as const, profileId: undefined };
    const first = c.begin({ ...request, trigger: 'manual', commitSha: 'b'.repeat(40) });
    await c.begin(request).persistence;
    const pending = c.complete(first.lease!, 'completed')!;
    expect(await c.claimPending(pending)).toBe(true); expect(c.markPendingSent(pending)).toBe(true);
    let release!: () => void;
    io.save.mockImplementationOnce(() => new Promise<void>(resolve => release = resolve));
    const rebuild = c.begin({ ...request, kind: 'force-rebuild', profileId: 'api', trigger: 'manual', continueWith: 'deploy-profile' });
    expect(rebuild.status).toBe('started'); await tick();
    try {
      const replay = c.begin({ ...request, pendingReplay: { operationId: pending.operationId, generation: pending.generation } });
      expect(replay.status).toBe('rejected'); expect(replay.reason).toBe('pending_dispatch_stale');
      expect(c.getPendingWebhookDeploy('owned')).toBeUndefined();
    } finally { release(); await tick(); }
    expect(journal.snapshot().claims[0].phase).toBe('unknown');
  });
  it('waits for write ACK and leaves the old acknowledged snapshot untouched while a claim is held', async () => {
    const { journal, io } = await memory(); const p = intent(); await journal.upsert(p);
    let finish!: () => void; io.save.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    let acknowledged = false; const claiming = journal.claim(p).then(v => { acknowledged = v; }); await tick();
    expect(acknowledged).toBe(false); expect(journal.snapshot().queued).toHaveLength(1); expect(journal.snapshot().claims).toHaveLength(0);
    finish(); await claiming; expect(acknowledged).toBe(true); expect(journal.snapshot().claims).toHaveLength(1);
  });
  it('settling API never removes another scope claim; unknown is retained and blocks only conflicts', async () => {
    const { journal } = await memory(); const a = intent(); const b = intent('worker');
    await journal.upsert(a); await journal.upsert(b); await journal.claim(a); await journal.claim(b);
    await journal.settle(a, { outcome: 'completed', reason: 'deployment_completed' });
    expect(journal.snapshot().claims.map(c => c.pending.operationId)).toEqual(['op_worker']);
    await journal.settle(b, { outcome: 'unknown', reason: 'terminal_missing' });
    expect(journal.blockReason(a.request)).toBeNull(); expect(journal.blockReason(b.request)).toBe('pending_recovery_required');
    expect(journal.blockReason({ ...a.request, profileId: null, kind: 'deploy' })).toBe('pending_recovery_required');
    expect(journal.blockReason({ ...b.request, kind: 'stop' })).toBeNull();
  });
  it('preserves corrupt/unknown schemas without overwriting them and refuses deployments', async () => {
    for (const raw of [{ version: 2, queued: [], claims: [] }, { version: 1, queued: [intent(), intent()], claims: [] }]) {
      const save = vi.fn(async () => {}); const j = new PendingDeployJournal({ load: async () => raw, save }); await j.ready();
      expect(j.blockReason(intent().request)).toBe('pending_journal_unavailable'); await expect(j.upsert(intent())).rejects.toThrow(); expect(save).not.toHaveBeenCalled();
    }
  });
  it('holds an unanswered write to a deadline, latches uncertainty and does not retry or publish a fake ACK', async () => {
    const { journal, io } = await memory(); vi.useFakeTimers(); io.save.mockImplementationOnce(() => new Promise(() => {}));
    const write = journal.upsert(intent()); const rejected = expect(write).rejects.toThrow('pending_journal_write_unknown');
    await vi.advanceTimersByTimeAsync(3001); await rejected;
    expect(journal.snapshot().queued).toHaveLength(0); expect(journal.blockReason(intent().request)).toBe('pending_journal_unavailable');
    await expect(journal.upsert(intent('worker'))).rejects.toThrow(); expect(io.save).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects malformed/unreplayable intents before saving; replacement still fits a full per-branch queue', async () => {
    const { journal, io } = await memory();
    await expect(journal.upsert({ ...intent(), request: { ...intent().request, versionId: 'pinned' } })).rejects.toThrow();
    expect(io.save).not.toHaveBeenCalled();
    for (let i = 0; i < 64; i++) await journal.upsert(intent('scope' + i));
    await expect(journal.upsert(intent('overflow'))).rejects.toThrow('pending_journal_capacity');
    await journal.upsert({ ...intent('scope0', 3), request: { ...intent('scope0').request, commitSha: 'c'.repeat(40) } });
    expect(journal.snapshot().queued).toHaveLength(64); expect(journal.snapshot().queued[0].generation).toBe(3);
  });
  it.each([false, true])('revokes late replay before held cancellation ACK; write failure=%s never advances successors', async (failWrite) => {
    const { journal, io } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const active = c.begin({ branchId: 'owned', projectId: 'p', kind: 'deploy', trigger: 'manual' });
    await c.begin(intent().request).persistence;
    const pending = c.complete(active.lease!, 'completed')!;
    expect(await c.claimPending(pending)).toBe(true); expect(c.markPendingSent(pending)).toBe(true);
    let finish!: () => void; let reject!: (e: Error) => void;
    io.save.mockImplementationOnce(() => new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; }));
    const settling = c.settlePending(pending, { outcome: 'unknown', reason: 'response_timeout' });
    const rejection = failWrite ? expect(settling).rejects.toThrow() : undefined;
    await tick();
    const identity = { operationId: pending.operationId, generation: pending.generation };
    expect(c.getClaimedPendingReplay(identity)).toBeUndefined();
    expect(c.begin({ ...pending.request, pendingReplay: identity }).status).toBe('rejected');
    expect(c.begin({ ...pending.request, pendingOperationId: pending.operationId, pendingGeneration: pending.generation }).status).toBe('rejected');
    expect(c.begin({ ...pending.request, commitSha: 'c'.repeat(40) }).status).toBe('rejected');
    expect(c.drainReady()).toEqual([]); expect(c.getActiveOperations()).toEqual([]);
    const stop = c.begin({ branchId: 'owned', projectId: 'p', kind: 'stop', trigger: 'manual' });
    expect(stop.status).toBe('started'); c.complete(stop.lease!, 'completed');
    expect(c.begin({ ...pending.request, commitSha: 'd'.repeat(40) }).status).toBe('rejected');
    expect(c.drainReady()).toEqual([]);
    if (failWrite) { reject(new Error('disk unavailable')); await rejection; }
    else { finish(); await settling; }
    expect(c.getClaimedPendingReplay(identity)).toBeUndefined();
    expect(c.begin({ ...pending.request, pendingReplay: identity }).status).toBe('rejected');
    if (failWrite) { expect(c.drainReady()).toEqual([]); expect(c.begin(pending.request).status).toBe('rejected'); }
  });
  it('a stop during claim invalidates the old one-use token and prevents late begin; other scopes remain', async () => {
    const { journal, io } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const active = c.begin({ branchId: 'owned', projectId: 'p', kind: 'deploy', trigger: 'manual' }); await c.begin(intent().request).persistence;
    const p = c.complete(active.lease!, 'completed')!;
    let finish!: () => void; io.save.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    const claimed = c.claimPending(p); await tick(); expect(c.begin({ ...p.request, kind: 'stop', trigger: 'manual' }).status).toBe('started');
    finish(); expect(await claimed).toBe(false); expect(c.markPendingSent(p)).toBe(false);
    expect(c.begin({ ...p.request, pendingOperationId: p.operationId, pendingGeneration: p.generation }).reason).toBe('pending_dispatch_stale');
  });
  it('redeems only matching project/Profile/SHA/trigger once, then rejects duplicate and stale token', async () => {
    const { journal } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const active = c.begin({ branchId: 'owned', projectId: 'p', kind: 'deploy', trigger: 'manual' }); await c.begin(intent().request).persistence;
    const p = c.complete(active.lease!, 'completed')!; expect(await c.claimPending(p)).toBe(true); expect(c.markPendingSent(p)).toBe(true);
    const r = { ...p.request, pendingOperationId: p.operationId, pendingGeneration: p.generation };
    for (const delta of [{ projectId: 'other' }, { profileId: 'worker' }, { commitSha: 'b'.repeat(40) }, { trigger: 'manual' as const }, { pendingGeneration: p.generation + 1 }]) expect(c.begin({ ...r, ...delta }).reason).toBe('pending_dispatch_stale');
    expect(c.begin(r).status).toBe('started'); expect(c.begin(r).reason).toBe('pending_dispatch_stale');
  });
  it('redeems an unpinned manual whole intent after the cached SHA advances, while refusing an explicit pin', async () => {
    const { journal } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const request = { projectId: 'p', branchId: 'owned', kind: 'deploy' as const, trigger: 'manual' as const, commitSha: 'a'.repeat(40), commitPinned: false };
    const active = c.begin(request); await c.begin(request).persistence;
    const p = c.complete(active.lease!, 'completed')!; expect(await c.claimPending(p)).toBe(true); expect(c.markPendingSent(p)).toBe(true);
    const replay = { ...request, commitSha: 'b'.repeat(40), pendingOperationId: p.operationId, pendingGeneration: p.generation };
    expect(c.begin({ ...replay, commitSha: 'a'.repeat(40), commitPinned: true }).reason).toBe('pending_dispatch_stale');
    expect(c.begin(replay).status).toBe('started');
  });

  it('rejects a pinned token when fixed eligibility or effective config changes, without consuming the good token', async () => {
    const { journal } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const r = { projectId: 'p', branchId: 'owned', kind: 'deploy' as const, trigger: 'manual' as const, commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'original' };
    const active = c.begin({ ...r, commitSha: 'a'.repeat(40) }); await c.begin(r).persistence;
    const p = c.complete(active.lease!, 'completed')!; expect(await c.claimPending(p)).toBe(true); expect(c.markPendingSent(p)).toBe(true);
    const token = { ...r, pendingOperationId: p.operationId, pendingGeneration: p.generation };
    expect(c.begin({ ...token, commitPinned: false }).reason).toBe('pending_dispatch_stale');
    expect(c.begin({ ...token, configHash: 'changed' }).reason).toBe('pending_dispatch_stale');
    expect(c.begin(token).status).toBe('started');
  });

  it('keeps cache advancement but rejects SHA-neutral intent config drift without consuming the token', async () => {
    const { journal } = await memory(); const c = new BranchOperationCoordinator(undefined, undefined, journal);
    const r: any = { projectId: 'p', branchId: 'owned', kind: 'deploy', trigger: 'manual', commitSha: 'a'.repeat(40), commitPinned: false, configHash: 'imageA', pendingConfigHash: 'semantic' };
    const active = c.begin(r); await c.begin(r).persistence;
    const p = c.complete(active.lease!, 'completed')!; expect(await c.claimPending(p)).toBe(true); expect(c.markPendingSent(p)).toBe(true);
    const token = { ...r, commitSha: 'b'.repeat(40), configHash: 'imageB', pendingOperationId: p.operationId, pendingGeneration: p.generation };
    expect(c.begin({ ...token, pendingConfigHash: 'source-mode' }).reason).toBe('pending_dispatch_stale');
    expect(c.begin(token).status).toBe('started');
  });

});


describe('scoped durable pending observation', () => {
  it('projects recovered own Worker file records without request details or foreign scopes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-own-pending-view-')); const file = path.join(root, 'pending.json');
    try {
      const j = new PendingDeployJournal(pendingJournalFileIO(file)); await j.ready();
      const p = { ...intent(), request: { ...intent().request, actor: 'PRIVATE_ACTOR', requestId: 'PRIVATE_REQ', reason: 'PRIVATE_REASON', configHash: 'PRIVATE_DIGEST' } };
      await j.upsert(p);
      const restored = new PendingDeployJournal(pendingJournalFileIO(file)); await restored.ready();
      const status = restored.getStatus('p', 'owned'); expect(status.availability).toBe('ready'); expect(status.recoveryRequired).toBe(true);
      expect(status.entries).toHaveLength(1); expect(status.entries[0]).toMatchObject({ operationId: 'op_api', generation: 2, profileId: 'api', phase: 'queued', recoveryRequired: true });
      expect(JSON.stringify(status)).not.toContain('PRIVATE_'); expect(restored.getStatus('foreign', 'owned').total).toBe(0); expect(restored.getStatus('p', 'other').total).toBe(0);
      status.entries[0].operationId = 'op_changed'; expect(restored.getStatus('p', 'owned').entries[0].operationId).toBe('op_api');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('publishes only acknowledged data, then distinguishes unknown and terminal settlement', async () => {
    const { journal, io } = await memory(); let finish!: () => void;
    io.save.mockImplementationOnce(() => new Promise<void>(r => finish = r)); const writing = journal.upsert(intent()); await tick();
    try { expect(journal.getStatus('p', 'owned').total).toBe(0); } finally { finish(); await writing; }
    expect(journal.getStatus('p', 'owned').entries[0].phase).toBe('queued'); await journal.claim(intent());
    await journal.settle(intent(), { outcome: 'unknown', reason: 'terminal_missing', deploymentRunId: 'dr_owned' });
    expect(journal.getStatus('p', 'owned')).toMatchObject({ recoveryRequired: true, entries: [{ phase: 'unknown', deploymentRunId: 'dr_owned' }] });
    await journal.settle(intent(), { outcome: 'completed', reason: 'deployment_completed' }); expect(journal.getStatus('p', 'owned').total).toBe(0);
    const bad = new PendingDeployJournal({ load: async () => ({ version: 2 }), save: async () => {} });
    expect(bad.getStatus('p', 'owned').availability).toBe('loading'); await bad.ready(); expect(bad.getStatus('p', 'owned').availability).toBe('unavailable');
  });
  it('bounds projected claims while reporting the full scoped denominator', async () => {
    const { journal } = await memory();
    for (let i = 0; i < 129; i++) { const p = intent('scope' + i); await journal.upsert(p); await journal.claim(p); }
    const status = journal.getStatus('p', 'owned'); expect(status.total).toBe(129); expect(status.entries).toHaveLength(128); expect(status.truncated).toBe(true);
  });
});
