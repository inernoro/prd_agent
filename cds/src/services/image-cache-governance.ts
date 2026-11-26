import type { IShellExecutor } from '../types.js';
import { shellQuoteArg } from './secure-database-cli.js';
import { IMAGE_CACHE_PROGRAM, IMAGE_CACHE_PULL_RECEIPT_WINDOW_MS } from './image-cache-program.js';
import { reclaimLock } from './reclaim-lock.js';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveBranchProtection } from './branch-protection.js';
import { readDeploymentIntent } from './deployment-intent.js';
import { deploymentInputBranch } from './deployment-input.js';
import { selectDefaultRollbackVersion } from './deployment-version-selection.js';
import { releaseBatchProtectsInputs } from '../domain/release-batch.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { resumedReclaimExecution, recordReclaimExecution, type ReclaimExecutionJournal } from './reclaim-execution-journal.js';

export class ImageCacheBudgetError extends Error {}
export class ImageCachePullSlotLimitError extends Error {}
const IMAGE_CACHE_REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_CACHE_LOCK_RETRY_MS = 150;
const NATIVE_PULL_LIMIT_MS = 90_000;
const NATIVE_PULL_STARTUP_WINDOW_MS = 9_000;

type NativePullOutcome = 'success' | 'missing' | 'access-denied' | 'verification-unavailable';
interface PullSettlement {
  identity: string;
  outcome: NativePullOutcome | 'never-started';
  source: 'caller' | 'scheduled';
  reservedBytesEstimate: number;
}
interface PullBudget {
  reservedBytes: number;
  overdueCount: number;
  overdueReservedBytes: number;
  availableBytes: number | null;
  peakBytes: number;
  headroom: 'normal' | 'low' | 'blocked' | null;
}

