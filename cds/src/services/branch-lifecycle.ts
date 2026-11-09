import type { BranchEntry } from '../types.js';
import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { resolveBranchProtection } from './branch-protection.js';
import { serviceRuntimeRefs } from './service-runtime.js';
import { branchEvents } from './branch-events.js';
import { forgetConfirmedStoppedContainers } from './resource-usage-sampler.js';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { isLoopbackAddress } from './self-check-auth.js';

const STOP_SCHEME = 'CDS-Lifecycle-Stop ';
type StopScope = { branchId: string; projectId: string; createdAt: string; sha?: string; pushedAt?: string; startedAt?: string; readyAt?: string; reason: string; route: string; port: number; issuedAt: number };
// 同进程一次性能力，不使用人类凭据、不落盘，不能授权通用内部请求。
const lifecycleStops = new Map<string, StopScope>();

export function lifecycleStopGate(state: StateService): { gate: RequestHandler; isTrusted: (req: Request) => boolean } {
  const trusted = new WeakSet<Request>();
  const gate: RequestHandler = (req, res, next) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith(STOP_SCHEME)) return next();
    const token = auth.slice(STOP_SCHEME.length), scope = lifecycleStops.get(token);
    lifecycleStops.delete(token);
    const branch = scope && state.getBranch(scope.branchId);
    if (!scope || !branch || req.method !== 'POST' || !isLoopbackAddress(req.socket.remoteAddress)
      || req.socket.localPort !== scope.port || req.originalUrl !== scope.route
      || Date.now() < scope.issuedAt || Date.now() - scope.issuedAt > 30_000
      || (branch.projectId || 'default') !== scope.projectId || branch.createdAt !== scope.createdAt || branch.githubCommitSha !== scope.sha || branch.lastPushAt !== scope.pushedAt
      || branch.lastDeployStartedAt !== scope.startedAt || branch.lastReadyAt !== scope.readyAt
      || req.headers['x-cds-source-project-id'] !== scope.projectId || req.headers['x-cds-source-branch-id'] !== scope.branchId
      || req.headers['x-cds-internal'] !== '1' || req.headers['x-cds-trigger'] !== 'auto-lifecycle'
      || !req.body || Object.keys(req.body).length !== 1 || req.body.lifecycleReason !== scope.reason) {
      res.status(401).json({ error: 'invalid_lifecycle_stop' }); return;
    }
    trusted.add(req); next();
  };
  return { gate, isTrusted: req => trusted.has(req) };
}

/** 与控制面使用同一个鉴权、取消部署、停止副本及日志保留入口。 */
export async function stopBranchForLifecycle(baseUrl: string, branch: BranchEntry, reason: 'startup-timeout' | 'archive'): Promise<void> {
  const target = new URL(`${baseUrl}/api/branches/${encodeURIComponent(branch.id)}/stop`);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.search || target.hash) throw new Error('生命周期停止仅允许同进程回环地址');
  const token = randomUUID(), projectId = branch.projectId || 'default';
  lifecycleStops.set(token, { branchId: branch.id, projectId, createdAt: branch.createdAt, sha: branch.githubCommitSha, pushedAt: branch.lastPushAt,
    startedAt: branch.lastDeployStartedAt, readyAt: branch.lastReadyAt, reason, route: target.pathname, port: Number(target.port), issuedAt: Date.now() });
  const stoppedNames = [...Object.values(branch.services).flatMap(service => serviceRuntimeRefs(service).map(runtime => runtime.containerName)),
    ...Object.values(branch.replicaSets || {}).flatMap(set => set.members.map(member => member.containerName).filter((name): name is string => !!name))];
  try {
    const response = await fetch(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDS-Internal': '1', 'X-CDS-Trigger': 'auto-lifecycle',
        'X-CDS-Source-Project-Id': projectId, 'X-CDS-Source-Branch-Id': branch.id, Authorization: STOP_SCHEME + token },
      body: JSON.stringify({ lifecycleReason: reason }), signal: AbortSignal.timeout(120_000),
    });
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error('分支停止未完成，请稍后查看操作记录');
    forgetConfirmedStoppedContainers(stoppedNames);
  } finally { lifecycleStops.delete(token); }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export type BranchCleanupMode = 'incomplete' | 'all';
