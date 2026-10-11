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
});
