import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from './state.js';
import type {
  BranchEntry,
  CdsConfig,
  IShellExecutor,
  ReleaseRun,
  ReleaseRunStatus,
  ScheduledJob,
  ScheduledJobAction,
  ScheduledJobRun,
  ScheduledJobSchedule,
  ScheduledJobTarget,
} from '../types.js';
import type { CdsEventType } from './cds-events-bus.js';
import { buildPreviewUrlForProject } from './comment-template.js';
import { isReleaseRunTerminal, isSuccessfulReleaseRun } from './release-retention.js';
import type { ReleasePreflightResult, ReleaseStartInput, ReleaseTargetBusyState } from './release-service.js';

/**
 * 定时发布需要的**最小** ReleaseService 面。ReleaseService 结构上天然满足它。
 *
 * 刻意只留这几个方法：调度器不许自己判「目标忙不忙」（那是 isTargetBusy 的独占职责），
 * 也不许自己 new 一个 ReleaseService —— 每多一个实例就多一张互不可见的 inFlight 表，
 * settling 判定会当场失明。debt #6 记录的「路由侧自建了第二个」已于 2026-07-29 收敛，
 * 全进程只剩 server.ts 那一个实例，守卫见 release-service-single-instance.test.ts。
 */
export interface ScheduledJobReleasePort {
  isTargetBusy(targetId: string): ReleaseTargetBusyState;
  preflight(input: ReleaseStartInput): Promise<ReleasePreflightResult>;
  startRelease(input: ReleaseStartInput): Promise<ReleaseRun>;
  startRollback(releaseId: string, operator?: string, targetReleaseId?: string): Promise<ReleaseRun>;
  getRun(releaseId: string): ReleaseRun | undefined;
}

export interface ScheduledJobServiceDeps {
  stateService: StateService;
  shell: IShellExecutor;
  config: Pick<CdsConfig, 'masterPort' | 'repoRoot'>
    & Partial<Pick<CdsConfig, 'dockerNetwork' | 'previewDomain' | 'rootDomains'>>;
  /**
   * **必填**，不许写成可选。写成可选的话「忘记接线」照样编译通过，release 动作
   * 静默退化成一种永远失败的动作类型 —— 这正是本仓库反复栽的「链路只建到一半」。
   */
  release: ScheduledJobReleasePort;
  /** 事件出口（晚绑定）。server.ts 传 cdsEventsBus.publish；不传则治理事件无人接收。 */
  publishEvent?: (type: CdsEventType, data: unknown) => void;
  /** 轮询发布终态的间隔，测试注入小值。 */
  releasePollIntervalMs?: number;
  /** 自动回滚撞上 settling 时的退避间隔，测试注入小值。 */
  rollbackRetryIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScheduledJobTargetCheckResult {
  ok: boolean;
  exitCode?: number;
  httpStatus?: number;
  log: string;
  error?: string;
  /**
   * 「本次不执行」而不是「执行失败」。任一动作 skip 即整单 skip，后续动作不再跑 ——
   * 发布被跳过时，后面那些「通知 / 清理」动作的前提已经不成立了。
   */
  skipped?: boolean;
  releaseId?: string;
  releaseStatus?: ReleaseRunStatus;
}

/** 一次动作执行的语境。check = 试运行（安全红线：release 只跑预检，绝不真发）。 */
interface ScheduledJobExecutionContext {
  mode: 'run' | 'check';
  jobId?: string;
}

export interface NormalizeScheduledJobOptions {
  preserveNextRunAt?: boolean;
}

const DEFAULT_TICK_MS = 30_000;
const MAX_LOG_CHARS = 24_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_COMMAND_SANDBOX_IMAGE = 'alpine:3';
const DEFAULT_RELEASE_POLL_INTERVAL_MS = 3_000;
const DEFAULT_ROLLBACK_RETRY_INTERVAL_MS = 1_000;
const ROLLBACK_RETRY_ATTEMPTS = 10;

/**
 * 含 release 动作的任务连续失败几次就自动停用。
 *
 * 为什么只对 release：一条会往生产打的规则反复失败还继续按点重放，是在拿生产做重试；
 * 而 http/command 任务加自动停用会改变存量行为（今天的失败只是记一条红），本轮不动。
 */
export const RELEASE_JOB_FAILURE_DISABLE_THRESHOLD = 2;

/** 定时发布的操作人命名，遵循 actor-resolver 的 `system:` 前缀约定，可与手动发布区分。 */
export function scheduledReleaseOperator(jobId: string): string {
  return `system:scheduled-job:${jobId}`;
}

export class ScheduledJobService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();

  constructor(private readonly deps: ScheduledJobServiceDeps) {}

