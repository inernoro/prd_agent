import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export class PlatformMaintenanceError extends Error {
  readonly code = 'platform_maintenance';
  constructor() { super('CBD 平台维护屏障已关闭新任务准入，请稍后重试。'); }
}

export interface ReleaseBlocker { kind: string; id: string }
export interface ReleaseParticipant {
  /** 同步封闭入口；已受理工作继续执行。返回值只能由本次所有者调用。 */
  closeAdmission(): {
    inspect(): { known: boolean; blockers: ReleaseBlocker[] };
    reopen(): void;
  };
}

export interface PlatformRuntimeIdentity { pid: number; startedAt: string; commitSha: string }
export type ReleaseBarrierPhase = 'open' | 'draining' | 'sealed' | 'committing' | 'recovery-required';
export interface ReleaseBarrierLease {
  readonly id: string;
  readonly runtime: Readonly<PlatformRuntimeIdentity>;
}

/**
 * 严格发布屏障与旧的 TTL 部署闸门分离。没有自动过期放行，没有取消业务任务回调。
 * 这里只协调调用方登记的参与者，不证明整个运行时已被覆盖；尚未接入线上发布入口。
 * 契约中缺失的参与者、未知执行状态和陈旧凭据均拒绝进入提交阶段。
 */
export class PlatformReleaseBarrier {
  private phase: ReleaseBarrierPhase = 'open';
  private lease?: ReleaseBarrierLease;
  private holds: Array<{ name: string; hold: ReturnType<ReleaseParticipant['closeAdmission']> }> = [];
  private pendingControl = 0;
  private lastBlockers: ReleaseBlocker[] = [];

  constructor(private readonly participants: ReadonlyMap<string, ReleaseParticipant>,
    private readonly requiredParticipants: readonly string[],
    private readonly identity: () => PlatformRuntimeIdentity) {}

  snapshot() {
    return { phase: this.phase, owner: this.lease?.id ?? null, pendingControl: this.pendingControl,
      blockers: this.lastBlockers.map(value => ({ ...value })), participants: this.holds.map(value => value.name) };
  }

  begin(expected: PlatformRuntimeIdentity): ReleaseBarrierLease {
    if (this.phase !== 'open') throw new Error('已有平台发布持有屏障');
    this.assertIdentity(expected);
    if (!this.requiredParticipants.length || new Set(this.requiredParticipants).size !== this.requiredParticipants.length
      || this.requiredParticipants.some(name => !this.participants.has(name))) throw new Error('平台发布参与者覆盖不完整');
    // 先封闭整个状态机；不在逐个参与者之间 await，避免部分封闭期间接纳新任务。
    this.phase = 'draining';
    const lease = Object.freeze({ id: randomUUID(), runtime: Object.freeze({ ...expected }) });
    this.lease = lease;
    try {
      for (const name of this.requiredParticipants) {
        this.holds.push({ name, hold: this.participants.get(name)!.closeAdmission() });
      }
      return lease;
    } catch (error) {
      this.abort(lease);
      throw error;
    }
  }

  /** 不以心跳过期、队列已空或账本终态推断执行体已退出。 */
  private inspect(): ReleaseBlocker[] {
    const blockers: ReleaseBlocker[] = [];
    for (const { name, hold } of this.holds) {
      try {
        const state = hold.inspect();
        if (state.known !== true) blockers.push({ kind: 'unknown', id: name });
        blockers.push(...state.blockers.map(item => ({ ...item, kind: `${name}:${item.kind}` })));
      } catch { blockers.push({ kind: 'unknown', id: name }); }
    }
    this.lastBlockers = blockers;
    return blockers;
  }

