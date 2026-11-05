import type { BranchEntry } from '../types.js';
import { randomUUID } from 'node:crypto';
import type { StateService } from './state.js';
import { BranchOperationSupersededError, type BranchOperationCoordinator, type BranchOperationLease } from './branch-operation-coordinator.js';
import { DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS, deploymentPhaseBudget } from './deployment-phase-budget.js';

export interface RemoteDeploymentIdentity {
  projectId: string; branchId: string; executorId: string; deploymentRunId: string;
  operationId: string; operationGeneration: number;
}
export interface RemoteDeploymentOwner extends RemoteDeploymentIdentity { revoked: boolean }
export interface RemotePhaseWait { waitId: string; phase: string; remainingMs: number }
export interface RemoteExecutionReceipt extends RemoteDeploymentIdentity { sequence: number; wait: RemotePhaseWait | null }
export const REMOTE_OWNER_TTL_MS = 30_000;

export function remoteIdentity(input: unknown): RemoteDeploymentIdentity | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  const fields = ['projectId', 'branchId', 'executorId', 'deploymentRunId', 'operationId'] as const;
  if (fields.some(key => typeof value[key] !== 'string' || !(value[key] as string).length || (value[key] as string).length > 256)
    || !Number.isSafeInteger(value.operationGeneration) || Number(value.operationGeneration) < 1) return;
  return Object.fromEntries([...fields.map(key => [key, value[key]]), ['operationGeneration', value.operationGeneration]]) as unknown as RemoteDeploymentIdentity;
}
export function sameRemoteOwner(a: RemoteDeploymentIdentity | undefined, b: RemoteDeploymentIdentity | undefined): boolean {
  return !!a && !!b && (['projectId', 'branchId', 'executorId', 'deploymentRunId', 'operationId', 'operationGeneration'] as const)
    .every(key => a[key] === b[key]);
}

