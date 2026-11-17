import { describe, it, expect, vi } from 'vitest';
import { DtsService } from '../../src/services/dts.js';
import { dtsCredentialAllowed } from '../../src/services/dts-access.js';
import * as policy from '../../src/services/dts-policy.js';
import type { DtsStore } from '../../src/services/dts-store.js';
import type { DtsSeaTunnel } from '../../src/services/dts-seatunnel.js';
import type { DtsActor, DtsConnection, DtsPlan, DtsRun } from '../../src/shared/dts.js';
import type { StateService } from '../../src/services/state.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

const actor: DtsActor = { kind: 'project-key', id: 'key' };
const connection = (id: string): DtsConnection => ({ id, projectId: 'p', name: id, kind: 'mongo', uriEnv: id === 'source' ? 'SOURCE' : 'TARGET', database: 'business', collection: 'accounts',
  contract: { id: 'accounts', version: 2, accepts: [1, 2], fields: { _id: 'string', name: 'string', revision: 'int' } }, environmentRole: id === 'source' ? 'production' : 'standby', allowWrite: id !== 'source', accountFields: ['name'], createdAt: '2026-11-17' });
const makePlan = (): DtsPlan => ({ id: 'plan', projectId: 'p', sourceId: 'source', targetId: 'target', mode: 'append-only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  sourceFingerprint: 's', targetFingerprint: 't', fields: { _id: 'string', name: 'string' }, sourceCount: 2, targetCount: 2, insertCount: 1, updateCount: 0, skipCount: 1,
  selectedBytes: 50, targetFreeBytes: 1e9, requiredFreeBytes: 3e8, keys: ['new'], selectedDigest: 'data', approvedBy: actor, sourceContract: connection('source').contract, targetContract: connection('target').contract });
function setup(status = 'RUNNING') {
  const rows = new Map<string, unknown>(); let locked = '';
  const key = (kind: string, project: string, id: string) => `${kind}:${project}:${id}`;
  const store = { configured: () => true,
    async put(kind: string, value: { id: string; projectId: string }) { rows.set(key(kind, value.projectId, value.id), structuredClone(value)); },
    async get(kind: string, project: string, id: string) { return structuredClone(rows.get(key(kind, project, id))); },
    async list(kind: string, project: string) { return [...rows.entries()].filter(([k]) => k.startsWith(`${kind}:${project}:`)).map(([,v]) => structuredClone(v)); },
    async activeRuns() { return []; },
    async byIdempotency(project: string, idempotency: string) { return [...rows.values()].find(v => (v as DtsRun).projectId === project && (v as DtsRun).idempotencyKey === idempotency); },
    async acquire(_target: string, _project: string, id: string) { if (locked) return false; locked = id; return true; },
    async release(_target: string, id: string) { if (locked === id) locked = ''; },
  };
  const allowed = vi.fn(async () => true);
  const engine = { call: vi.fn(async (_binding, operation: string, id: string) => operation === 'overview' ? { projectVersion: '3.0.0' } : { jobId: id, jobStatus: status }) };
  const audit: { requestId: string; projectId: string }[] = [];
  const sink = { async recordImmediate(e: typeof audit[number]) { audit.push(e); }, async findRecent() { return audit; } };
  const service = new DtsService(store as unknown as DtsStore, { getCustomEnv: () => ({ SOURCE: 'mongodb://source', TARGET: 'mongodb://target' }) } as unknown as StateService,
    sink as unknown as ServerEventLogSink, allowed, engine as unknown as DtsSeaTunnel);
  const seed = async () => {
    await store.put('connections', connection('source')); await store.put('connections', connection('target'));
    await store.put('plans', makePlan());
    await store.put('engines', { id: 'engine:p', projectId: 'p', baseUrl: 'http://engine', version: '3.0.0', usernameEnv: 'USER', passwordEnv: 'PASSWORD' });
  };
  return { service, store, engine, allowed, seed, locked: () => locked };
}
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

