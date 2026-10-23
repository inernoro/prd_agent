import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ExecAssignment, ExecOptions, ExecResult, IShellExecutor } from '../types.js';
import { OperationExecutionError } from './isolated-shell-executor.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';
import { maintenanceDirectoryIdentity, verifyMaintenanceFilesInput,
  type MaintenanceFilesAction, type MaintenanceFilesInput, type MaintenanceFilesReceipt } from './self-maintenance-files-process.js';
import { reserveRetention, completeRetention, sealRetention, retirementFor, recoverCompleteRetention, markRetentionDisposition, forgetRetention,
  type MaintenanceDirectoryIdentity, type MaintenanceRetirement } from './self-maintenance-retention.js';

// 与index.ts既有operation默认预算一致，显式投影才能在清理未终态时观察到期。
const MAINTENANCE_FILES_TIMEOUT_MS = 15 * 60_000;
// 仅限制同态诊断写放大，不改变五秒安全观察或任何执行/恢复预算。
const MAINTENANCE_WARNING_INTERVAL_MS = 60_000;

export type SelfMaintenanceSource = 'self-update' | 'self-force-sync' | 'self-restart' | 'self-update-dry-run';
export type SelfMaintenancePhase = 'prepare' | 'checkpoint' | 'validate' | 'build' | 'drain' | 'flush'
  | 'handoff' | 'rollback' | 'cleanup' | 'restart-scheduled';
export interface SelfMaintenanceOwner {
  readonly id: string;
  readonly source: SelfMaintenanceSource;
  readonly actor: string;
  restartScheduled: boolean;
}
interface MaintenanceJob {
  assignment: ExecAssignment | null;
  pending: boolean;
  unknown: boolean;
  recovery: boolean;
  controller: AbortController;
  deadline?: number;
  settled: Promise<void>;
}
interface Owner extends SelfMaintenanceOwner {
  requestId: string | null;
  operationId: string | null;
  since: number;
  phaseSince: number;
  phase: SelfMaintenancePhase;
  controller: AbortController;
  jobs: Set<MaintenanceJob>;
  invariantFailure: boolean;
  lastWarning?: { state: SelfMaintenanceSnapshot['state']; at: number };
  filesDeadline?: number;
}
export interface SelfMaintenanceSnapshot {
  id: string;
  source: SelfMaintenanceSource;
  actor: string;
  requestId: string | null;
  operationId: string | null;
  phase: SelfMaintenancePhase;
  elapsedMs: number;
  phaseElapsedMs: number;
  stopRequested: boolean;
  restartScheduled: boolean;
  activeJobCount: number;
  unconfirmedJobCount: number;
  state: 'running' | 'cancelling' | 'cleanup-unconfirmed' | 'restart-scheduled';
  jobs: Array<{ assignment: ExecAssignment | null; pending: boolean; unknown: boolean; recovery: boolean }>;
}
export function selfMaintenanceHealthy(snapshot: SelfMaintenanceSnapshot | null): boolean {
  return snapshot === null || (snapshot.state !== 'cancelling' && snapshot.state !== 'cleanup-unconfirmed'
    && snapshot.unconfirmedJobCount === 0 && (!snapshot.restartScheduled || snapshot.activeJobCount === 0));
}
export interface SelfMaintenanceCheckpoint { readonly backupPath: string }
interface Checkpoint {
  input: MaintenanceFilesInput;
  owner: SelfMaintenanceOwner;
  snapshotStarted: boolean;
  existed?: boolean[];
  artifactsRestored: boolean;
  restoreUnconfirmed: boolean;
  discarded: boolean;
  busy: boolean;
  retirementUnconfirmed: boolean;
}

/** 四种维护业务共享一棵树；无等待队列，无TTL解锁，只信真实owned执行终态。 */
export class SelfMaintenanceRuntime {
  private owner: Owner | null = null;
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly checkpoints = new WeakMap<SelfMaintenanceCheckpoint, Checkpoint>();

  constructor(private readonly shell: IShellExecutor, private readonly repoRoot: string,
    private readonly warn: (view: SelfMaintenanceSnapshot) => void = view => {
      console.warn(`[self-maintenance] 维护请求正在停止或等待清理确认 ${JSON.stringify(view)}`);
    }) {}

