import type { PendingWebhookDeploy, BranchOperationRequest } from './branch-operation-coordinator.js';
import type { PendingDeployDispatchResult } from './pending-deploy-dispatch.js';
import type { IShellExecutor } from '../types.js';
import { ShellExecutor } from './shell-executor.js';

export interface PendingClaim { pending: PendingWebhookDeploy; phase: 'claimed' | 'unknown' | 'accepted'; claimedAt: string; result?: PendingDeployDispatchResult }
export interface PendingJournalData { version: 1; queued: PendingWebhookDeploy[]; claims: PendingClaim[] }
export interface PendingJournalIO { load(): Promise<unknown>; save(data: PendingJournalData): Promise<void> }
export interface PendingDeploymentStatus {
  availability: 'ready' | 'loading' | 'unavailable' | 'not-configured';
  recoveryRequired: boolean;
  total: number;
  truncated: boolean;
  entries: Array<{
    operationId: string; generation: number; profileId: string | null;
    trigger: BranchOperationRequest['trigger']; commitSha: string | null;
    commitPinned: boolean | null; updatedAt: string; mergedCount: number;
    phase: 'queued' | PendingClaim['phase']; recoveryRequired: boolean;
    deploymentRunId?: string;
  }>;
}
export const PENDING_JOURNAL_LIMITS = { queued: 512, branchQueued: 64, claims: 512, writes: 128, bytes: 2 * 1024 * 1024, ioMs: 3000, transactionMs: 10000 } as const;
const key = (p: PendingWebhookDeploy) => JSON.stringify([p.request.projectId, p.branchId, p.request.profileId || null]);
const id = (p: PendingWebhookDeploy) => `${p.operationId}:${p.generation}`;
const copy = <T>(value: T): T => structuredClone(value);
const string = (value: unknown, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
function validPending(value: unknown): value is PendingWebhookDeploy {
  const p = value as PendingWebhookDeploy; const r = p?.request;
  if (!p || !r || !string(p.operationId) || !/^op_[a-zA-Z0-9_.-]+$/.test(p.operationId) || !string(p.branchId)
      || !Number.isSafeInteger(p.generation) || p.generation < 1 || !Number.isSafeInteger(p.mergedCount) || p.mergedCount < 1
      || typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt))
      || r.branchId !== p.branchId || !string(r.projectId) || !['manual', 'webhook'].includes(r.trigger)
      || !((r.kind === 'deploy' && !r.profileId) || (r.kind === 'deploy-profile' && string(r.profileId)))
      || r.versionId || r.hasOneShotOptions || (r.commitSha != null && !/^[0-9a-f]{7,40}$/i.test(r.commitSha))) return false;
  const allowed = new Set(['branchId', 'projectId', 'profileId', 'kind', 'trigger', 'actor', 'requestId', 'commitSha', 'versionId', 'hasOneShotOptions', 'commitPinned', 'configHash', 'pendingConfigHash', 'source', 'reason', 'continueWith']);
  if (Object.keys(r).some(k => !allowed.has(k)) || Object.keys(p).some(k => !['operationId', 'branchId', 'generation', 'request', 'mergedCount', 'updatedAt'].includes(k))) return false;
  return Object.entries(r).every(([k, v]) => v == null || (k === 'commitPinned' || k === 'hasOneShotOptions' ? typeof v === 'boolean' : string(v, k === 'reason' ? 2048 : 256)));
}
function parseData(value: unknown): PendingJournalData {
  const d = value as PendingJournalData;
  if (!d || d.version !== 1 || Object.keys(d).some(k => !['version', 'queued', 'claims'].includes(k)) || !Array.isArray(d.queued) || !Array.isArray(d.claims)
      || d.queued.length > PENDING_JOURNAL_LIMITS.queued || d.claims.length > PENDING_JOURNAL_LIMITS.claims || !d.queued.every(validPending)) throw new Error('pending_journal_schema');
  const keys = new Set<string>(); const ids = new Set<string>(); const branches = new Map<string, number>();
  for (const p of d.queued) {
    if (keys.has(key(p)) || ids.has(id(p))) throw new Error('pending_journal_duplicate');
    keys.add(key(p)); ids.add(id(p)); const count = (branches.get(p.branchId) || 0) + 1; branches.set(p.branchId, count);
    if (count > PENDING_JOURNAL_LIMITS.branchQueued) throw new Error('pending_journal_capacity');
  }
  for (const c of d.claims) {
    if (!c || Object.keys(c).some(k => !['pending', 'phase', 'claimedAt', 'result'].includes(k)) || !validPending(c.pending)
        || !['claimed', 'unknown', 'accepted'].includes(c.phase) || typeof c.claimedAt !== 'string' || !Number.isFinite(Date.parse(c.claimedAt)) || ids.has(id(c.pending))) throw new Error('pending_journal_claim');
    if (c.result && (Object.keys(c.result).some(k => !['outcome', 'reason', 'httpStatus', 'deploymentRunId'].includes(k))
      || !['completed', 'accepted', 'failed', 'cancelled', 'unknown'].includes(c.result.outcome) || !string(c.result.reason, 64)
      || (c.result.deploymentRunId != null && !/^dr_[a-zA-Z0-9_.-]{1,120}$/.test(c.result.deploymentRunId))
      || (c.result.httpStatus != null && (!Number.isInteger(c.result.httpStatus) || c.result.httpStatus < 100 || c.result.httpStatus > 599)))) throw new Error('pending_journal_result');
    ids.add(id(c.pending));
  }
  if (Buffer.byteLength(JSON.stringify(d)) > PENDING_JOURNAL_LIMITS.bytes) throw new Error('pending_journal_size');
  return copy(d);
}
const branchWide = (r: BranchOperationRequest) => !r.profileId || !['deploy-profile', 'force-rebuild', 'auto-restart'].includes(r.kind);
const conflict = (a: BranchOperationRequest, b: BranchOperationRequest) => a.branchId === b.branchId && (branchWide(a) || branchWide(b) || a.profileId === b.profileId);