  start(): void {
    if (this.timer) return;
    this.reconcileNextRunAt();
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduled-jobs] tick failed:', (err as Error).message);
      });
    }, DEFAULT_TICK_MS);
    this.timer.unref?.();
    console.log(`[scheduled-jobs] started (tick=${Math.round(DEFAULT_TICK_MS / 1000)}s)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    const due = this.deps.stateService.listScheduledJobs()
      .filter((job) => job.enabled && job.schedule.type !== 'manual')
      .filter((job) => isJobDue(job, now));
    for (const job of due) {
      try {
        if (!this.claimScheduledOccurrence(job, now)) continue;
        await this.runJob(job.id, 'schedule');
      } catch (err) {
        console.error('[scheduled-jobs] job tick failed:', job.id, (err as Error).message);
      }
    }
  }

  async runJob(jobId: string, trigger: ScheduledJobRun['trigger']): Promise<ScheduledJobRun> {
    const job = this.deps.stateService.getScheduledJob(jobId);
    if (!job) throw new Error('任务不存在');

    if (trigger === 'schedule' && !job.enabled) {
      const skipped = this.createRun(job, trigger, 'skipped');
      skipped.finishedAt = skipped.queuedAt;
      skipped.durationMs = 0;
      skipped.log = '任务已禁用，本次调度跳过。';
      this.deps.stateService.upsertScheduledJobRun(skipped);
      return skipped;
    }

    if (this.running.has(job.id)) {
      const skipped = this.createRun(job, trigger, 'skipped');
      skipped.finishedAt = skipped.queuedAt;
      skipped.durationMs = 0;
      skipped.log = '上一次执行仍在运行，本次按并发策略跳过。';
      this.deps.stateService.upsertScheduledJobRun(skipped);
      return skipped;
    }

    const run = this.createRun(job, trigger, 'running');
    run.startedAt = new Date().toISOString();
    this.deps.stateService.upsertScheduledJobRun(run);
    this.running.add(job.id);

    try {
      const timeoutMs = Math.max(1, job.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
      const result = await this.executeActions(
        job,
        Date.now() + timeoutMs,
        Math.max(0, Math.floor(job.retryCount || 0)),
      );
      run.exitCode = result.exitCode;
      run.httpStatus = result.httpStatus;
      run.log = truncateLog(result.log);
      if (result.releaseId) run.releaseId = result.releaseId;
      if (result.releaseStatus) run.releaseStatus = result.releaseStatus;
      // skipped 不是 failed：目标忙 / 版本没变 / 等人确认，都是「本次不该跑」，
      // 记成失败会把连续失败计数推向自动停用，等于用噪声关掉一条好规则。
      run.status = result.skipped ? 'skipped' : result.ok ? 'success' : 'failed';
      if (run.status === 'failed') run.error = result.error || `执行失败，退出码 ${result.exitCode ?? 'unknown'}`;
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;
      run.log = truncateLog((err as Error).stack || (err as Error).message);
    } finally {
      this.running.delete(job.id);
      run.finishedAt = new Date().toISOString();
      run.durationMs = run.startedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0;
      this.deps.stateService.upsertScheduledJobRun(run);
      this.patchJobAfterRun(job, run);
    }

    return run;
  }

  /**
   * 试运行。**安全红线**：http / command 是真执行（历史语义不变），但 release
   * 只跑发布前检查，绝不 startRelease —— 否则用户点一下「测试」就等于往生产发一次版。
   */
  async checkTarget(target: ScheduledJobTarget, timeoutSeconds: number): Promise<ScheduledJobTargetCheckResult> {
    return this.executeTarget(
      target,
      Math.max(1, timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000,
      `check-${crypto.randomBytes(8).toString('hex')}`,
      { mode: 'check' },
    );
  }

  computeNextRunAt(schedule: ScheduledJobSchedule, from = new Date()): string | null {
    if (schedule.type === 'manual') return null;
    if (schedule.type === 'interval') {
      const minutes = Math.max(1, Math.floor(schedule.intervalMinutes || 1));
      return new Date(from.getTime() + minutes * 60_000).toISOString();
    }
    const tz = schedule.timezone || 'Asia/Shanghai';
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.timeOfDay || '');
    if (!match) return null;
    if (!isValidTimeZone(tz)) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    try {
      const parts = getZonedParts(from, tz);
      let candidate = zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, tz);
      if (candidate <= from.getTime()) {
        const next = addDays(parts.year, parts.month, parts.day, 1);
        candidate = zonedLocalToUtc(next.year, next.month, next.day, hour, minute, tz);
      }
      return new Date(candidate).toISOString();
    } catch {
      return null;
    }
  }

  normalizeJob(job: ScheduledJob, options: NormalizeScheduledJobOptions = {}): ScheduledJob {
    const now = new Date().toISOString();
    const shouldPreserveNext = options.preserveNextRunAt && Boolean(job.nextRunAt || job.schedule.type === 'manual');
    const next = !job.enabled
      ? null
      : shouldPreserveNext
        ? job.nextRunAt || null
        : this.computeNextRunAt(job.schedule, new Date());
    const actions = normalizeActions(job.actions, job.target);
    return {
      ...job,
      actions,
      target: actions[0],
      timeoutSeconds: Math.max(1, Math.floor(job.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS)),
      retryCount: Math.max(0, Math.floor(job.retryCount || 0)),
      concurrencyPolicy: 'skip',
      updatedAt: now,
      nextRunAt: next,
    };
  }

  private reconcileNextRunAt(): void {
    for (const job of this.deps.stateService.listScheduledJobs()) {
      if (!job.enabled || job.schedule.type === 'manual') continue;
      if (parseTimestamp(job.nextRunAt) !== null) continue;
      try {
        const nextRunAt = this.computeNextRunAt(job.schedule);
        if (!nextRunAt) continue;
        this.deps.stateService.upsertScheduledJob({ ...job, nextRunAt });
      } catch (err) {
        console.error('[scheduled-jobs] reconcile failed:', job.id, (err as Error).message);
      }
    }
  }

  private createRun(job: ScheduledJob, trigger: ScheduledJobRun['trigger'], status: ScheduledJobRun['status']): ScheduledJobRun {
    return {
      id: `sjr_${crypto.randomBytes(8).toString('hex')}`,
      jobId: job.id,
      projectId: job.projectId,
      trigger,
      status,
      queuedAt: new Date().toISOString(),
    };
  }

  private claimScheduledOccurrence(job: ScheduledJob, now: Date): boolean {
    if (job.schedule.type === 'manual') return false;
    const latest = this.deps.stateService.getScheduledJob(job.id);
    if (!latest || !latest.enabled) return false;
    if (!isJobDue(latest, now)) return false;
    const nextRunAt = this.computeNextRunAt(latest.schedule, now);
    if (!nextRunAt) return false;
    this.deps.stateService.upsertScheduledJob({
      ...latest,
      nextRunAt,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  private patchJobAfterRun(job: ScheduledJob, run: ScheduledJobRun): void {
    const latest = this.deps.stateService.getScheduledJob(job.id);
    if (!latest) return;
    // 连续失败棘轮：只对含 release 动作的任务生效，成功或跳过即清零。
    const guardsRelease = normalizeActions(latest.actions, latest.target).some((action) => action.type === 'release');
    const failures = run.status === 'failed'
      ? Math.max(0, Math.floor(latest.consecutiveFailureCount || 0)) + 1
      : 0;
    const shouldAutoDisable = guardsRelease && latest.enabled && failures >= RELEASE_JOB_FAILURE_DISABLE_THRESHOLD;
    const reason = `连续 ${failures} 次发布失败，已自动停用，请人工排查后重新启用`;
    const patched: ScheduledJob = {
      ...latest,
      lastRunAt: run.finishedAt || run.startedAt || run.queuedAt,
      lastRunStatus: run.status,
      lastRunId: run.id,
      consecutiveFailureCount: failures,
      ...(shouldAutoDisable
        ? { enabled: false, autoDisabledAt: new Date().toISOString(), autoDisabledReason: reason }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    // nextRunAt 必须在 enabled 落定之后算：先算再停用会留下一个「已停用却还排着队」的
    // 时间点，下一轮 tick 的 isJobDue 照样命中，自动停用等于没停。
    patched.nextRunAt = this.resolveNextRunAtAfterRun(patched);
    this.deps.stateService.upsertScheduledJob(patched);
    if (!shouldAutoDisable) return;
    this.publishReleaseGovernanceEvent('release.schedule.disabled', latest, reason);
  }

  /**
   * 治理事件出口。文案与「要不要叫醒人」的判定全在 cds-events-bus 的两张穷尽表里，
   * 这里只负责把结构化字段填进去（projectId / targetId / targetName / message），
   * 由 notice-ledger 按结构渲染成站内信 —— 本文件不认识任何文案。
   */
  private publishReleaseGovernanceEvent(
    type: 'release.schedule.approval-required' | 'release.schedule.disabled',
    job: ScheduledJob,
    message: string,
    /**
     * 待确认的那一版。必须随事件一起带出去：审批通知是异步的，人可能几小时后才点，
     * 那时分支早已前进。不钉死版本的话，人在发布中心批准的是「当时最新」，
     * 而不是刚才通过预检的那一版——预检结论与实际发布的内容对不上
     * （Codex review P1，2026-07-29）。
     */
    candidate?: { branchId?: string; commitSha?: string },
  ): void {
    const publish = this.deps.publishEvent;
    if (!publish) return;
    const releaseAction = normalizeActions(job.actions, job.target).find((action) => action.type === 'release');
    const targetId = releaseAction?.type === 'release' ? releaseAction.targetId : undefined;
    const releaseTarget = targetId ? this.deps.stateService.getReleaseTarget(targetId) : undefined;
    const project = this.deps.stateService.getProject(job.projectId);
    try {
      publish(type, {
        jobId: job.id,
        jobName: job.name,
        projectId: job.projectId,
        projectName: project?.name,
        projectSlug: project?.slug,
        ...(targetId ? { targetId } : {}),
        ...(releaseTarget?.name ? { targetName: releaseTarget.name } : {}),
        ...(candidate?.branchId ? { branchId: candidate.branchId } : {}),
        ...(candidate?.commitSha ? { commitSha: candidate.commitSha } : {}),
        message: `${job.name}：${message}`,
      });
    } catch (err) {
      console.warn('[scheduled-jobs] 治理事件发布失败:', job.id, (err as Error).message);
    }
  }

  private resolveNextRunAtAfterRun(job: ScheduledJob): string | null {
    if (!job.enabled || job.schedule.type === 'manual') return null;
    if (parseTimestamp(job.nextRunAt) !== null) return job.nextRunAt || null;
    return this.computeNextRunAt(job.schedule, new Date());
  }

  private async executeActions(job: ScheduledJob, deadlineMs: number, retryCount: number): Promise<ScheduledJobTargetCheckResult> {
    const actions = normalizeActions(job.actions, job.target);
    if (actions.length === 0) {
      return { ok: false, exitCode: 1, log: '', error: '任务至少需要一个动作' };
    }

    const logs: string[] = [];
    let lastExitCode: number | undefined;
    let lastHttpStatus: number | undefined;
    let releaseId: string | undefined;
    let releaseStatus: ReleaseRunStatus | undefined;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const title = action.name || defaultActionName(action);
      logs.push(`[${index + 1}/${actions.length}] ${title}`);
      const sandboxKey = actions.length === 1 ? job.id : `${job.id}-${index + 1}-${action.id}`;
      const result = await this.executeTargetWithRetry(action, deadlineMs, sandboxKey, retryCount, { mode: 'run', jobId: job.id });
      lastExitCode = result.exitCode;
      lastHttpStatus = result.httpStatus;
      if (result.log) logs.push(result.log);
      // 任一动作被跳过 → 整单跳过，后续动作一律不跑（前提已不成立）。
      if (result.skipped) {
        return {
          ok: true,
          skipped: true,
          exitCode: result.exitCode,
          httpStatus: result.httpStatus,
          log: logs.join('\n'),
          releaseId: result.releaseId,
          releaseStatus: result.releaseStatus,
        };
      }
      if (!result.ok) {
        if (result.error) logs.push(result.error);
        return {
          ok: false,
          exitCode: result.exitCode,
          httpStatus: result.httpStatus,
          log: logs.join('\n'),
          error: `${title} 执行失败：${result.error || `退出码 ${result.exitCode ?? 'unknown'}`}`,
          releaseId: result.releaseId,
          releaseStatus: result.releaseStatus,
        };
      }
      if (result.releaseId) releaseId = result.releaseId;
      if (result.releaseStatus) releaseStatus = result.releaseStatus;
    }
    return {
      ok: true,
      exitCode: lastExitCode,
      httpStatus: lastHttpStatus,
      log: logs.join('\n'),
      releaseId,
      releaseStatus,
    };
  }

  private async executeTargetWithRetry(
    target: ScheduledJobTarget,
    deadlineMs: number,
    sandboxKey: string,
    requestedRetryCount: number,
    context: ScheduledJobExecutionContext,
  ): Promise<ScheduledJobTargetCheckResult> {
    // release 强制 0 重试：一次生产部署失败自动重放是危险动作，而且第二次必然撞上
    // isTargetBusy / assertTargetFree 变成噪声。恢复手段是 rollbackOnFailure，不是 retry。
    const retryCount = target.type === 'release' ? 0 : requestedRetryCount;
    const logs: string[] = [];
    let last: ScheduledJobTargetCheckResult | null = null;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        logs.push('任务已达到总超时时间。');
        break;
      }
      const attemptSandboxKey = retryCount === 0 ? sandboxKey : `${sandboxKey}-try-${attempt + 1}`;
      const result = await this.executeTarget(target, remainingMs, attemptSandboxKey, context);
      last = result;
      if (retryCount > 0) logs.push(`尝试 ${attempt + 1}/${retryCount + 1}`);
      if (result.log) logs.push(result.log);
      if (result.ok) return { ...result, log: logs.join('\n') };
      if (result.error) logs.push(result.error);
    }
    return {
      ok: false,
      exitCode: last?.exitCode,
      httpStatus: last?.httpStatus,
      log: logs.join('\n'),
      error: last?.error || `重试 ${retryCount} 次后仍失败`,
      releaseId: last?.releaseId,
      releaseStatus: last?.releaseStatus,
    };
  }

  private async executeTarget(
    target: ScheduledJobTarget,
    timeoutMs: number,
    sandboxKey?: string,
    context: ScheduledJobExecutionContext = { mode: 'run' },
  ): Promise<ScheduledJobTargetCheckResult> {
    if (target.type === 'release') {
      return this.executeReleaseTarget(target, timeoutMs, context);
    }
    if (target.type === 'command') {
      const sandbox = resolveCommandSandbox(this.deps.config.repoRoot, sandboxKey || 'manual', target.cwd);
      const result = await this.deps.shell.exec(buildDockerSandboxCommand({
        command: target.command,
        containerCwd: sandbox.containerCwd,
        dockerNetwork: this.deps.config.dockerNetwork,
        hostSandboxRoot: sandbox.hostSandboxRoot,
      }), {
        timeout: Math.max(1, Math.ceil(timeoutMs)),
      });
      const log = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        log,
        error: result.exitCode === 0 ? undefined : `执行失败，退出码 ${result.exitCode}`,
      };
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), Math.max(1, Math.ceil(timeoutMs)));
    try {
      const url = normalizeTargetUrl(target.url, this.deps.config.masterPort);
      const headers = { ...(target.headers || {}) };
      const init: RequestInit = { method: target.method || 'POST', headers, signal: ctrl.signal };
      if (target.body && target.method !== 'GET') {
        init.body = target.body;
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
      const res = await fetch(url, init);
      const text = await res.text();
      return {
        ok: res.ok,
        httpStatus: res.status,
        log: `HTTP ${res.status} ${res.statusText}\n${text}`.trim(),
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 定时发布的执行序列（顺序是安全语义的一部分，不要重排）：
   *   a) 解析来源     → branchId + previewUrl + expectedCommitSha
   *   b) 试运行短路   → 只跑 preflight，绝不发布（安全红线）
   *   c) 版本未变短路 → skipped
   *   d) 目标忙短路   → skipped（判据只读 release.isTargetBusy，不许自己重写）
   *   e) 人工确认短路 → 只跑 preflight + 发一条待确认通知，永不自动发布
   *   f) dryRun 短路  → 只跑 preflight
   *   g) startRelease → 轮询到终态（超时只记账，绝不取消别人的发布）
   *   h) 失败自动回滚 → 仅当未发生过自动恢复
   */
  private async executeReleaseTarget(
    target: Extract<ScheduledJobTarget, { type: 'release' }>,
    timeoutMs: number,
    context: ScheduledJobExecutionContext,
  ): Promise<ScheduledJobTargetCheckResult> {
    const deadlineMs = Date.now() + Math.max(1, Math.ceil(timeoutMs));
    const logs: string[] = [];
    const fail = (error: string): ScheduledJobTargetCheckResult => ({ ok: false, exitCode: 1, log: logs.join('\n'), error });
    const skip = (message: string, releaseId?: string): ScheduledJobTargetCheckResult => {
      logs.push(message);
      return { ok: true, skipped: true, log: logs.join('\n'), releaseId };
    };

    // 试运行的横幅必须是**第一行**：用户扫一眼日志头就要确信「这次没往生产打东西」。
    if (context.mode === 'check') logs.push('仅执行发布前检查，未发布。');

    const releaseTarget = this.deps.stateService.getReleaseTarget(target.targetId);
    if (!releaseTarget) return fail(`发布目标不存在：${target.targetId}`);

    const source = this.resolveReleaseSource(target);
    if ('error' in source) return fail(source.error);
    logs.push(source.summary);

    const operator = scheduledReleaseOperator(context.jobId || 'manual');
    const startInput: ReleaseStartInput = {
      branchId: source.branchId,
      targetId: target.targetId,
      previewUrl: source.previewUrl,
      operator,
      ...(source.expectedCommitSha ? { expectedCommitSha: source.expectedCommitSha } : {}),
    };

    // b) 试运行：这是「点一下测试」的路径，绝不允许它变成一次真发布。
    if (context.mode === 'check') return this.runReleasePreflight(startInput, logs);

    // c) 版本没变：目标已经跑着这个 commit，再发一次纯属拿生产做无用功。
    if (target.skipWhenUnchanged && source.candidateCommitSha) {
      const current = this.deps.stateService.getLatestSuccessfulReleaseRun(target.targetId);
      if (current && isSuccessfulReleaseRun(current) && current.commitSha === source.candidateCommitSha) {
        return skip(`目标已在版本 ${current.commitSha}，无需发布。`);
      }
    }

    // d) 目标忙：判据只有 ReleaseService.isTargetBusy 一处，本文件不许重写谓词。
    const busy = this.deps.release.isTargetBusy(target.targetId);
    if (busy.busy) return skip(`${busy.reason || '发布目标正忙'}，本次按并发策略跳过。`, busy.releaseId);

    // e) 需要人工确认：永不自动发布，只把结论摆出来 + 叫醒人。
    if (target.requireApproval) {
      logs.push('该规则要求人工确认，已跑完发布前检查但不会自动发布。');
      const preflight = await this.runReleasePreflight(startInput, logs);
      const job = context.jobId ? this.deps.stateService.getScheduledJob(context.jobId) : undefined;
      if (job) {
        this.publishReleaseGovernanceEvent(
          'release.schedule.approval-required',
          job,
          preflight.ok
            ? `发布前检查已通过，等待人工确认后发布 ${source.candidateCommitSha || source.branchId}`
            : `发布前检查未通过，请人工核对：${preflight.error || '存在阻塞项'}`,
          // 把刚才过检的那一版钉进通知：它是持久化的，人几小时后点进来，
          // 发布中心据此预置同一个 commit，而不是重新解析「当前最新」。
          { branchId: source.branchId, ...(source.candidateCommitSha ? { commitSha: source.candidateCommitSha } : {}) },
        );
      }
      // 预检没过 = 这条规则当前是坏的，必须记成失败。
      // 记成 skip 会顺带把 consecutiveFailureCount 清零，于是一条每次都过不了预检的
      // 规则永远够不到自动停用阈值，坏着坏着就没人管了（Codex review P2，2026-07-29）。
      // skip 只留给「候选确实已就绪、只差人点头」这一种情况。
      if (!preflight.ok) return preflight;
      return skip('已生成待人工确认通知，未自动发布。');
    }

    // f) 试跑模式：只验证配置是否成立。
    if (target.dryRun) {
      logs.push('试运行模式：只执行发布前检查，不发布。');
      return this.runReleasePreflight(startInput, logs);
    }

    // g) 真发布。
    let run: ReleaseRun;
    try {
      run = await this.deps.release.startRelease(startInput);
    } catch (err) {
      return fail(`发起发布失败：${(err as Error).message}`);
    }
    logs.push(`已发起发布 ${run.releaseId}（commit ${run.commitSha}）。`);

    const settled = await this.waitForReleaseTerminal(run.releaseId, deadlineMs);
    if (!settled) {
      // 超时**不取消**发布：调度器不是这次发布的主人（server-authority）。
      return {
        ok: false,
        exitCode: 1,
        log: logs.join('\n'),
        error: `等待发布终态超时，发布仍在进行，releaseId=${run.releaseId}，请到发布中心查看`,
        releaseId: run.releaseId,
        releaseStatus: this.deps.release.getRun(run.releaseId)?.status,
      };
    }

    logs.push(`发布终态：${settled.status}。`);
    if (isSuccessfulReleaseRun(settled)) {
      return { ok: true, exitCode: 0, log: logs.join('\n'), releaseId: settled.releaseId, releaseStatus: settled.status };
    }

    // h) 失败自动回滚。autoRestoredAt 有值 = 健康检查失败时发布侧已经把上一版恢复过了，
    //    再回滚一次等于在生产上多打一次 SSH 部署。
    if (target.rollbackOnFailure && !settled.autoRestoredAt) {
      logs.push(await this.autoRollback(settled.releaseId, operator, deadlineMs));
    } else if (target.rollbackOnFailure && settled.autoRestoredAt) {
      logs.push(`发布失败时已自动恢复上一版本（${settled.autoRestoredAt}），跳过重复回滚。`);
    }

    return {
      ok: false,
      exitCode: 1,
      log: logs.join('\n'),
      error: settled.errorMessage || settled.failure?.summary || `发布失败，终态 ${settled.status}`,
      releaseId: settled.releaseId,
      releaseStatus: settled.status,
    };
  }

  /** 跑一次发布前检查并把结论摘要写进日志。ok 直接反映预检结论。 */
  private async runReleasePreflight(input: ReleaseStartInput, logs: string[]): Promise<ScheduledJobTargetCheckResult> {
    let preflight: ReleasePreflightResult;
    try {
      preflight = await this.deps.release.preflight(input);
    } catch (err) {
      return { ok: false, exitCode: 1, log: logs.join('\n'), error: `发布前检查执行失败：${(err as Error).message}` };
    }
    const blocking = preflight.checks.filter((check) => check.blocking && check.status === 'fail');
    for (const check of preflight.checks) {
      logs.push(`  [${check.status}] ${check.label}${check.message ? `：${check.message}` : ''}`);
    }
    return {
      ok: preflight.ok,
      exitCode: preflight.ok ? 0 : 1,
      log: logs.join('\n'),
      error: preflight.ok ? undefined : `发布前检查未通过：${blocking.map((check) => check.label).join('、') || '存在阻塞项'}`,
    };
  }

  /**
   * 解析「这次要发哪个版本」。
   *
   * promote 找不到成功 run 时**直接失败**，绝不退化成「发分支最新版」——
   * 那是静默换语义：UI 上写着「原样提升」，实际发的是从未在源环境验证过的东西。
   */
  private resolveReleaseSource(
    target: Extract<ScheduledJobTarget, { type: 'release' }>,
  ): { branchId: string; previewUrl: string; expectedCommitSha?: string; candidateCommitSha: string; summary: string } | { error: string } {
    if (target.source.kind === 'promote') {
      const fromTarget = this.deps.stateService.getReleaseTarget(target.source.fromTargetId);
      if (!fromTarget) return { error: `来源环境不存在：${target.source.fromTargetId}` };
      const latest = this.deps.stateService
        .getReleaseRuns({ targetId: target.source.fromTargetId })
        .find(isSuccessfulReleaseRun);
      if (!latest) return { error: `来源环境 ${fromTarget.name} 尚无成功版本，无法提升` };
      return {
        branchId: latest.branchId,
        previewUrl: latest.artifact?.previewUrl || '',
        // 提升必须钳制版本，理由见 ReleaseStartInput.expectedCommitSha。
        expectedCommitSha: latest.commitSha,
        candidateCommitSha: latest.commitSha,
        summary: `提升来源：${fromTarget.name} 正在运行的版本 ${latest.commitSha}（${latest.releaseId}）。`,
      };
    }

    const branch = this.deps.stateService.getBranch(target.source.branchId);
    if (!branch) return { error: `来源分支不存在：${target.source.branchId}` };
    // 分支来源刻意**不**传 expectedCommitSha：它的语义就是「发这个分支的最新版」。
    const candidateCommitSha = branch.pinnedCommit || branch.githubCommitSha || '';
    const historyPreviewUrl = this.deps.stateService
      .getReleaseRuns({ branchId: branch.id })
      .map((run) => run.artifact?.previewUrl || '')
      .find((url) => url.trim().length > 0) || '';
    // 历史记录不能是唯一来源：分支**第一次**被定时发布时必然没有历史，
    // 而空预览地址会被预检判成阻塞项 —— 于是这条规则的试跑和首次真跑都必然失败，
    // 非得有人先手动发一次不可（Codex review P2，2026-07-29）。现推一次兜底。
    const previewUrl = historyPreviewUrl || this.derivePreviewUrl(branch);
    // 仍然推不出来时**不在这里报错**：往下交给发布前检查，让用户看到的是
    // 「可发布产物：缺少预览地址」这条标准结论，而不是调度器自己发明的一句错误。
    const previewHint = previewUrl ? '' : ' 该分支尚无历史发布记录且预览地址推导不出，待发布前检查确认。';
    return {
      branchId: branch.id,
      previewUrl,
      candidateCommitSha,
      summary: `发布来源：分支 ${branch.branch}${candidateCommitSha ? `（commit ${candidateCommitSha}）` : ''}。${previewHint}`,
    };
  }

  /**
   * 分支预览地址的现推兜底（仅 multi 模式）。
   *
   * 只覆盖 multi：`simple` 走的是主域名 + cookie 切换、`port` 是运行期分配的端口，
   * 两者都不是「按分支算得出来」的（port 尤其：套 multi 公式会得到一个语法合法、
   * 却没有任何东西监听的子域，还能骗过预检的非空判定）。推不出来就如实返回空串，
   * 由预检给出标准结论——与前端 resolvePreviewUrl 同一条纪律。
   */
  private derivePreviewUrl(branch: BranchEntry): string {
    const mode = this.deps.stateService.getPreviewModeFor(branch.projectId);
    if (mode !== 'multi') return '';
    const host = this.deps.config.previewDomain || this.deps.config.rootDomains?.[0];
    if (!host) return '';
    const project = branch.projectId ? this.deps.stateService.getProject(branch.projectId) : undefined;
    return buildPreviewUrlForProject(host, branch.branch, project, branch.projectId).url || '';
  }

  /** 轮询到终态；到 deadline 仍未终态返回 undefined（超时，不取消）。 */
  private async waitForReleaseTerminal(releaseId: string, deadlineMs: number): Promise<ReleaseRun | undefined> {
    const interval = Math.max(1, this.deps.releasePollIntervalMs ?? DEFAULT_RELEASE_POLL_INTERVAL_MS);
    for (;;) {
      const run = this.deps.release.getRun(releaseId);
      if (run && isReleaseRunTerminal(run.status)) return run;
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) return undefined;
      await this.pause(Math.min(interval, remaining));
    }
  }

  /**
   * 失败后自动回滚。带退避重试的理由：我们是从 state 台账观察到终态的，而执行发布那个
   * 实例的 finally 可能还没跑完 —— 此刻 startRollback 的并发闸会以 settling 拒绝。
   * 重试仍失败就如实写进日志，绝不吞成「已回滚」。
   */
  private async autoRollback(releaseId: string, operator: string, deadlineMs: number): Promise<string> {
    const interval = Math.max(1, this.deps.rollbackRetryIntervalMs ?? DEFAULT_ROLLBACK_RETRY_INTERVAL_MS);
    let lastError = '';
    for (let attempt = 1; attempt <= ROLLBACK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const rollback = await this.deps.release.startRollback(releaseId, operator);
        return `发布失败，已发起自动回滚 ${rollback.releaseId}。`;
      } catch (err) {
        lastError = (err as Error).message;
      }
      const remaining = deadlineMs - Date.now();
      if (attempt >= ROLLBACK_RETRY_ATTEMPTS || remaining <= 0) break;
      await this.pause(Math.min(interval, remaining));
    }
    return `发布失败，自动回滚未能发起：${lastError || '未知原因'}`;
  }

  private pause(ms: number): Promise<void> {
    const sleep = this.deps.sleep;
    if (sleep) return sleep(ms);
    return new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)).unref?.(); });
  }
}

function normalizeTargetUrl(url: string, masterPort: number): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `http://127.0.0.1:${masterPort}${url}`;
  return url;
}

