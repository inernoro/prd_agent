// 任务槽与事件日志：协议里「一次一个任务、忙时 409、同一 taskId 幂等、事件按序号续读、可取消」
// 的全部状态都在这里，HTTP 层只做翻译。
//
// 槽的状态机：
//   starting ──reset 成功──▶ idle ──提交──▶ running ──任务结束──▶ resetting ──reset 成功──▶ idle
//                                                                   └─reset 失败─▶ blocked（退避重试，成功后 idle）
// 只有 idle 接新任务。任务结束（成功、失败、取消、超时、引擎意外退出）一律进 resetting，
// 走 EngineLifecycle.reset() 清空目录并重新拉起引擎（隔离方案 A）。
import { setTimeout as delay } from 'node:timers/promises';

import { renderCondition, type RenderedCondition, type ServiceCondition } from './conditions.js';
import { sanitizeRuntimeError, type SanitizedRuntimeError } from './diagnostics.js';
import type { DaemonExit } from './engine/daemon.js';
import type { EngineLifecycle } from './engine/lifecycle.js';
import { AgentWorkspaceRuntimeError, type StageReporter } from './errors.js';
import type { DesignTaskInput, DesignTaskResult } from './executor.js';
import type { NormalizedTaskRequest } from './protocol.js';

export type TaskState = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskEventType = 'status' | 'text_delta' | 'done' | 'error';
export type SlotState = 'starting' | 'idle' | 'running' | 'resetting' | 'blocked';

export interface TaskEvent {
  seq: number;
  type: TaskEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  attempt: number;
}

export interface TaskView {
  taskId: string;
  attempt: number;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  /** 任务结束后工作目录与引擎数据是否已清空（隔离方案 A）。 */
  cleanup: 'pending' | 'completed' | 'failed';
  result?: DesignTaskResult;
  error?: SanitizedRuntimeError;
}

interface TaskRecord {
  taskId: string;
  attempt: number;
  fingerprint: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  events: TaskEvent[];
  cleanup: TaskView['cleanup'];
  result?: DesignTaskResult;
  error?: SanitizedRuntimeError;
  abort: AbortController;
  stopCause?: { kind: 'caller' } | { kind: 'engine_exited'; exit: DaemonExit };
}

export type SubmitOutcome =
  | { kind: 'accepted'; task: TaskView }
  | { kind: 'replayed'; task: TaskView }
  | { kind: 'conflict'; error: RenderedCondition }
  | { kind: 'busy'; retryAfterSeconds: number; error: RenderedCondition }
  | { kind: 'unavailable'; error: RenderedCondition };

export type TaskRunner = (
  task: DesignTaskInput,
  signal: AbortSignal,
  onCreatingStage: StageReporter,
  onStage: StageReporter,
) => Promise<DesignTaskResult>;

export interface TaskManagerOptions {
  run: TaskRunner;
  lifecycle: EngineLifecycle;
  maxRetainedTasks?: number;
  resetRetryBaseMs?: number;
  resetRetryMaxMs?: number;
  log?: (line: string) => void;
}

/**
 * 运行阶段的人话摘要（text_delta）。搬迁自 cds/src/routes/remote-hosts.ts 的 designStageSummary；
 * 唯一的改动是主语：原文写「CDS 正在…」，现在做这件事的是设计执行服务，照实改过来。
 */
function designStageSummary(stage: string, detail?: Record<string, unknown>): string {
  if (stage === 'open_design_running' && typeof detail?.elapsedSeconds === 'number') {
    return `OpenDesign 正在修改共享工作区，已运行 ${detail.elapsedSeconds} 秒。`;
  }
  const summaries: Record<string, string> = {
    open_design_importing: 'OpenDesign 正在接入已准备的工作区。',
    open_design_run_starting: 'OpenDesign 正在启动本次设计任务。',
    open_design_running: 'OpenDesign 正在修改共享工作区。',
    open_design_reviewing: 'OpenDesign 正在逐项复查页面约束与知识事实。',
    open_design_quality_repairing: '设计执行服务已发现可修复的质量问题，OpenDesign 正在定向修正。',
    workspace_collecting: '设计执行服务正在校验生成文件与安全边界。',
    workspace_committing: '设计执行服务正在向 MAP 提交已校验的结果。',
  };
  return summaries[stage] || '设计执行服务正在继续处理。';
}