export const BRANCH_LIFECYCLE_DEFAULTS = { incompleteTimeoutMs: 30 * MINUTE, neverPreviewedArchiveMs: DAY, archiveRetentionMs: 30 * DAY };
type LifecycleOptions = {
  state: StateService;
  stop: (branch: BranchEntry, reason: 'startup-timeout' | 'archive') => Promise<void>;
  remove: (branchId: string) => Promise<void>;
  /** null 是观测未知，不能据此归档或宣布已停止。 */
  observed: () => ReadonlySet<string> | null;
  active: (branchId: string) => boolean;
  canInterruptStartup?: (branchId: string) => boolean;
  expectedProfiles?: (branch: BranchEntry) => string[];
  pinnedBranches?: string[];
  audit?: ServerEventLogSink | null;
  clock?: () => number;
  policy?: Partial<typeof BRANCH_LIFECYCLE_DEFAULTS>;
  flush?: () => Promise<void>;
  paused?: () => boolean;
  lock?: (branch: BranchEntry) => { assertCurrent: () => void; release: (failed?: boolean) => void };
};

/** 状态与实际驻留共同决定资源占用，不用 CI 终态猜容器是否在跑。 */
export function hasBranchRuntime(branch: BranchEntry, observed?: ReadonlySet<string> | null): boolean {
  return Object.values(branch.services || {}).some(service => ['running', 'building', 'starting', 'restarting', 'stopping'].includes(service.status)
    || serviceRuntimeRefs(service).some(runtime => observed?.has(runtime.containerName)))
    || Object.values(branch.replicaSets || {}).some(set => set.members.some(member =>
      ['running', 'starting', 'provisioning', 'stopping'].includes(member.status) || !!member.containerName && !!observed?.has(member.containerName)));
}

export function branchCompletelyStarted(branch: BranchEntry, expected: string[] = Object.keys(branch.services || {})): boolean {
  return expected.length > 0 && expected.every(id => branch.services?.[id]?.status === 'running')
    && Object.values(branch.replicaSets || {}).every(set => !set.enabled || set.members.every(member => member.status === 'running'))
    && !['building', 'starting', 'restarting', 'stopping', 'error'].includes(branch.status);
}