type ExecutorLease = { owner: RemoteDeploymentOwner; expiresAt: number; started: boolean; sequence: number; admissionId: string };
/** 每条远端分支保留最后原代次；同提交不能合并不同所有者，迟到撤销不影响继任者。 */
class ExecutorDeploymentOwners {
  private readonly leases = new Map<string, ExecutorLease>();
  constructor(private readonly state: StateService) {}
  private key(owner: RemoteDeploymentIdentity): string { return JSON.stringify([owner.projectId, owner.branchId]); }
  private publish(lease: ExecutorLease): void {
    const branch = this.state.getBranch(lease.owner.branchId);
    if (branch && (branch.projectId || 'default') === lease.owner.projectId
      && (!branch.remoteDeployment || branch.remoteDeployment.operationGeneration <= lease.owner.operationGeneration)) {
      branch.remoteDeployment = { ...lease.owner }; this.state.save([{ kind: 'branches', id: branch.id }]);
    }
  }
  claim(owner: RemoteDeploymentIdentity): ExecutorLease {
    const branch = this.state.getBranch(owner.branchId);
    if (branch && (branch.projectId || 'default') !== owner.projectId) throw new Error('远端项目身份不一致');
    const key = this.key(owner), prior = this.leases.get(key), persisted = branch?.remoteDeployment;
    const previous = prior?.owner || persisted;
    if (previous && (previous.operationGeneration > owner.operationGeneration
      || previous.operationGeneration === owner.operationGeneration && (!sameRemoteOwner(previous, owner) || previous.revoked))) {
      throw new BranchOperationSupersededError(owner.operationId, owner.branchId, 'remote-generation');
    }
    if (!prior && persisted && sameRemoteOwner(persisted, owner)) throw new Error('重启后的旧代次不能重新执行，请创建新的部署');
    if (prior && sameRemoteOwner(prior.owner, owner)) {
      if (Date.now() >= prior.expiresAt) { prior.owner.revoked = true; this.publish(prior); throw new Error('远端原代次资格已过期，请重新部署'); }
      prior.expiresAt = Date.now() + REMOTE_OWNER_TTL_MS; return prior;
    }
    if (!prior && !this.state.getBranch(owner.branchId) && this.leases.size >= 1024) throw new Error('远端部署资格暂满，请稍后重试');
    const lease: ExecutorLease = { owner: { ...owner, revoked: false }, expiresAt: Date.now() + REMOTE_OWNER_TTL_MS,
      started: false, sequence: 0, admissionId: randomUUID() };
    this.leases.set(key, lease); this.publish(lease); return lease;
  }
  begin(owner: RemoteDeploymentIdentity, admissionId: unknown): { assertCurrent: () => void; receipt: () => RemoteExecutionReceipt } {
    const lease = this.leases.get(this.key(owner));
    if (!lease || !sameRemoteOwner(lease.owner, owner) || admissionId !== lease.admissionId || lease.started
      || lease.owner.revoked || Date.now() >= lease.expiresAt) throw new Error('远端原代次未准入或已经受理，不能重放执行');
    lease.started = true;
    const assertCurrent = () => {
      if (this.leases.get(this.key(owner)) !== lease || lease.owner.revoked || Date.now() >= lease.expiresAt) {
        if (!lease.owner.revoked) { lease.owner.revoked = true; this.publish(lease); }
        throw new BranchOperationSupersededError(owner.operationId, owner.branchId, 'remote-generation');
      }
    };
    return { assertCurrent, receipt: () => {
      assertCurrent();
      const wait = deploymentPhaseBudget.waitingOperation(owner.operationId, owner.operationGeneration);
      return { ...owner, sequence: ++lease.sequence, wait: wait ? { waitId: wait.waitId, phase: wait.phase,
        remainingMs: Math.max(0, wait.deadlineAt - Date.now()) } : null };
    } };
  }
  revoke(owner: RemoteDeploymentIdentity): boolean {
    const key = this.key(owner), lease = this.leases.get(key);
    const prior = lease?.owner || this.state.getBranch(owner.branchId)?.remoteDeployment;
    if (prior && (prior.operationGeneration > owner.operationGeneration
      || prior.operationGeneration === owner.operationGeneration && !sameRemoteOwner(prior, owner))) return false;
    if (!lease && !this.state.getBranch(owner.branchId) && this.leases.size >= 1024) return false;
    const revoked: ExecutorLease = lease && sameRemoteOwner(lease.owner, owner) ? lease
      : { owner: { ...owner, revoked: true }, expiresAt: 0, started: false, sequence: 0, admissionId: '' };
    revoked.owner.revoked = true; this.leases.set(key, revoked); this.publish(revoked); return true;
  }
  protected(branchId: string): boolean {
    return !!this.state.getBranch(branchId)?.remoteDeployment || [...this.leases.values()].some(lease => lease.owner.branchId === branchId);
  }
}
const executors = new WeakMap<StateService, ExecutorDeploymentOwners>();
export function executorDeploymentOwners(state: StateService): ExecutorDeploymentOwners {
  let owners = executors.get(state);
  if (!owners) { owners = new ExecutorDeploymentOwners(state); executors.set(state, owners); }
  return owners;
}

/** 收到剩余时长后只用本机时间；重复回执不能延长同一次等待，也不能复活已结束等待。 */
export class RemoteExecutionWaits {
  private readonly observations = new Map<string, { owner: RemoteDeploymentIdentity; sequence: number; receivedAt: number;
    current?: string; deadlines: Map<string, number> }>();
  observe(owner: RemoteDeploymentIdentity, input: unknown, now: number): boolean {
    if (!input || typeof input !== 'object' || !sameRemoteOwner(owner, remoteIdentity(input))) return false;
    const report = input as RemoteExecutionReceipt;
    if (!Number.isSafeInteger(report.sequence) || report.sequence < 1) return false;
    let observation = this.observations.get(owner.deploymentRunId);
    if (observation && (!sameRemoteOwner(observation.owner, owner) || report.sequence <= observation.sequence)) return false;
    const wait = report.wait;
    if (wait !== null && (!wait || typeof wait.waitId !== 'string' || !wait.waitId || wait.waitId.length > 128
      || !['pull', 'start', 'ready', 'cleanup', 'terminal'].includes(wait.phase)
      || !Number.isFinite(wait.remainingMs) || wait.remainingMs <= 0 || wait.remainingMs > DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS)) return false;
    observation ||= { owner, sequence: 0, receivedAt: now, deadlines: new Map() };
    if (wait && observation.current !== wait.waitId && observation.deadlines.has(wait.waitId)) return false;
    if (wait && !observation.deadlines.has(wait.waitId) && observation.deadlines.size >= 64) return false;
    observation.sequence = report.sequence; observation.receivedAt = now; observation.current = wait?.waitId;
    if (wait) observation.deadlines.set(wait.waitId, Math.min(observation.deadlines.get(wait.waitId) ?? Infinity, now + wait.remainingMs));
    this.observations.set(owner.deploymentRunId, observation); return true;
  }
  waiting(owner: RemoteDeploymentIdentity, now: number): boolean {
    const observation = this.observations.get(owner.deploymentRunId);
    return !!observation && sameRemoteOwner(observation.owner, owner) && !!observation.current
      && now >= observation.receivedAt && now - observation.receivedAt < REMOTE_OWNER_TTL_MS
      && now < (observation.deadlines.get(observation.current) || 0);
  }
  clear(runId: string): void { this.observations.delete(runId); }
}