/** One Master owns this file. Recovered intents are retained, never automatically replayed. */
export class PendingDeployJournal {
  private data: PendingJournalData = { version: 1, queued: [], claims: [] };
  private recovered = new Set<string>();
  private unavailable = false;
  private loaded = false;
  private loading?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private writes = 0;
  constructor(private readonly io: PendingJournalIO) {}
  ready(): Promise<void> {
    return this.loading ||= this.bounded(Promise.resolve().then(() => this.io.load()), PENDING_JOURNAL_LIMITS.ioMs).then(raw => {
      this.data = raw == null ? { version: 1, queued: [], claims: [] } : parseData(raw);
      this.recovered = new Set([...this.data.queued, ...this.data.claims.map(c => c.pending)].map(id)); this.loaded = true;
    }).catch(() => { this.unavailable = true; this.loaded = true; });
  }
  isAvailable(): boolean { return this.loaded && !this.unavailable; }
  snapshot(): PendingJournalData { return copy(this.data); }
  queued(): PendingWebhookDeploy[] { return copy(this.data.queued); }
  requireRecovery(pending: PendingWebhookDeploy): void {
    if ([...this.data.queued, ...this.data.claims.map(row => row.pending)].some(row => id(row) === id(pending))) this.recovered.add(id(pending));
  }
  /** Read only acknowledged metadata; never copy requests or poll the executor. */
  getStatus(projectId: string, branchId: string): PendingDeploymentStatus {
    const scoped = (p: PendingWebhookDeploy) => p.branchId === branchId && p.request.projectId === projectId;
    const rows = [
      ...this.data.queued.filter(scoped).map(pending => ({ pending, phase: 'queued' as const })),
      ...this.data.claims.filter(c => scoped(c.pending)),
    ];
    const needsRecovery = (row: typeof rows[number]) => this.recovered.has(id(row.pending)) || row.phase === 'unknown';
    return {
      availability: !this.loaded ? 'loading' : this.unavailable ? 'unavailable' : 'ready',
      recoveryRequired: !this.isAvailable() || rows.some(needsRecovery),
      total: rows.length, truncated: rows.length > 128,
      entries: rows.slice(0, 128).map(row => ({
        operationId: row.pending.operationId, generation: row.pending.generation,
        profileId: row.pending.request.profileId || null, trigger: row.pending.request.trigger,
        commitSha: row.pending.request.commitSha || null,
        commitPinned: typeof row.pending.request.commitPinned === 'boolean' ? row.pending.request.commitPinned : null,
        updatedAt: row.pending.updatedAt, mergedCount: row.pending.mergedCount,
        phase: row.phase, recoveryRequired: needsRecovery(row),
        ...('result' in row && row.result?.deploymentRunId ? { deploymentRunId: row.result.deploymentRunId } : {}),
      })),
    };
  }
  blockReason(request: BranchOperationRequest): string | null {
    // Explicit stop can still stop the published graph; it does not prove unknown claims ended.
    if (request.kind === 'stop' || request.kind === 'candidate-reconcile') return null;
    if (!this.loaded || this.unavailable) return 'pending_journal_unavailable';
    const rows = [...this.data.queued.filter(p => this.recovered.has(id(p))),
      ...this.data.claims.filter(c => this.recovered.has(id(c.pending)) || c.phase === 'unknown').map(c => c.pending)];
    return rows.some(p => conflict(request, p.request)) ? 'pending_recovery_required' : null;
  }
  upsert(pending: PendingWebhookDeploy): Promise<void> {
    const frozen = copy(pending);
    if (!validPending(frozen)) return Promise.reject(new Error('pending_intent_invalid'));
    return this.change(d => {
      const at = d.queued.findIndex(p => key(p) === key(frozen));
      if (at < 0 && (d.queued.length >= PENDING_JOURNAL_LIMITS.queued || d.queued.filter(p => p.branchId === frozen.branchId).length >= PENDING_JOURNAL_LIMITS.branchQueued)) throw new Error('pending_journal_capacity');
      if (d.claims.some(c => id(c.pending) === id(frozen))) throw new Error('pending_claim_not_queueable');
      if (at < 0) d.queued.push(frozen); else d.queued[at] = frozen;
    });
  }
  claim(pending: PendingWebhookDeploy): Promise<boolean> {
    const frozen = copy(pending); let claimed = false;
    return this.change(d => {
      const at = d.queued.findIndex(p => id(p) === id(frozen) && key(p) === key(frozen));
      if (at < 0 || this.recovered.has(id(frozen))) return;
      if (d.claims.length >= PENDING_JOURNAL_LIMITS.claims) throw new Error('pending_claim_capacity');
      d.claims.push({ pending: d.queued.splice(at, 1)[0], phase: 'claimed', claimedAt: new Date().toISOString() }); claimed = true;
    }).then(() => claimed);
  }
  cancel(pending: PendingWebhookDeploy, sent = false): Promise<void> {
    const frozen = copy(pending);
    return this.change(d => {
      if (this.recovered.has(id(frozen))) return;
      d.queued = d.queued.filter(p => id(p) !== id(frozen));
      const c = d.claims.find(c => id(c.pending) === id(frozen));
      if (sent && c) c.phase = 'unknown'; else d.claims = d.claims.filter(c => id(c.pending) !== id(frozen));
    });
  }
  settle(pending: PendingWebhookDeploy, result: PendingDeployDispatchResult): Promise<void> {
    const frozen = copy(pending); const boundedResult = copy(result);
    return this.change(d => {
      const c = d.claims.find(c => id(c.pending) === id(frozen)); if (!c) return;
      if (result.outcome === 'completed' || result.outcome === 'failed' || result.outcome === 'cancelled') d.claims = d.claims.filter(other => other !== c);
      else { c.phase = result.outcome === 'accepted' ? 'accepted' : 'unknown'; c.result = boundedResult; }
    });
  }
  private change(mutate: (draft: PendingJournalData) => void): Promise<void> {
    if (!this.loaded || this.unavailable || this.writes >= PENDING_JOURNAL_LIMITS.writes) return Promise.reject(new Error('pending_journal_unavailable'));
    this.writes++; const started = Date.now();
    const operation = this.tail.then(async () => {
      if (this.unavailable || Date.now() - started >= PENDING_JOURNAL_LIMITS.transactionMs) throw new Error('pending_journal_unavailable');
      const draft = copy(this.data); mutate(draft); parseData(draft);
      if (JSON.stringify(draft) === JSON.stringify(this.data)) return;
      try { await this.bounded(this.io.save(draft), Math.min(PENDING_JOURNAL_LIMITS.ioMs, PENDING_JOURNAL_LIMITS.transactionMs - (Date.now() - started))); }
      catch { this.unavailable = true; throw new Error('pending_journal_write_unknown'); }
      this.data = draft;
    }).finally(() => { this.writes--; });
    this.tail = operation.catch(() => {});
    // Waiting for other transactions is part of the same acceptance deadline.
    return this.bounded(operation, PENDING_JOURNAL_LIMITS.transactionMs);
  }
  private bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('pending_journal_timeout')), ms); })]).finally(() => clearTimeout(timer));
  }
}