export class ImageCacheGovernance {
  private execution: { id: string; status: string; startedAt: string; report?: any; error?: string } | null = null;
  private overdue = false;
  private headroom: 'normal' | 'low' | 'blocked' = 'normal';
  constructor(readonly options: { shell: IShellExecutor; catalog: string; instanceId: string; budgetBytes: number; protectedReferences: () => string[]; peakBytes?: number; audit?: ServerEventLogSink | null; journal?: ReclaimExecutionJournal }) { this.execution = resumedReclaimExecution(options.journal); }
  private persist() { recordReclaimExecution(this.options.journal, this.execution); }
  private async registryManifest(reference: string, audit: ReturnType<typeof createExternalResponseAudit>) {
    audit.assertAvailable();const started = Date.now();let result: Awaited<ReturnType<IShellExecutor['exec']>> | undefined;
    try { result = await this.options.shell.exec(`docker manifest inspect ${shellQuoteArg(reference)}`, { executionLane: 'observation', timeout: 8000 }); } catch { /* No response remains distinct from native CLI diagnostics. */ }
    let parsed: any;try { parsed = result?.exitCode === 0 ? JSON.parse(result.stdout) : undefined; } catch { /* Audit preserves malformed response evidence. */ }
    const target = reference.split('@')[0], slash=target.indexOf('/'), registry=slash<0?'registry-1.docker.io':target.slice(0,slash);
    await audit.record({ peerId: registry, url: `oci://${registry}/${target.slice(slash+1)}@${reference.split('@')[1]}`,
      method: 'docker manifest inspect', startedAt: new Date(started).toISOString(), durationMs: Date.now()-started, timeoutMs: 8000,
      responseReceived: Boolean(parsed), httpStatus: null, contentType: parsed ? 'application/json' : null, upstreamRequestId: null,
      text: result?.exitCode === 0 ? result.stdout : result?.stderr || '', json: parsed,
      parseState: parsed ? 'json' : result ? 'native-cli-diagnostic' : 'no-cli-response', localDecision: parsed ? 'success' : 'registry-proof-unconfirmed',
      error: parsed ? undefined : 'Native CLI does not expose HTTP status/headers; no HTTP response fact is inferred.', secrets: [] });
    if (!parsed) throw new Error('registry 返回未确认，相关镜像已保留；可在系统事件查询脱敏响应证据。');
    return parsed;
  }
  private async recoveryProofs(reference: string, platform: { os: string; architecture: string }, audit: ReturnType<typeof createExternalResponseAudit>) {
    const manifest = await this.registryManifest(reference, audit);
    const proofs: Record<string, unknown> = { [reference]: { manifest, verifiedAt: Date.now() } };
    if (Array.isArray(manifest.manifests)) {
      const matches = manifest.manifests.filter((item: any) => item.platform?.os === platform.os && item.platform?.architecture === platform.architecture);
      if (!matches.length || matches.length > 4) throw new Error('镜像平台清单未完整确认。');
      for (const item of matches) {
        const child = reference.split('@')[0] + '@' + item.digest;
        proofs[child] = { manifest: await this.registryManifest(child, audit), verifiedAt: Date.now() };
      }
    }
    return proofs;
  }
  async adopt(input: { identity: string; created: string; aliases: string[]; digests: string[]; projectId: string; ownershipEvidence: string; attestedBy: string; dataDisposition: 'reproducible-artifact' }) {
    const preview = await this.inspect();
    const row = preview.held.find((item: any) => item.identity === input.identity);
    if (!row || row.reason !== 'legacy-image-ownership-needs-review' || !row.digests.length
      || row.created !== input.created || JSON.stringify([...row.aliases].sort()) !== JSON.stringify([...input.aliases].sort())
      || JSON.stringify([...row.digests].sort()) !== JSON.stringify([...input.digests].sort())) throw new Error('预览后的镜像身份或别名已变化，请重新盘点。');
    const audit = createExternalResponseAudit(this.options.audit, { projectId: '__system', remoteProjectId: 'registry', policy: 'host-image-cache-adoption', dryRun: false },
      { source: 'image-cache-registry-audit', action: 'image-cache.registry.response', message: '历史镜像归属与 registry 内容核对' });
    const registryProofs = await this.recoveryProofs(row.digests[0], preview.platform, audit);
    return this.request('adopt', { ...input, registryProofs, registryAuditId: audit.operationId });
  }
  async request(action: string, input: Record<string, unknown> | ((remainingMs: number) => Record<string, unknown>) = {}, assertCurrent: () => void = () => {}, limitMs = IMAGE_CACHE_REQUEST_TIMEOUT_MS) {
    const loader = `import base64;exec(base64.b64decode("${Buffer.from(IMAGE_CACHE_PROGRAM).toString('base64')}"))`;
    const command = `python3 -c ${shellQuoteArg(loader)}`;
    const deadline = performance.now() + limitMs;
    let result: Awaited<ReturnType<IShellExecutor['exec']>> | undefined;
    while (performance.now() < deadline) {
      assertCurrent();
      const timeout = Math.floor(deadline - performance.now());
      if (timeout <= 0) break;
      const payload = typeof input === 'function' ? input(timeout) : input;
      result = await this.options.shell.exec(command, {
        stdin: JSON.stringify({ ...payload, action, catalog: this.options.catalog, instanceId: this.options.instanceId, budgetBytes: this.options.budgetBytes, peakBytes: this.options.peakBytes }),
        executionLane: action === 'preview' ? 'observation' : 'operation',
        timeout,
        beforeStart: assertCurrent,
      });
      // Native exit 3 means the catalog lock rejected the request before any write.
      // An expired native caller still needs the token to fence a reservation that never started.
      const reservedNativePull = action === 'prepare' && payload.nativePull === true && result.exitCode === 0;
      if (!reservedNativePull && (action !== 'execute-pull' || result.exitCode === 3)) assertCurrent();
      if (result.exitCode !== 3) break;
      const wait = Math.min(IMAGE_CACHE_LOCK_RETRY_MS, deadline - performance.now());
      if (wait > 0) await delay(wait);
    }
    if (result && result.exitCode !== 0 && result.stderr.includes('ValueError: host-image-cache-budget-exceeded')) throw new ImageCacheBudgetError('宿主镜像总量预算不足，等待回收或容量调整。');
    if (result && result.exitCode !== 0 && result.stderr.includes('ValueError: unsettled-image-pull-budget-reached')) {
      throw new ImageCachePullSlotLimitError('宿主未结清拉取笔数达到上限。');
    }
    if (result?.exitCode !== 0 || result.stdout.length > 4 * 1024 * 1024) throw new Error('镜像总量预算、对象身份或引用未确认，未允许新的大批量拉取或删除。');
    try { return JSON.parse(result.stdout); } catch { throw new Error('镜像盘点不完整，不能判断零占用。'); }
  }
  async publish(assertCurrent?: () => void) { return this.request('publish', () => ({ references: this.options.protectedReferences() }), assertCurrent); }
  async prepare(image: string, assertCurrent: () => void, requirePresent = false, forceNew = false, nativePull = false,
    reuseVerifiedRevision?: string) {
    await this.publish(assertCurrent);
    return this.request('prepare', { image, requirePresent, forceNew, nativePull, reuseVerifiedRevision }, assertCurrent);
  }
  confirm(token: string, assertCurrent: () => void) { return this.request('confirm', { token }, assertCurrent); }
  abort(token: string, assertCurrent: () => void, completedNativeOperation = false) { return this.request('abort', { token, completedNativeOperation }, assertCurrent); }
  async executePull(token: string, image: string, assertCurrent: () => void, remainingMs?: () => number): Promise<{ outcome: NativePullOutcome; recorded: boolean }> {
    const limit = Math.min(remainingMs?.() ?? Infinity, NATIVE_PULL_LIMIT_MS + NATIVE_PULL_STARTUP_WINDOW_MS + IMAGE_CACHE_PULL_RECEIPT_WINDOW_MS);
    return this.request('execute-pull', remaining => ({
      token, image, pullTimeoutMs: NATIVE_PULL_LIMIT_MS,
      pullDeadlineMs: Date.now() + remaining,
    }), assertCurrent, limit);
  }
  async settlePulls(token?: string, releaseUnstarted = false): Promise<PullSettlement[]> {
    const result: { settled: PullSettlement[] } = await this.request('settle-pulls',
      token ? { token, releaseUnstarted } : {}, undefined, releaseUnstarted ? 3_000 : IMAGE_CACHE_REQUEST_TIMEOUT_MS);
    if (!token && result.settled.length) {
      this.options.audit?.record({
        category: 'system', severity: 'info', source: 'image-cache-retention', action: 'image.cache.pulls.settled',
        message: '宿主已自动结清有证据的拉取预留。', status: 'success', details: { settlements: result.settled },
      });
    }
    return result.settled;
  }
  observePullBudget(budget?: PullBudget): void {
    if (!budget?.headroom) return;
    const overdue = budget.overdueCount > 0;
    if (overdue !== this.overdue) {
      this.recordPullAlert('overdue', overdue ? 'warn' : 'info', overdue
        ? `有 ${budget.overdueCount} 笔镜像拉取预留超时未确认。请在宿主镜像总量与引用中核对回执。`
        : '镜像拉取预留超时告警已恢复。', { ...budget });
      this.overdue = overdue;
    }
    const { headroom } = budget;
    if (headroom !== this.headroom) {
      this.recordPullAlert('headroom', headroom === 'blocked' ? 'error' : headroom === 'low' ? 'warn' : 'info',
        headroom === 'blocked' ? '镜像预算不足以接纳一次新拉取。请核对未结清预留和可回收镜像。'
          : headroom === 'low' ? '镜像拉取余量低于两次峰值预留，请核对宿主镜像预算。' : '镜像拉取余量告警已恢复。',
        { ...budget });
      this.headroom = headroom;
    }
  }
  private recordPullAlert(kind: string, severity: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) {
    this.options.audit?.record({ category: 'system', severity, source: 'image-cache-retention',
      action: `image.cache.pull.${kind}.${severity === 'info' ? 'recovered' : 'alert'}`, message, details });
  }
  async inspect(dryRun = true, alreadyLocked = false, executionId?: string) {
    if (!dryRun && !this.options.budgetBytes) throw new Error('宿主总量策略尚未启用。');
    const run = async () => {
      if (dryRun) return this.request('preview', { references: this.options.protectedReferences() });
      await this.publish();
      const preview = await this.request('preview', { references: this.options.protectedReferences() });
      const batch: any[] = preview.nextBatch || [];
      const audit = createExternalResponseAudit(this.options.audit, { projectId: '__system', remoteProjectId: 'registry', policy: 'host-image-cache', dryRun: false },
        { source: 'image-cache-registry-audit', action: 'image-cache.registry.response', message: '镜像回收 registry 清单一致性证据' });
      const proofs: Record<string,unknown> = {}, failed: Array<{identity:string;reason:string}> = [];
      for (const item of batch) {
        try {
          Object.assign(proofs, await this.recoveryProofs(item.recoveryDigests[0], preview.platform, audit));
        } catch { failed.push({ identity:item.identity, reason:'registry 清单或持久审计未确认，已保留' }); }
      }
      const report = await this.request('reconcile', () => ({ maxRemovals:2, targetIdentities:batch.filter(item=>!failed.some(f=>f.identity===item.identity)).map(item=>item.identity), attemptedIdentities:batch.map(item=>item.identity), registryProofs:proofs,
        registryAuditId:audit.operationId, references:this.options.protectedReferences(),...(executionId?{executionId}:{}) }));
      const retainedFailures=failed.filter(f=>!report.held.some((row:any)=>row.identity===f.identity));
      report.pending=report.pending.filter((id:string)=>!retainedFailures.some(f=>f.identity===id));report.counts.pending=report.pending.length;
      report.failed.push(...retainedFailures);report.counts.failed=report.failed.length;if(retainedFailures.length)report.scanStatus='partial';report.registryAuditId=audit.operationId;return report;
    };
    return dryRun || alreadyLocked ? run() : reclaimLock.run('host-image-cache', run);
  }
  getSnapshot() { return structuredClone(this.execution); }
  startReconcile() {
    if (this.execution?.status === 'running' || reclaimLock.getState().holder) throw new Error('回收正在执行。');
    const id = randomBytes(16).toString('hex');this.execution = { id, status: 'running', startedAt: new Date().toISOString() };
    this.persist();
    void this.inspect(false, false, id).then(report => { if(this.execution?.id===id)Object.assign(this.execution,{status:'completed',report}); this.persist(); },()=>{if(this.execution?.id===id)Object.assign(this.execution,{status:'failed',error:'镜像回收未完成，未知对象已保留。'}); this.persist(); });
    return this.getSnapshot();
  }
  async cancel(id: string) {
    if (this.execution?.id !== id || this.execution.status !== 'running') throw new Error('回收任务已结束或身份已变化。');
    return this.request('cancel', { executionId: id });
  }
}
let configured: ImageCacheGovernance | undefined;
export function configureImageCacheGovernance(service: ImageCacheGovernance | undefined) { configured = service; }
export function configuredImageCacheGovernance() { return configured; }