  async seal(lease: ReleaseBarrierLease, options: {
    timeoutMs: number; signal?: AbortSignal; flush: () => Promise<void>;
  }): Promise<void> {
    this.assertOwner(lease, 'draining');
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('排空期限必须为正整数');
    if (this.pendingControl) throw new Error('屏障已在排空或落盘');
    this.pendingControl++;
    const deadline = performance.now() + options.timeoutMs;
    const check = () => {
      this.assertOwner(lease, 'draining'); this.assertIdentity(lease.runtime);
      if (options.signal?.aborted) throw new Error('发布排空已取消，未换盘');
      if (performance.now() >= deadline) throw new Error('发布排空或落盘超时，未换盘');
    };
    try {
      for (;;) {
        check();
        if (!this.inspect().length) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))));
      }
      // flush 的超时不会取消底层写入。调用者在其真正 settle 前不能放开屏障。
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      this.pendingControl++;
      const flushing = Promise.resolve().then(options.flush).finally(() => { this.pendingControl--; });
      try {
        await Promise.race([flushing, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('发布落盘超时，屏障保留至落盘结束')), Math.max(1, deadline - performance.now()));
          onAbort = () => reject(new Error('发布排空已取消，屏障保留至落盘结束'));
          options.signal?.addEventListener('abort', onAbort, { once: true });
          if (options.signal?.aborted) onAbort();
        })]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener('abort', onAbort);
      }
      check();
      if (this.inspect().length) throw new Error('最终复核仍有在途或未知执行状态，未换盘');
      this.phase = 'sealed';
    } finally { this.pendingControl--; }
  }

  /** 与首次换盘在同一个同步调用段内执行；随后所有入口一直保持关闭。 */
  commit(lease: ReleaseBarrierLease): void {
    this.assertOwner(lease, 'sealed'); this.assertIdentity(lease.runtime);
    if (this.pendingControl || this.inspect().length) throw new Error('换盘前复核未通过');
    this.phase = 'committing';
  }

  requireRecovery(lease: ReleaseBarrierLease): void {
    this.assertOwner(lease, 'committing', 'recovery-required');
    this.phase = 'recovery-required';
  }

  /** 仅限未开始换盘的放弃路径；提交后必须由事务恢复流程完成，不能靠超时解锁。 */
  abort(lease: ReleaseBarrierLease): void {
    this.assertOwner(lease, 'draining', 'sealed');
    if (this.pendingControl) throw new Error('排空或落盘仍在执行，不能提前恢复准入');
    this.reopen();
  }

  /** 旧进程仍活着且事务已证明回到原产物，才可取消已开始的发布。 */
  rollbackComplete(lease: ReleaseBarrierLease, verifyRestored: () => boolean): void {
    this.assertOwner(lease, 'committing', 'recovery-required');
    this.assertIdentity(lease.runtime);
    if (verifyRestored() !== true || this.pendingControl) throw new Error('回退尚未确认，保持屏障');
    this.reopen();
  }

  private reopen(): void {
    // 某一参与者恢复失败时保持全局恢复态，不能对外宣称已恢复。
    try { for (const { hold } of [...this.holds].reverse()) hold.reopen(); }
    catch { this.phase = 'recovery-required'; throw new Error('恢复准入失败，需要维护者核对'); }
    this.holds = []; this.lease = undefined; this.lastBlockers = []; this.phase = 'open';
  }
  private assertOwner(lease: ReleaseBarrierLease, ...phases: ReleaseBarrierPhase[]): void {
    if (lease !== this.lease || !phases.includes(this.phase)) throw new Error('发布屏障所有者或阶段不匹配');
  }
  private assertIdentity(expected: PlatformRuntimeIdentity): void {
    const actual = this.identity();
    if (!Number.isSafeInteger(expected.pid) || expected.pid <= 1 || !Number.isFinite(Date.parse(expected.startedAt))
      || !/^[0-9a-f]{40}$/.test(expected.commitSha) || expected.pid !== actual.pid
      || expected.startedAt !== actual.startedAt || expected.commitSha !== actual.commitSha) throw new Error('平台运行身份已变化或无法确认');
  }
}

/** 服务入口的所有者闸门；终态账本与真实执行体排空仍由参与者 inspect 提供。 */
export class MaintenanceAdmission {
  private owner?: object;
  assertOpen(): void { if (this.owner) throw new PlatformMaintenanceError(); }
  isClosed(): boolean { return Boolean(this.owner); }
  close(): () => void {
    if (this.owner) throw new Error('准入已由其他发布持有');
    const owner = {}; this.owner = owner;
    return () => { if (this.owner === owner) this.owner = undefined; };
  }
}

/** 根任务受理到真实 Promise settle 的生命周期；派生调用沿用已受理资格。 */
export class MaintenanceWorkGroup implements ReleaseParticipant {
  private readonly admission = new MaintenanceAdmission();
  private readonly context = new AsyncLocalStorage<object>();
  private readonly active = new Map<object, ReleaseBlocker>();

  run<T>(kind: string, fn: () => T): T {
    const parent = this.context.getStore();
    if (!parent || !this.active.has(parent)) this.admission.assertOpen();
    const ticket = {};
    this.active.set(ticket, { kind, id: randomUUID() });
    const release = () => { this.active.delete(ticket); };
    return this.context.run(ticket, () => {
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          return Promise.resolve(result).finally(release) as T;
        }
        release(); return result;
      } catch (error) { release(); throw error; }
    });
  }

  closeAdmission(): ReturnType<ReleaseParticipant['closeAdmission']> {
    const reopen = this.admission.close();
    return { reopen, inspect: () => ({ known: true, blockers: [...this.active.values()].map(value => ({ ...value })) }) };
  }
}