const fallback = new ShellExecutor({ maxConcurrent: 1, maxQueued: 32 });
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
const READ = `// pending-deploy-journal-read
const fs=require('node:fs');let fd;
try{fd=fs.openSync(process.argv[1],'r');const b=Buffer.alloc(Number(process.argv[2])+1);let n=0,c;
while(n<b.length&&(c=fs.readSync(fd,b,n,b.length-n,null))>0)n+=c;
if(n>Number(process.argv[2]))throw Error('size');process.stdout.write(JSON.stringify(JSON.parse(b.subarray(0,n).toString('utf8'))));
}catch(e){if(e.code==='ENOENT')process.stdout.write('null');else process.exitCode=1;}finally{if(fd!=null)fs.closeSync(fd);}`;
const WRITE = `// pending-deploy-journal-write
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const target=process.argv[1],dir=path.dirname(target),tmp=target+'.tmp.'+process.pid+'.'+crypto.randomUUID();let fd;
try{const raw=fs.readFileSync(0);if(raw.length>Number(process.argv[2]))throw Error('size');JSON.parse(raw);
fs.mkdirSync(dir,{recursive:true});fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,raw);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
fs.renameSync(tmp,target);fd=fs.openSync(dir,'r');fs.fsyncSync(fd);
}catch{process.exitCode=1;}finally{if(fd!=null)fs.closeSync(fd);try{fs.rmSync(tmp,{force:true});}catch{}}`;
export function pendingJournalFileIO(filePath: string, shell: IShellExecutor = fallback): PendingJournalIO {
  const command = (script: string) => [process.execPath, '-e', script, filePath, String(PENDING_JOURNAL_LIMITS.bytes)].map(quote).join(' ');
  const opts = { timeout: PENDING_JOURNAL_LIMITS.ioMs, priority: 'delivery' as const, schedulingGroup: 'pending-journal' };
  return {
    load: async () => { const r = await shell.exec(command(READ), opts); if (r.exitCode !== 0 || Buffer.byteLength(r.stdout) > PENDING_JOURNAL_LIMITS.bytes) throw new Error('pending_journal_read'); return JSON.parse(r.stdout); },
    save: async d => { const r = await shell.exec(command(WRITE), { ...opts, stdin: JSON.stringify(d) }); if (r.exitCode !== 0) throw new Error('pending_journal_write'); },
  };
}