function taskCancelledCondition(): ServiceCondition {
  return {
    code: 'task_cancelled',
    actor: { kind: 'caller' },
    event: '请求取消了这次设计任务',
    impact: '服务已停止 OpenDesign 并清空本任务的工作目录，不会提交结果',
    urgency: { kind: 'none' },
    retryable: false,
    technical: {},
  };
}

function engineExitedCondition(exit: DaemonExit): ServiceCondition {
  return {
    code: 'open_design_engine_exited',
    actor: { kind: 'engine' },
    event: `在 ${exit.at} 意外退出（没有匹配到本服务发起的停止操作）`,
    impact: '这次设计任务因此中断、没有提交结果，服务正在清空工作目录并重新拉起引擎',
    urgency: { kind: 'investigate', where: '本服务容器日志里以 [od err] 开头的行（引擎自己的报错）' },
    retryable: true,
    technical: { exitCode: exit.code, signal: exit.signal },
  };
}

export class TaskManager {
  private readonly records = new Map<string, TaskRecord>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private slot: SlotState = 'starting';
  private activeTaskId: string | null = null;
  private resetFailure: { error: SanitizedRuntimeError; attempts: number; nextRetryAt: string } | null = null;
  /** 正在进行的这次 reset 是因为引擎意外退出（而不是任务正常结束）：此时能力接口报不健康。 */
  private restartingAfterExit: DaemonExit | null = null;
  private resetLoop: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: TaskManagerOptions) {
    options.lifecycle.onUnexpectedExit((exit) => this.handleUnexpectedExit(exit));
  }

  /** 进程启动时的第一次 reset：从干净目录拉起引擎。 */
  start(): Promise<void> {
    return this.resetUntilClean();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const active = this.activeTaskId ? this.records.get(this.activeTaskId) : undefined;
    if (active && active.state === 'running') {
      active.stopCause = { kind: 'caller' };
      active.abort.abort();
    }
    await this.options.lifecycle.daemon.stop();
  }

  slotState(): SlotState {
    return this.slot;
  }

  lastResetFailure(): { error: SanitizedRuntimeError; attempts: number; nextRetryAt: string } | null {
    return this.resetFailure;
  }

  submit(request: NormalizedTaskRequest): SubmitOutcome {
    const existing = this.records.get(request.taskId);
    if (existing) {
      if (request.attempt === existing.attempt) {
        if (request.fingerprint === existing.fingerprint) return { kind: 'replayed', task: this.view(existing) };
        return {
          kind: 'conflict',
          error: renderCondition({
            code: 'task_id_conflict',
            actor: { kind: 'caller' },
            event: `用同一个 taskId 与 attempt 提交了内容不同的任务（taskId=${request.taskId}）`,
            impact: '服务拒收这次提交，已在执行或已结束的那一次不受影响',
            urgency: { kind: 'act', action: '确认是否需要一次新的尝试；需要的话在上一次失败或取消之后以更大的 attempt 重新提交' },
            retryable: false,
            technical: { attempt: request.attempt },
          }),
        };
      }
      if (request.attempt < existing.attempt || existing.state === 'running' || existing.state === 'succeeded') {
        const reason = request.attempt < existing.attempt
          ? 'task_attempt_stale'
          : existing.state === 'running' ? 'task_attempt_in_progress' : 'task_already_succeeded';
        return {
          kind: 'conflict',
          error: renderCondition({
            code: reason,
            actor: { kind: 'caller' },
            event: `为 taskId=${request.taskId} 提交了第 ${request.attempt} 次尝试，而这里记录的是第 ${existing.attempt} 次（状态 ${existing.state}）`,
            impact: '服务拒收这次提交',
            urgency: { kind: 'act', action: '读取该任务当前的事件与状态，按最新一次尝试的结果处理' },
            retryable: false,
            technical: { recordedAttempt: existing.attempt, recordedState: existing.state },
          }),
        };
      }
    }
    if (this.slot === 'blocked' || this.slot === 'starting') {
      return { kind: 'unavailable', error: this.slotUnavailableCondition() };
    }
    if (this.slot !== 'idle') {
      const retryAfterSeconds = this.slot === 'running' ? 15 : 5;
      return {
        kind: 'busy',
        retryAfterSeconds,
        error: renderCondition({
          code: 'executor_busy',
          actor: { kind: 'service' },
          event: this.slot === 'running'
            ? '正在执行另一个设计任务（每个实例同一时间只跑一个任务）'
            : '正在清空上一个任务的工作目录并重新拉起引擎',
          impact: '这次提交没有被接受，也没有产生任何副作用',
          urgency: { kind: 'wait', until: `约 ${retryAfterSeconds} 秒后重试提交（这是轮询建议，不是完成时间预估）` },
          retryable: true,
          technical: { slot: this.slot },
        }),
      };
    }
    const now = new Date().toISOString();
    const record: TaskRecord = existing
      ? Object.assign(existing, {
          attempt: request.attempt,
          fingerprint: request.fingerprint,
          state: 'running' as const,
          updatedAt: now,
          cleanup: 'pending' as const,
          result: undefined,
          error: undefined,
          abort: new AbortController(),
          stopCause: undefined,
        })
      : {
          taskId: request.taskId,
          attempt: request.attempt,
          fingerprint: request.fingerprint,
          state: 'running',
          createdAt: now,
          updatedAt: now,
          events: [],
          cleanup: 'pending',
          abort: new AbortController(),
        };
    this.records.set(record.taskId, record);
    this.slot = 'running';
    this.activeTaskId = record.taskId;
    this.push(record, 'status', { status: 'creating', reason: 'task_accepted', attempt: record.attempt });
    void this.runTask(record, request);
    return { kind: 'accepted', task: this.view(record) };
  }

  get(taskId: string): TaskView | undefined {
    const record = this.records.get(taskId);
    return record ? this.view(record) : undefined;
  }

  eventsAfter(taskId: string, afterSeq: number): TaskEvent[] | undefined {
    const record = this.records.get(taskId);
    return record?.events.filter((event) => event.seq > afterSeq);
  }

  /** 等待 afterSeq 之后的新事件或任务结束；超时返回 false。 */
  waitForEvent(taskId: string, afterSeq: number, timeoutMs: number): Promise<boolean> {
    const record = this.records.get(taskId);
    if (!record) return Promise.resolve(false);
    if (record.events.some((event) => event.seq > afterSeq) || record.state !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const set = this.waiters.get(taskId) ?? new Set<() => void>();
      const finish = (arrived: boolean) => {
        clearTimeout(timer);
        set.delete(wake);
        if (set.size === 0 && this.waiters.get(taskId) === set) this.waiters.delete(taskId);
        resolve(arrived);
      };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      set.add(wake);
      this.waiters.set(taskId, set);
    });
  }

  cancel(taskId: string): TaskView | undefined {
    const record = this.records.get(taskId);
    if (!record) return undefined;
    if (record.state === 'running' && !record.stopCause) {
      record.stopCause = { kind: 'caller' };
      record.abort.abort();
    }
    return this.view(record);
  }

  private view(record: TaskRecord): TaskView {
    return {
      taskId: record.taskId,
      attempt: record.attempt,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSeq: record.events.at(-1)?.seq ?? 0,
      cleanup: record.cleanup,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private push(record: TaskRecord, type: TaskEventType, payload: Record<string, unknown>): void {
    const event: TaskEvent = {
      seq: (record.events.at(-1)?.seq ?? 0) + 1,
      type,
      payload,
      createdAt: new Date().toISOString(),
      attempt: record.attempt,
    };
    record.events.push(event);
    record.updatedAt = event.createdAt;
    this.wake(record.taskId);
  }

  private wake(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (!set) return;
    this.waiters.delete(taskId);
    for (const wake of set) wake();
  }

  private async runTask(record: TaskRecord, request: NormalizedTaskRequest): Promise<void> {
    const secrets = [request.transfer.transferToken, request.model.apiKey];
    const onCreatingStage: StageReporter = (stage, detail) => {
      if (record.state !== 'running') return;
      this.push(record, 'status', { status: 'creating', reason: stage, ...detail });
    };
    // 与 CDS 回传给 MAP 的形状一致：每个阶段一条 status（reason = 阶段名）加一条人话 text_delta。
    const onStage: StageReporter = (stage, detail) => {
      if (record.state !== 'running') return;
      const { status: runtimeStatus, ...stageDetail } = detail || {};
      this.push(record, 'status', {
        ...stageDetail,
        status: 'running',
        reason: stage,
        ...(typeof runtimeStatus === 'string' ? { runtimeStatus } : {}),
      });
      this.push(record, 'text_delta', { text: designStageSummary(stage, detail) });
    };
    try {
      const result = await this.options.run(request, record.abort.signal, onCreatingStage, onStage);
      // 结果已经交到 MAP：即使取消请求恰好在提交之后到达，也如实报成功，不把已落库的结果说成被取消。
      record.state = 'succeeded';
      record.result = result;
      this.push(record, 'done', {
        artifactRef: result.artifactRef,
        resultSha256: result.resultSha256,
        files: result.files,
        openDesignRunId: result.openDesignRunId,
      });
    } catch (error) {
      const cause = record.stopCause;
      if (cause?.kind === 'caller') {
        record.state = 'cancelled';
        record.error = renderCondition(taskCancelledCondition());
      } else if (cause?.kind === 'engine_exited') {
        record.state = 'failed';
        record.error = renderCondition(engineExitedCondition(cause.exit));
      } else {
        record.state = 'failed';
        record.error = sanitizeRuntimeError(error, secrets);
      }
      this.push(record, 'error', { ...record.error });
      this.options.log?.(`[task] ${record.taskId} attempt=${record.attempt} ended ${record.state} code=${record.error.code}`);
    } finally {
      this.activeTaskId = null;
      this.prune();
      this.resetUntilClean(record).catch(() => undefined);
    }
  }

  private handleUnexpectedExit(exit: DaemonExit): void {
    this.options.log?.(`[engine] OpenDesign process exited unexpectedly code=${exit.code} signal=${exit.signal}`);
    if (this.slot === 'running' && this.activeTaskId) {
      const record = this.records.get(this.activeTaskId);
      if (record && record.state === 'running' && !record.stopCause) {
        record.stopCause = { kind: 'engine_exited', exit };
        this.restartingAfterExit = exit;
        record.abort.abort();
      }
      return;
    }
    if (this.slot === 'idle') {
      this.restartingAfterExit = exit;
      void this.resetUntilClean().catch(() => undefined);
      return;
    }
    // reset 进行中（或正在退避重试）：记下这次退出让能力接口如实说明；是否要再拉一次，
    // 由 reset 循环在发布 idle 之前复核引擎是否还活着来决定。
    if (this.slot === 'resetting' || this.slot === 'blocked') this.restartingAfterExit = exit;
  }

  /** reset 直到成功；失败期间槽位是 blocked，按指数退避重试，能力接口据此如实报告。 */
  private resetUntilClean(record?: TaskRecord): Promise<void> {
    if (this.resetLoop) return this.resetLoop;
    if (this.slot !== 'starting') this.slot = 'resetting';
    const base = this.options.resetRetryBaseMs ?? 2_000;
    const max = this.options.resetRetryMaxMs ?? 60_000;
    this.resetLoop = (async () => {
      for (let attempt = 1; !this.stopped; attempt += 1) {
        try {
          await this.options.lifecycle.reset();
          // 新拉起的引擎可能在健康检查通过之后、这里发布 idle 之前又退出了：此时退出回调看到的槽位
          // 还是 resetting，不会触发新的 reset。若照样发布 idle，能力检查会报 engine_unhealthy、拒收
          // 所有任务，却再也没有东西去拉起它，实例就一直卡着（Codex P2）。所以发布前复核一次，
          // 引擎不在就按一次失败的 reset 处理，走同一条退避重试。
          if (!this.options.lifecycle.daemon.current()) {
            throw new AgentWorkspaceRuntimeError(
              'open_design_engine_exited',
              'OpenDesign exited right after the reset health check; restarting it again',
              true,
            );
          }
          this.resetFailure = null;
          this.restartingAfterExit = null;
          this.slot = 'idle';
          if (record) record.cleanup = 'completed';
          return;
        } catch (error) {
          const waitMs = Math.min(max, base * 2 ** Math.min(attempt - 1, 10));
          this.resetFailure = {
            error: sanitizeRuntimeError(error, []),
            attempts: attempt,
            nextRetryAt: new Date(Date.now() + waitMs).toISOString(),
          };
          this.slot = 'blocked';
          if (record) record.cleanup = 'failed';
          this.options.log?.(`[engine] reset attempt ${attempt} failed: ${this.resetFailure.error.code} ${this.resetFailure.error.message}`);
          await delay(waitMs, undefined, { ref: false });
        }
      }
    })().finally(() => {
      this.resetLoop = null;
    });
    return this.resetLoop;
  }

  private slotUnavailableCondition(): RenderedCondition {
    if (this.slot === 'starting') {
      return renderCondition({
        code: 'engine_starting',
        actor: { kind: 'service' },
        event: '正在启动：清空工作目录并拉起 OpenDesign 引擎',
        impact: '暂不接新任务',
        urgency: { kind: 'wait', until: '引擎健康检查通过（通常数秒到数十秒）' },
        retryable: true,
        technical: {},
      });
    }
    const failure = this.resetFailure;
    return renderCondition({
      code: 'workspace_reset_failed',
      actor: { kind: 'service' },
      event: '在上一个任务结束后清空工作目录、重新拉起引擎时失败',
      impact: '为防止上一个任务的文件或票据被下一个任务读到，暂停接新任务',
      urgency: failure && failure.attempts >= 5
        ? { kind: 'investigate', where: '本服务容器日志里以 [engine] reset 开头的行，以及 /workspace、/app/.od 的磁盘与权限' }
        : { kind: 'wait', until: `自动重试（已失败 ${failure?.attempts ?? 0} 次，下一次在 ${failure?.nextRetryAt ?? '稍后'}）` },
      retryable: true,
      technical: {
        attempts: failure?.attempts ?? 0,
        lastCode: failure?.error.code ?? null,
        lastMessage: failure?.error.message.slice(0, 240) ?? null,
      },
    });
  }

  /** 能力接口用：当前槽位造成的不可用原因；槽位正常时返回 null。 */
  slotCondition(): RenderedCondition | null {
    if (this.slot === 'resetting' && this.restartingAfterExit) {
      return renderCondition({
        code: 'engine_restarting',
        actor: { kind: 'engine' },
        event: `在 ${this.restartingAfterExit.at} 意外退出（没有匹配到本服务发起的停止操作）`,
        impact: '本服务正在清空工作目录并重新拉起它，期间不接新任务',
        urgency: { kind: 'wait', until: '重新拉起后的健康检查通过（通常数秒）' },
        retryable: true,
        technical: { exitCode: this.restartingAfterExit.code, signal: this.restartingAfterExit.signal },
      });
    }
    return this.slot === 'starting' || this.slot === 'blocked' ? this.slotUnavailableCondition() : null;
  }

  private prune(): void {
    const max = this.options.maxRetainedTasks ?? 20;
    const finished = [...this.records.values()]
      .filter((record) => record.state !== 'running')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    while (finished.length > max) {
      const oldest = finished.shift()!;
      this.records.delete(oldest.taskId);
    }
  }
}