  acquire(input: { source: SelfMaintenanceSource; actor: string; requestId?: string; operationId?: string },
    activeUpdateBusy = false): SelfMaintenanceOwner | null {
    if (this.closed || this.owner || activeUpdateBusy) return null;
    const now = performance.now();
    const owner: Owner = { ...input, requestId: input.requestId ?? null, operationId: input.operationId ?? null,
      id: randomUUID(), since: now, phaseSince: now, phase: 'prepare', restartScheduled: false,
      controller: new AbortController(), jobs: new Set(), invariantFailure: false };
    this.owner = owner;
    this.ticker = setInterval(() => this.reconcile(), 5000);
    this.ticker.unref?.();
    return owner;
  }

  setPhase(ticket: SelfMaintenanceOwner, phase: SelfMaintenancePhase): void {
    const owner = this.current(ticket);
    if (owner.phase !== phase) { owner.phase = phase; owner.phaseSince = performance.now(); }
  }

  step(ticket: SelfMaintenanceOwner, step: string): void {
    const phase: SelfMaintenancePhase = /rollback/.test(step) ? 'rollback'
      : /cleanup/.test(step) ? 'cleanup' : /drain/.test(step) ? 'drain'
        : /flush/.test(step) ? 'flush' : /restart/.test(step) ? 'handoff'
          : /checkpoint/.test(step) ? 'checkpoint' : /build/.test(step) ? 'build'
            : /validate|install|tsc/.test(step) ? 'validate' : 'prepare';
    this.setPhase(ticket, phase);
  }

  observe(): SelfMaintenanceSnapshot | null {
    const owner = this.owner;
    if (!owner) return null;
    const jobs = [...owner.jobs].map(job => ({ assignment: job.assignment ? { ...job.assignment } : null,
      pending: job.pending, unknown: job.unknown, recovery: job.recovery }));
    const unknown = jobs.filter(job => job.unknown).length + Number(owner.invariantFailure);
    return { id: owner.id, source: owner.source, actor: owner.actor, requestId: owner.requestId,
      operationId: owner.operationId, phase: owner.phase, elapsedMs: Math.max(0, performance.now() - owner.since),
      phaseElapsedMs: Math.max(0, performance.now() - owner.phaseSince), stopRequested: owner.controller.signal.aborted,
      restartScheduled: owner.restartScheduled, activeJobCount: jobs.filter(job => job.pending).length,
      unconfirmedJobCount: unknown, state: unknown ? 'cleanup-unconfirmed' : owner.controller.signal.aborted
        ? 'cancelling' : owner.restartScheduled ? 'restart-scheduled' : 'running', jobs };
  }

  isHealthy(): boolean { return selfMaintenanceHealthy(this.observe()); }

  requestStop(ticket: SelfMaintenanceOwner): void {
    const owner = this.current(ticket);
    owner.controller.abort(); // 不释放；已排队/运行的任务仍await原owned promise。
  }

  reconcile(): void {
    const owner = this.owner;
    if (!owner) return;
    for (const job of owner.jobs) {
      if (job.pending && job.deadline !== undefined && performance.now() >= job.deadline) {
        this.requestStop(owner);
        if (job.recovery) job.controller.abort();
      }
    }
    const view = this.observe();
    if (view && !selfMaintenanceHealthy(view)) {
      const now = performance.now();
      if (owner.lastWarning?.state !== view.state || now - owner.lastWarning.at >= MAINTENANCE_WARNING_INTERVAL_MS) {
        owner.lastWarning = { state: view.state, at: now };
        try { this.warn(view); }
        catch { console.warn('[self-maintenance] CDS 维护写者停止尚未确认，请检查维护状态。'); }
      }
    } else {
      owner.lastWarning = undefined;
    }
  }

  release(ticket: SelfMaintenanceOwner): boolean {
    if (this.owner !== ticket || this.owner.jobs.size || this.owner.invariantFailure) return false;
    clearInterval(this.ticker); this.ticker = undefined; this.owner = null;
    return true;
  }

  finish(ticket: SelfMaintenanceOwner): boolean {
    return !ticket.restartScheduled && this.release(ticket);
  }

  private current(ticket: SelfMaintenanceOwner): Owner {
    if (this.owner !== ticket) throw new Error('CDS 维护请求已失效，操作尚未开始；请重新检查维护状态。');
    return this.owner;
  }