export class BranchLifecycleService {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private cycle?: Promise<void>;
  private pending = new Set<string>();
  readonly policy: typeof BRANCH_LIFECYCLE_DEFAULTS;
  private readonly now: () => number;
  constructor(private readonly options: LifecycleOptions) {
    this.policy = { ...BRANCH_LIFECYCLE_DEFAULTS, ...options.policy };
    this.now = options.clock || Date.now;
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { if (!this.sweeping) this.cycle = this.sweep(); }, MINUTE); this.timer.unref?.(); } }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.cycle; }
  private protection(branch: BranchEntry): string | null {
    if (branch.mirror) return '只读镜像分支';
    if (this.options.state.getProject(branch.projectId)?.kind === 'shared-service') return '共享服务项目';
    const result = resolveBranchProtection(branch, this.options.state, this.options.pinnedBranches);
    return result.protected ? result.reason : null;
  }
  private complete(branch: BranchEntry): boolean {
    const expected = this.options.expectedProfiles?.(branch);
    return branchCompletelyStarted(branch, expected?.length ? expected : undefined);
  }
  preview(projectId: string, mode: BranchCleanupMode) {
    const candidates: Array<{ id: string; branch: string; running: boolean }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const branch of this.options.state.getAllBranches()) {
      if ((branch.projectId || 'default') !== projectId || branch.archive) continue;
      const reason = this.protection(branch) || (this.options.active(branch.id) ? '同分支操作进行中' : null)
        || (this.pending.has(branch.id) ? '清理正在执行' : null);
      if (reason) { skipped.push({ id: branch.id, reason }); continue; }
      if (mode === 'incomplete' && this.complete(branch)) continue;
      candidates.push({ id: branch.id, branch: branch.branch, running: hasBranchRuntime(branch, this.options.observed()) });
    }
    return { candidates, skipped, retentionDays: 30 };
  }
  async cleanup(projectId: string, mode: BranchCleanupMode, actor: string) {
    const plan = this.preview(projectId, mode);
    const archived: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const candidate of plan.candidates) {
      const current = this.options.state.getBranch(candidate.id);
      if (mode === 'incomplete' && current && this.complete(current)) {
        plan.skipped.push({ id: candidate.id, reason: '分支已完全启动，跳过' }); continue;
      }
      try { await this.archive(candidate.id, `手动清理${mode === 'all' ? '所有普通分支' : '未完全启动分支'}`, actor); archived.push(candidate.id); }
      catch (error) { failed.push({ id: candidate.id, reason: error instanceof Error ? error.message : '归档未完成' }); }
    }
    return { archivedCount: archived.length, archived, skipped: plan.skipped, failed };
  }
  private async persist(branch: BranchEntry, action: 'archived' | 'restored' | 'startup-stopped', reason: string, actor: string): Promise<void> {
    this.options.state.appendActivityLog(branch.projectId, { type: action === 'startup-stopped' ? 'stop' : action === 'archived' ? 'branch-archived' : 'branch-restored',
      branchId: branch.id, branchName: branch.branch, actor, note: reason });
    this.options.state.save();
    await this.options.flush?.();
    this.options.audit?.record({ category: 'container', severity: 'info', source: 'branch-lifecycle',
      action: `branch.lifecycle.${action}`, projectId: branch.projectId, branchId: branch.id, message: reason,
      details: { archive: branch.archive || null, reason, actor } });
    branchEvents.emitEvent({ type: 'branch.updated', payload: { branchId: branch.id, projectId: branch.projectId,
      patch: { archive: branch.archive ?? null, incompleteSince: branch.incompleteSince ?? null, status: branch.status }, ts: new Date(this.now()).toISOString() } });
  }
  async archive(id: string, reason: string, actor = 'system'): Promise<void> {
    if (this.options.paused?.()) throw new Error('控制面维护中，暂不归档');
    if (this.pending.has(id)) throw new Error('同分支正在清理');
    const branch = this.options.state.getBranch(id);
    if (!branch || branch.archive) return;
    if (this.protection(branch)) throw new Error('受保护分支，已跳过');
    if (this.options.active(id)) throw new Error('同分支操作进行中，已跳过');
    this.pending.add(id);
    try {
      if (this.options.observed() === null) throw new Error('运行状态尚未确认，未归档');
      const sha = branch.githubCommitSha;
      const pushedAt = branch.lastPushAt;
      if (hasBranchRuntime(branch, this.options.observed())) await this.options.stop(branch, 'archive');
      const fresh = this.options.state.getBranch(id);
      if (!fresh || fresh.githubCommitSha !== sha || fresh.lastPushAt !== pushedAt || this.options.active(id) || this.protection(fresh)) throw new Error('分支状态已变化，未归档');
      if (this.options.observed() === null || hasBranchRuntime(fresh, this.options.observed())) throw new Error('容器停止尚未确认，未归档');
      const lock = this.options.lock?.(fresh);
      let failed = true;
      try {
        lock?.assertCurrent();
        fresh.archive = { archivedAt: new Date(this.now()).toISOString(), retireAt: new Date(this.now() + this.policy.archiveRetentionMs).toISOString(), reason, actor };
        await this.persist(fresh, 'archived', reason, actor);
        failed = false;
      } finally { lock?.release(failed); }
    } finally { this.pending.delete(id); }
  }
  async restore(id: string, actor: string): Promise<void> {
    if (this.options.paused?.()) throw new Error('控制面维护中，暂不恢复');
    const branch = this.options.state.getBranch(id);
    if (!branch) throw new Error('分支不存在');
    if (this.pending.has(id) || this.options.active(id)) throw new Error('同分支操作进行中');
    if (!branch.archive) return;
    this.pending.add(id);
    let lock: { assertCurrent: () => void; release: (failed?: boolean) => void } | undefined;
    let failed = true;
    try {
      lock = this.options.lock?.(branch);
      lock?.assertCurrent();
      branch.archive = null;
      // 恢复给出新的观察窗口，避免下一轮按历史时间立即再次归档。
      branch.restoredFromArchiveAt = new Date(this.now()).toISOString();
      await this.persist(branch, 'restored', '从归档恢复，容器由用户按需启动', actor);
      failed = false;
    } finally { lock?.release(failed); this.pending.delete(id); }
  }
  async sweep(): Promise<void> {
    if (this.sweeping || this.options.paused?.()) return;
    this.sweeping = true;
    try {
      for (const branch of this.options.state.getAllBranches()) {
        if (this.protection(branch) || this.pending.has(branch.id)) continue;
        try {
          if (branch.archive) {
            if (this.options.active(branch.id) || this.options.observed() === null || hasBranchRuntime(branch, this.options.observed())) continue;
            if (this.now() >= Date.parse(branch.archive.retireAt)) {
              this.pending.add(branch.id);
              try { await this.options.remove(branch.id); } finally { this.pending.delete(branch.id); }
            }
            continue;
          }
          const resident = hasBranchRuntime(branch, this.options.observed());
          if (this.complete(branch)) {
            if (branch.incompleteSince) { branch.incompleteSince = null; this.options.state.save(); }
            continue;
          }
          if (resident) {
            if (this.options.active(branch.id) && !this.options.canInterruptStartup?.(branch.id)) continue;
            const started = Date.parse(branch.lastDeployStartedAt || '');
            const ready = Date.parse(branch.lastReadyAt || '');
            const incomplete = Date.parse(branch.incompleteSince || '');
            const currentAttempt = Number.isFinite(started) && (!Number.isFinite(ready) || started > ready);
            if (!Number.isFinite(incomplete) || currentAttempt && started > incomplete) {
              branch.incompleteSince = new Date(currentAttempt ? started : this.now()).toISOString();
              this.options.state.save();
            }
            if (this.now() - Date.parse(branch.incompleteSince || '') >= this.policy.incompleteTimeoutMs) {
              const sha = branch.githubCommitSha;
              const pushedAt = branch.lastPushAt;
              await this.options.stop(branch, 'startup-timeout');
              const fresh = this.options.state.getBranch(branch.id);
              if (!fresh || fresh.githubCommitSha !== sha || fresh.lastPushAt !== pushedAt || this.options.active(branch.id) || this.protection(fresh)) throw new Error('停止后的分支状态已变化，未覆盖新状态');
              if (this.options.observed() === null || hasBranchRuntime(fresh, this.options.observed())) throw new Error('超时停止尚未确认');
              const lock = this.options.lock?.(fresh);
              let failed = true;
              try {
                lock?.assertCurrent();
                const reason = `整组未完全启动超过 ${Math.round(this.policy.incompleteTimeoutMs / MINUTE)} 分钟，自动停止本分支容器；保留数据，可手动重试`;
                fresh.lastStopReason = reason; fresh.lastStopSource = 'cds'; fresh.lastStoppedAt = new Date(this.now()).toISOString();
                fresh.incompleteSince = null;
                await this.persist(fresh, 'startup-stopped', reason, 'system:lifecycle');
                failed = false;
              } finally { lock?.release(failed); }
            }
            continue;
          }
          if (this.options.active(branch.id)) continue;
          if (branch.incompleteSince) { branch.incompleteSince = null; this.options.state.save(); }
          const anchors = [branch.createdAt, branch.lastPushAt, branch.lastDeployAt, branch.lastStoppedAt, branch.restoredFromArchiveAt]
            .map(v => Date.parse(v || '')).filter(Number.isFinite);
          const anchor = anchors.length ? Math.max(...anchors) : NaN;
          if (!branch.lastAccessedAt && Number.isFinite(anchor) && this.now() - anchor >= this.policy.neverPreviewedArchiveMs) {
            await this.archive(branch.id, '无预览访问且未完全启动，闲置超过24小时自动归档，保留30天', 'system:lifecycle');
          }
        } catch (error) {
          this.options.audit?.record({ category: 'system', severity: 'warn', source: 'branch-lifecycle', action: 'branch.lifecycle.deferred',
            projectId: branch.projectId, branchId: branch.id, message: error instanceof Error ? error.message : '生命周期操作未完成' });
        }
      }
    } finally { this.sweeping = false; }
  }
}