function normalizeActions(actions?: ScheduledJobAction[], legacyTarget?: ScheduledJobTarget): ScheduledJobAction[] {
  const source = Array.isArray(actions) && actions.length > 0
    ? actions
    : legacyTarget
      ? [{ ...legacyTarget, id: 'action_1', name: defaultActionName(legacyTarget) }]
      : [];
  return source
    // 这是本模块最容易漏且**不会报错**的一处：漏掉某个 type，动作照样能通过 API 校验、
    // 照样能落库，但每次读取/执行都被静默过滤掉，任务变成「零动作」。
    // 新增动作类型必须同时改这里、routes 的 parseTarget 白名单、defaultActionName。
    .filter((action) => action && (action.type === 'http' || action.type === 'command' || action.type === 'release'))
    .map((action, index) => ({
      ...action,
      id: action.id || `action_${index + 1}`,
      name: action.name?.trim() || defaultActionName(action),
    }));
}

function defaultActionName(action: ScheduledJobTarget): string {
  if (action.type === 'release') return '发布到环境';
  return action.type === 'http' ? '调用 HTTP 接口' : '执行命令脚本';
}

function resolveCommandSandbox(repoRoot: string, sandboxKey: string, requestedCwd?: string): {
  containerCwd: string;
  hostCwd: string;
  hostSandboxRoot: string;
} {
  const sandboxRoot = path.resolve(repoRoot, '.cds', 'task-sandboxes', safePathSegment(sandboxKey), 'work');
  const relativeCwd = (requestedCwd || '').trim();
  if (relativeCwd && (path.isAbsolute(relativeCwd) || /^[a-zA-Z]:[\\/]/.test(relativeCwd))) {
    throw new Error('命令工作目录必须是 sandbox 内的相对路径');
  }
  if (relativeCwd.replace(/\\/g, '/').split('/').some((part) => part === '..')) {
    throw new Error('命令工作目录不能跳出 sandbox');
  }
  const cwd = path.resolve(sandboxRoot, relativeCwd || '.');
  if (!isPathInside(sandboxRoot, cwd)) {
    throw new Error('命令工作目录不能跳出 sandbox');
  }
  fs.mkdirSync(cwd, { recursive: true });

  const realRoot = fs.realpathSync.native(sandboxRoot);
  const realCwd = fs.realpathSync.native(cwd);
  if (!isPathInside(realRoot, realCwd)) {
    throw new Error('命令工作目录不能通过符号链接跳出 sandbox');
  }
  return {
    containerCwd: toContainerCwd(relativeCwd),
    hostCwd: realCwd,
    hostSandboxRoot: realRoot,
  };
}