export async function readOwnedRemoteChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  let abort!: () => void;
  const ended = new Promise<never>((_, reject) => {
    abort = () => {
      reject(new Error('远端原代次已结束'));
      try { void reader.cancel().catch(() => {}); } catch { /* 读取器已经结束。 */ }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([reader.read(), ended]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** 只订阅服务器原操作终止，不把浏览器断开当取消；abort 能打断无帧的 reader.read。 */
export function remoteProxyOwner(options: { owner: RemoteDeploymentIdentity; entry: BranchEntry; state: StateService;
  coordinator: BranchOperationCoordinator; lease: BranchOperationLease; url: string; headers: Record<string, string> }) {
  const { owner, entry, state, coordinator, lease, url, headers } = options;
  const controller = new AbortController();
  const current = () => lease.isCurrent() && state.getBranch(entry.id) === entry
    && sameRemoteOwner(entry.remoteDeployment, owner) && !entry.remoteDeployment?.revoked;
  const assertCurrent = () => { if (!current()) throw new BranchOperationSupersededError(owner.operationId, owner.branchId, 'remote-proxy'); };
  lease.assertCurrent('remote owner admission');
  entry.remoteDeployment = { ...owner, revoked: false }; state.save([{ kind: 'branches', id: entry.id }]);
  let revoke: Promise<void> | undefined, renew: Promise<void> | undefined, timer: NodeJS.Timeout | undefined, cancelled = false;
  let admissionId: string | undefined;
  const control = async (action: 'claim' | 'renew' | 'revoke') => {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...owner, action }), signal: AbortSignal.timeout(5_000) });
    const value = await response.json() as { qualified?: boolean; admissionId?: string };
    if (!response.ok || value.qualified !== true || action !== 'revoke' && (!value.admissionId || typeof value.admissionId !== 'string')
      || action === 'renew' && value.admissionId !== admissionId) throw new Error('执行器原代次资格未确认，旧服务保留；请升级执行器后重新部署');
    if (action === 'claim') admissionId = value.admissionId;
  };
  const cancel = (failed = false) => {
    if (cancelled) return; cancelled = true;
    if (state.getBranch(entry.id) === entry && sameRemoteOwner(entry.remoteDeployment, owner)) {
      entry.remoteDeployment!.revoked = true;
      if (failed && lease.isCurrent()) { entry.status = 'error'; entry.errorMessage ||= '执行器原代次资格失效，旧服务保留；请查看最新部署'; }
      state.save([{ kind: 'branches', id: entry.id }]);
    }
    controller.abort(); if (timer) clearInterval(timer);
    revoke ||= control('revoke').catch(() => { /* 执行器本机30秒资格截止仍阻止后续副作用；不冒物理停止。 */ });
    if (failed) coordinator.revokeInterrupted({ operationId: owner.operationId, generation: owner.operationGeneration,
      projectId: owner.projectId, branchId: owner.branchId, profileId: lease.request.profileId || undefined });
  };
  const unsubscribe = coordinator.onOperationEnded((id, generation) => { if (id === owner.operationId && generation === owner.operationGeneration) cancel(); });
  return { signal: controller.signal, assertCurrent, isCurrent: current,
    admissionId: () => admissionId,
    async claim() {
      assertCurrent(); await control('claim'); assertCurrent();
      timer = setInterval(() => {
        if (!current()) { cancel(); return; }
        renew ||= control('renew').catch(() => { cancel(true); }).finally(() => { renew = undefined; });
      }, 10_000); timer.unref();
    },
    async close(failed = false) {
      if (failed) cancel(true); if (timer) clearInterval(timer); unsubscribe();
      await Promise.allSettled([renew]); await Promise.allSettled([revoke]);
    },
  };
}