  private qualify(ticket: SelfMaintenanceOwner, recovery: boolean, ownJob?: MaintenanceJob): Owner {
    const owner = this.current(ticket);
    if (this.closed || owner.restartScheduled || owner.invariantFailure
      || [...owner.jobs].some(job => job !== ownJob && (job.unknown || job.pending && (recovery || job.recovery)))) {
      throw new Error('CDS 维护写者尚未确认停止，已保留恢复点；请检查维护状态。');
    }
    if (!recovery) owner.controller.signal.throwIfAborted();
    return owner;
  }

  async exec(ticket: SelfMaintenanceOwner, command: string, options: ExecOptions = {}, recovery = false): Promise<ExecResult> {
    const owner = this.qualify(ticket, recovery);
    if (!this.shell.execOwnedOperation) throw new Error('CDS 缺少受控维护执行能力，操作尚未开始；请检查执行器配置。');
    const controller = recovery ? new AbortController() : owner.controller;
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let settled!: () => void;
    const job: MaintenanceJob = { assignment: null, pending: true, unknown: false, recovery, controller,
      deadline: options.timeout && options.timeout > 0 ? performance.now() + options.timeout : undefined,
      settled: new Promise<void>(resolve => { settled = resolve; }) };
    owner.jobs.add(job);
    let qualificationError: unknown;
    let qualificationRejected = false;
    try {
      return await this.shell.execOwnedOperation(command, { ...options, signal, executionLane: 'operation',
        executionPurpose: undefined,
        onAssigned: assignment => {
          job.assignment = { ...assignment };
          try { options.onAssigned?.(assignment); }
          catch (error) { qualificationRejected = true; qualificationError = error; throw error; }
        },
        beforeStart: () => {
          try { this.qualify(ticket, recovery, job); signal.throwIfAborted(); options.beforeStart?.(); }
          catch (error) { qualificationRejected = true; qualificationError = error; throw error; }
        },
      });
    } catch (error) {
      // cleanup优先于资格异常。普通reject/abort/assignment本身绝不是子组停止证明。
      const cleanupUnknown = error instanceof OperationExecutionError && error.code === 'cleanup';
      if (cleanupUnknown || !(error instanceof OperationExecutionError)
        && !(qualificationRejected && error === qualificationError)) job.unknown = true;
      if (job.unknown || error instanceof OperationExecutionError && ['deadline', 'cancelled', 'callback'].includes(error.code)) {
        owner.controller.abort();
      }
      throw error;
    } finally {
      job.pending = false;
      if (!job.unknown) owner.jobs.delete(job);
      settled();
    }
  }

  /** 先建立本票唯一恢复点身份；只做小目录操作，递归I/O全部交给worker。 */
  prepareCheckpoint(ticket: SelfMaintenanceOwner, source?: { sha: string; branch: string }): SelfMaintenanceCheckpoint {
    this.qualify(ticket, false);
    if (!this.shell.execOwnedOperation) throw new Error('CDS 缺少受控维护文件能力，尚未创建恢复点。');
    const root = maintenanceDirectoryIdentity(fs.realpathSync(this.repoRoot));
    const cds = path.join(root.path, 'cds');
    maintenanceDirectoryIdentity(cds); maintenanceDirectoryIdentity(path.join(cds, 'web'));
    const base = path.join(cds, '.cds');
    fs.mkdirSync(base, { recursive: true }); maintenanceDirectoryIdentity(base);
    const backup = maintenanceDirectoryIdentity(fs.mkdtempSync(path.join(base, `restart-rollback-${ticket.id}-`)));
    try { reserveRetention(root, backup, ticket.id, source); }
    catch (error) { fs.rmdirSync(backup.path); throw error; } // 只删本次仍为空的小入口，不做深删。
    const handle = Object.freeze({ backupPath: backup.path });
    this.checkpoints.set(handle, { owner: ticket, input: { action: 'snapshot', ownerId: ticket.id, root, backup },
      snapshotStarted: false, artifactsRestored: false, restoreUnconfirmed: false, discarded: false, busy: false,
      retirementUnconfirmed: false });
    return handle;
  }