describe('DTS admission and native-job recovery', () => {
  it('rejects an unaccepted source version before constructing a native job', () => {
    const source = connection('source'), target = connection('target'); target.contract.accepts = [1];
    expect(() => policy.compatibleDtsFields(source, target, 'append-only')).toThrow('版本');
  });
  it('rejects reverse account authority even when both connections permit generic writes', () => {
    const source = connection('source'), target = connection('target'); source.allowWrite = true;
    expect(() => policy.compatibleDtsFields(target, source, 'account-authority')).toThrow('不能反向');
  });
  it.each(['redis','rabbitmq'] as const)('rejects unimplemented %s prefix mapping before any native write', kind => {
    const source={...connection('source'),kind,collection:'source_prefix'},target={...connection('target'),kind,collection:'target_prefix'};
    expect(()=>policy.compatibleDtsFields(source,target,'append-only')).toThrow('相同的批准前缀');
  });
  it('requires administrator approval before a connection can become a write target', () => {
    const target = connection('target'); target.allowWrite = false;
    expect(() => policy.compatibleDtsFields(connection('source'), target, 'append-only')).toThrow('未获准');
  });
  it('pins only administrator-selected account fields and never enables upsert for business append', () => {
    expect(policy.compatibleDtsFields(connection('source'), connection('target'), 'account-authority')).toEqual({ _id: 'string', name: 'string' });
    const job = policy.buildDtsMongoJob(makePlan(), connection('source'), connection('target'), 'mongodb://source', 'mongodb://target') as { source: Record<string, unknown>[]; sink: Record<string, unknown>[] };
    expect(job.sink[0]['upsert-enable']).toBe(false); expect(JSON.parse(String(job.source[0]['match.query']))).toEqual({ _id: { $in: ['new'] } });
  });
  it.each(['password', 'accessToken', 'sessionId', 'migrationVersion'])('rejects protected data %s', field => {
    expect(() => policy.parseDtsContract({ id: 'accounts', version: 1, accepts: [1], fields: { _id: 'string', [field]: 'string' } })).toThrow('受保护');
  });
  it('rejects account role escalation in the update whitelist', () => {
    const c = connection('target'); c.contract.fields.role = 'string'; c.accountFields = ['role']; expect(() => policy.parseDtsConnection('p', c)).toThrow('账号');
  });
  it('returns the original idempotent task without resubmitting', async () => {
    const f = setup(); await f.seed(); const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(makePlan());
    try { const a = await f.service.start('p', 'plan', 'same-operation', actor); await settle(); const b = await f.service.start('p', 'plan', 'same-operation', actor);
      expect(b.id).toBe(a.id); expect(f.engine.call.mock.calls.filter(c => c[1] === 'submit')).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it('keeps the writer guard when submit times out, and recovers by the persisted native job id', async () => {
    const f = setup(); await f.seed(); const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(makePlan());
    f.engine.call.mockRejectedValueOnce(new Error('timeout after acceptance'));
    try { const run = await f.service.start('p', 'plan', 'uncertain', actor); await settle(); expect((await f.service.run('p', run.id)).status).toBe('uncertain');
      expect(f.locked()).toBe(run.id); const recovered = await f.service.refresh('p', run.id); expect(recovered.status).toBe('running');
      expect(f.engine.call.mock.calls.at(-1)?.[2]).toBe(run.engineJobId); expect(f.engine.call.mock.calls.filter(c => c[1] === 'submit')).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it('does not report paused or unlock until the engine confirms termination', async () => {
    const f = setup(); await f.seed(); const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(makePlan());
    try { const run = await f.service.start('p', 'plan', 'pause', actor); await settle(); await f.service.control('p', run.id, 'pause', actor);
      expect((await f.service.refresh('p', run.id)).status).toBe('pausing'); expect(f.locked()).toBe(run.id);
      f.engine.call.mockResolvedValueOnce({ jobId: run.engineJobId, jobStatus: 'CANCELED' }); expect((await f.service.refresh('p', run.id)).status).toBe('paused'); expect(f.locked()).toBe('');
    } finally { spy.mockRestore(); }
  });
  it('preserves pause intent across a lost stop response and subsequent FINISHED', async () => {
    const f = setup(); await f.seed(); const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(makePlan());
    try { const run = await f.service.start('p', 'plan', 'lost-pause', actor); await settle();
      f.engine.call.mockRejectedValueOnce(new Error('stop response lost')); await f.service.control('p', run.id, 'pause', actor);
      expect((await f.service.run('p', run.id)).status).toBe('uncertain');
      f.engine.call.mockResolvedValueOnce({ jobId: run.engineJobId, jobStatus: 'FINISHED' });
      expect((await f.service.refresh('p', run.id)).status).toBe('paused'); expect(f.locked()).toBe('');
    } finally { spy.mockRestore(); }
  });
  it('refuses to mark FINISHED successful when independent verification finds different data', async () => {
    const f = setup('FINISHED'); await f.seed(); const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(makePlan());
    const verify = vi.spyOn(policy, 'verifyDtsPlan').mockRejectedValue(new policy.DtsError(409, 'verification_mismatch', '数据对账不一致'));
    try { const run = await f.service.start('p', 'plan', 'mismatch', actor); await settle(); expect((await f.service.refresh('p', run.id)).status).toBe('failed'); expect(f.locked()).toBe(''); }
    finally { spy.mockRestore(); verify.mockRestore(); }
  });
  it('stops a running native job when its original authority is revoked', async () => {
    const f = setup(); await f.seed(); const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(makePlan());
    try { const run = await f.service.start('p', 'plan', 'revoke', actor); await settle(); f.allowed.mockResolvedValue(false);
      expect((await f.service.refresh('p', run.id)).status).toBe('cancelling'); expect(f.engine.call.mock.calls.some(c => c[1] === 'stop')).toBe(true); expect(f.locked()).toBe(run.id);
    } finally { spy.mockRestore(); }
  });
  it('rejects changed differences before any native write', async () => {
    const f = setup(); await f.seed(); const changed = { ...makePlan(), selectedDigest: 'new-data' }; const spy = vi.spyOn(policy, 'prepareDtsPlan').mockResolvedValue(changed);
    try { const run = await f.service.start('p', 'plan', 'stale', actor); await settle(); expect((await f.service.run('p', run.id)).status).toBe('failed'); expect(f.engine.call).not.toHaveBeenCalled(); expect(f.locked()).toBe(''); }
    finally { spy.mockRestore(); }
  });
});
describe('DTS unified identity grants', () => {
  const identity = () => {
    const principal = { id: 'person', status: 'active' }, parent = { id: 'parent', principalId: 'person', expiresAt: '2099-01-01', revokedAt: undefined as string | undefined };
    const grant = { principalId: 'person', projectId: 'p', revokedAt: undefined as string | undefined };
    const key = { id: 'key', scope: 'rw', principalId: 'person', issuedByCredentialId: 'parent' };
    return { principal, parent, grant, state: { getAgentKeys: () => [key], getUserCredentials: () => [parent], getPrincipal: () => principal, getProjectGrants: () => [grant] } as unknown as StateService };
  };
  it('honors parent revocation and project grant revocation for background jobs', () => {
    const f = identity(); expect(dtsCredentialAllowed(f.state, actor, 'p')).toBe(true); f.parent.revokedAt = new Date().toISOString(); expect(dtsCredentialAllowed(f.state, actor, 'p')).toBe(false);
    f.parent.revokedAt = undefined; f.grant.revokedAt = new Date().toISOString(); expect(dtsCredentialAllowed(f.state, actor, 'p')).toBe(false);
  });
  it('does not allow an expired personal credential to run an old policy', () => {
    const f = identity(); f.parent.expiresAt = '2020-01-01'; expect(dtsCredentialAllowed(f.state, { kind: 'principal', id: 'parent' }, 'p')).toBe(false);
  });
});