function buildDockerSandboxCommand(input: {
  command: string;
  containerCwd: string;
  dockerNetwork?: string;
  hostSandboxRoot: string;
}): string {
  const args = [
    'docker',
    'run',
    '--rm',
    ...(input.dockerNetwork ? ['--network', input.dockerNetwork] : []),
    '-v',
    `${input.hostSandboxRoot}:/workspace:rw`,
    '-w',
    input.containerCwd,
    resolveCommandSandboxImage(),
    'sh',
    '-lc',
    input.command,
  ];
  return args.map(shellQuote).join(' ');
}

function resolveCommandSandboxImage(): string {
  const configured = process.env.CDS_TASK_SANDBOX_IMAGE?.trim();
  return configured || DEFAULT_COMMAND_SANDBOX_IMAGE;
}

function toContainerCwd(relativeCwd: string): string {
  const parts = relativeCwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? path.posix.join('/workspace', ...parts) : '/workspace';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'sandbox';
}

function isPathInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isJobDue(job: ScheduledJob, now: Date): boolean {
  const next = parseTimestamp(job.nextRunAt);
  return next !== null && next <= now.getTime();
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function truncateLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  return `${log.slice(0, MAX_LOG_CHARS)}\n...[日志已截断]`;
}

function getZonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value || '0');
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

function zonedLocalToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i += 1) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess -= actual - wanted;
  }
  return guess;
}

function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