  async files(ticket: SelfMaintenanceOwner, action: Exclude<MaintenanceFilesAction, 'retire'>, handle: SelfMaintenanceCheckpoint): Promise<MaintenanceFilesReceipt> {
    const checkpoint = this.checkpoints.get(handle);
    if (!checkpoint || checkpoint.owner !== ticket || checkpoint.busy || checkpoint.discarded || checkpoint.restoreUnconfirmed
      || checkpoint.retirementUnconfirmed) {
      throw new Error('CDS 恢复点状态未确认，已停止维护文件操作。');
    }
    const recovery = action !== 'snapshot';
    const owner = this.qualify(ticket, recovery);
    if (action === 'snapshot' && checkpoint.snapshotStarted || action === 'restore' && !checkpoint.existed) {
      throw new Error('CDS 恢复点尚未完整保存，已停止重复文件操作。');
    }
    if (action === 'restore' && checkpoint.artifactsRestored) {
      return { action, ownerId: ticket.id, existed: [...checkpoint.existed!], artifactsRestored: true };
    }
    const input = { ...checkpoint.input, action, existed: checkpoint.existed ?? [false, false, false, false, false] };
    verifyMaintenanceFilesInput(input);
    this.setPhase(ticket, action === 'snapshot' ? 'checkpoint' : action === 'restore' ? 'rollback' : 'cleanup');
    checkpoint.busy = true;
    if (action === 'snapshot') checkpoint.snapshotStarted = true;
    const source = import.meta.url.endsWith('.ts');
    const originalWorker = fileURLToPath(new URL(source ? './self-maintenance-files-process.ts' : './self-maintenance-files-process.js', import.meta.url));
    // native模块路径与本票已realpath的root固定匹配，不探测新live文件或选择新代代码。
    const managedNative = !source && path.resolve(originalWorker) === path.join(input.root.path,
      'cds', 'dist', 'services', 'self-maintenance-files-process.js');
    // snapshot已确认的旧dist含原worker及相邻atomic；恢复会将backup/0移回原位置。
    const worker = managedNative && (action === 'restore' || action === 'discard')
      && checkpoint.existed?.[0] === true && !checkpoint.artifactsRestored
      ? path.join(input.backup.path, '0', 'services', 'self-maintenance-files-process.js') : originalWorker;
    try {
      if (action !== 'snapshot') markRetentionDisposition(input.root, ticket.id, action === 'restore' ? 'restoring' : 'discarding', input.existed);
      const timeout = action === 'snapshot' && owner.filesDeadline !== undefined
        ? this.remainingFilesBudget(owner) : MAINTENANCE_FILES_TIMEOUT_MS;
      if (action === 'snapshot') owner.filesDeadline ??= performance.now() + timeout;
      let assignment: ExecAssignment | undefined;
      // 显式保持原operation默认有限上界；五目录是一份job，不逐目录重新发预算。
      const result = await this.exec(ticket, `${shellQuote(process.execPath)} ${source ? '--import tsx ' : ''}${shellQuote(worker)}`, {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), stdin: JSON.stringify(input), timeout,
        onAssigned: value => { assignment = { ...value }; },
        beforeStart: () => {
          if (fs.realpathSync(this.repoRoot) !== input.root.path) throw new Error('CDS 维护源码目录已变化，已停止文件操作。');
          verifyMaintenanceFilesInput(input);
        },
      }, recovery);
      if (result.exitCode !== 0) throw new Error('CDS 维护文件操作未完成，已保留恢复点，请检查维护状态。');
      const receipt = JSON.parse(result.stdout) as MaintenanceFilesReceipt;
      if (receipt.action !== action || receipt.ownerId !== ticket.id || !Array.isArray(receipt.existed)
        || receipt.existed.length !== 5 || receipt.existed.some(value => typeof value !== 'boolean')
        || receipt.artifactsRestored !== (action === 'restore')
        || action !== 'snapshot' && receipt.existed.some((value, i) => value !== input.existed[i])) {
        throw new Error('CDS 维护文件回执未确认，已保留恢复点，请检查维护状态。');
      }
      if (action === 'snapshot') {
        checkpoint.existed = [...receipt.existed];
        completeRetention(input.root, ticket.id, receipt.existed, assignment);
        checkpoint.retirementUnconfirmed = true;
        const retirement = retirementFor(input.root);
        if (retirement) {
          // 从可能开始删除A前就保护B；失败后原capture catch不能把最后保护点当临时副本丢弃。
          await this.retireCheckpoint(ticket, input.root, retirement);
        }
        checkpoint.retirementUnconfirmed = false;
      }
      if (action === 'restore') checkpoint.artifactsRestored = true;
      if (action === 'discard') {
        // 备份旧worker未必理解新小清单；真正终态后由当前Master完成同一精确记录收尾。
        forgetRetention(input.root, ticket.id); checkpoint.discarded = true;
      }
      return receipt;
    } catch (error) {
      if (action === 'restore') { checkpoint.restoreUnconfirmed = true; owner.invariantFailure = true; }
      if (checkpoint.retirementUnconfirmed) owner.invariantFailure = true;
      throw error;
    } finally { checkpoint.busy = false; }
  }

  /** retain先finished再调用；只复制同步资格与小回执，不派发旧owner文件任务。 */
  retainCheckpoint(ticket: SelfMaintenanceOwner, handle: SelfMaintenanceCheckpoint): Promise<void> {
    const owner = this.current(ticket), checkpoint = this.checkpoints.get(handle);
    if (!owner.restartScheduled || owner.jobs.size || owner.invariantFailure || !checkpoint || checkpoint.owner !== ticket
      || checkpoint.busy || checkpoint.discarded || checkpoint.restoreUnconfirmed || checkpoint.retirementUnconfirmed
      || !checkpoint.existed || checkpoint.artifactsRestored) throw new Error('CDS 保留回执尚未具备完整终态，恢复副本保持不动。');
    return sealRetention(checkpoint.input.root, ticket.id);
  }

  /** 仅恢复清单明确记录的两槽事务；在准备下一大副本前完成，绝不分配第三槽。 */
  async recoverCheckpointRetention(ticket: SelfMaintenanceOwner): Promise<void> {
    const owner = this.qualify(ticket, false), root = maintenanceDirectoryIdentity(fs.realpathSync(this.repoRoot));
    const base = path.join(root.path, 'cds/.cds');
    if (!fs.existsSync(base)) return;
    try {
      recoverCompleteRetention(root);
      const retirement = retirementFor(root);
      if (retirement) {
        owner.filesDeadline ??= performance.now() + MAINTENANCE_FILES_TIMEOUT_MS;
        await this.retireCheckpoint(ticket, root, retirement);
      }
      recoverCompleteRetention(root);
    } catch (error) { owner.invariantFailure = true; owner.controller.abort(); throw error; }
  }

  private remainingFilesBudget(owner: Owner): number {
    const remaining = Math.floor((owner.filesDeadline ?? performance.now()) - performance.now());
    if (remaining <= 0) { this.requestStop(owner); throw new Error('CDS 恢复副本阶段已到期，已保留恢复点并停止维护。'); }
    return remaining;
  }

  private async retireCheckpoint(ticket: SelfMaintenanceOwner, root: MaintenanceDirectoryIdentity, retirement: MaintenanceRetirement): Promise<void> {
    const owner = this.qualify(ticket, false);
    const source = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(new URL(source ? './self-maintenance-files-process.ts' : './self-maintenance-files-process.js', import.meta.url));
    const input: MaintenanceFilesInput = { action: 'retire', ownerId: ticket.id, root,
      backup: retirement.backup, existed: retirement.existed, retirement };
    try {
      const result = await this.exec(ticket, `${shellQuote(process.execPath)} ${source ? '--import tsx ' : ''}${shellQuote(worker)}`, {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), stdin: JSON.stringify(input),
        timeout: this.remainingFilesBudget(owner), beforeStart: () => verifyMaintenanceFilesInput(input),
      });
      const receipt = result.exitCode === 0 ? JSON.parse(result.stdout) as MaintenanceFilesReceipt : undefined;
      if (!receipt || receipt.action !== 'retire' || receipt.ownerId !== ticket.id || receipt.artifactsRestored !== false
        || !Array.isArray(receipt.existed) || receipt.existed.length !== 5
        || receipt.existed.some((v, i) => v !== retirement.existed[i])) throw new Error('CDS 旧恢复副本退役未确认，已保留完整替代副本。');
    } catch (error) { owner.invariantFailure = true; owner.controller.abort(); throw error; }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.ticker); this.ticker = undefined;
    const owner = this.owner;
    if (!owner) return;
    owner.controller.abort();
    for (const job of owner.jobs) job.controller.abort();
    await Promise.allSettled([...owner.jobs].map(job => job.settled));
    // route的业务finally才拥有finish；close不能把尚在普通await中的旧消费者提前解锁。
    // unknown或尚未返回的业务始终持票，不把executor关闭当事务完成。
  }
}