/** Local cache residency is separate from the immutable version ledger used to re-pull rollbacks. */
export function collectImageCacheReferences(state: import('./state.js').StateService, pinned: readonly string[] = [], keepGenerations = 5, idleDays = 7, nowMs = Date.now(), resolveImage: (profile: import('../types.js').BuildProfile, branch: import('../types.js').BranchEntry) => string = profile => profile.dockerImage): string[] {
  const references: string[] = [];
  const groups = new Map<string, string[]>();
  const versions = [...state.getDeploymentVersions()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const batchVersions = new Set(state.getReleaseBatches().filter(releaseBatchProtectsInputs).map(batch => batch.versionId));
  if ([...batchVersions].some(id => !versions.some(version => version.id === id))) throw new Error('固定批次的版本或镜像引用未确认，保持镜像保护。');
  const byBranch = new Map<string, typeof versions>();
  for (const version of versions) { const entries = byBranch.get(version.branchId) || [];entries.push(version);byBranch.set(version.branchId, entries); }
  const rollbacks = new Set<string>();
  for (const [branchId, entries] of byBranch) {
    const branch = state.getBranch(branchId);
    const rollback = branch && selectDefaultRollbackVersion(entries, branch.currentVersionId);
    if (rollback) rollbacks.add(rollback.id);
  }
  for (const version of versions) {
    const branch = state.getBranch(version.branchId);
    const last = branch?.lastAccessedAt ? Date.parse(branch.lastAccessedAt) : NaN;
    const idle = branch && !resolveBranchProtection(branch, state, pinned).protected && ['idle','error'].includes(branch.status)
      && Number.isFinite(last) && nowMs-last>idleDays*86_400_000;
    for (const profile of Object.values(version.profiles || {})) {
      if (!profile.artifactImage) continue;
      if (branch?.currentVersionId === version.id || rollbacks.has(version.id) || batchVersions.has(version.id)) references.push(profile.artifactImage);
      const key = JSON.stringify([version.projectId,version.branchId,profile.profileId]);
      const kept=groups.get(key)||[];
      if (!kept.includes(profile.artifactImage) && kept.length<(idle?Math.min(2,keepGenerations):keepGenerations)) { kept.push(profile.artifactImage);references.push(profile.artifactImage);groups.set(key,kept); }
    }
  }
  for(const intent of state.getDeploymentIntents()) {
    const run=state.getDeploymentRun(intent.runId);
    if(!run)throw new Error('恢复记录的镜像引用未确认。');
    const input=readDeploymentIntent(run,intent,'image-protection',intent.keyScope === 'node' ? state.getDeploymentIntentKeyDirectory() : undefined);
    const branch=state.getBranch(intent.request.branchId);
    if(!branch)throw new Error('在途部署归属未确认。');
    const captured=deploymentInputBranch(input,branch);
    references.push(...input.profiles.map(profile=>resolveImage(profile,captured)).filter(Boolean));
    references.push(...(input.artifactAdmission?.artifacts||[]).flatMap(artifact=>[artifact.selectedImage||artifact.requestedImage,artifact.image]));
  }
  return [...new Set(references)];
}
