import { selfUpdateDrainBlockReason } from './deploy-drain.js';
import crypto from 'node:crypto';
import type { StateService } from './state.js';
import { ReleaseService, isReleaseRunTerminal } from './release-service.js';
import { releaseTargetConfigFingerprint } from './release-target-history.js';
import { effectiveVerdict, isAcceptanceAggregationReport } from './acceptance-overview.js';
import { summarizeReleaseBatch, type AcceptedReleaseVersion, type ReleaseBatch, type ReleaseBatchTarget } from '../domain/release-batch.js';
import type { ReleaseRun } from '../types.js';

const retryable = new Set(['failed', 'interrupted', 'cancelled']);
const id = (prefix: string): string => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const stamp = (): string => new Date().toISOString();
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One coordinator per shared ReleaseService. Restart never resumes a write. */
export class ReleaseBatchService {
  private readonly active = new Set<string>();
  private readonly cancelling = new Set<string>();

  constructor(private readonly state: StateService, private readonly releases: ReleaseService) {
    this.reconcileInterrupted();
  }

  acceptedVersions(projectId: string): AcceptedReleaseVersion[] {
    const reports = this.state.listAcceptanceReports(projectId).filter(isAcceptanceAggregationReport);
    return this.state.getDeploymentVersions({ projectId }).flatMap(version => {
      if (!/^[a-f0-9]{40}$/.test(version.commitSha)) return [];
      // A later fail/conditional for this exact version invalidates an earlier pass.
      const report = reports.find(report => report.commitSha === version.commitSha
        && (!report.branchId || report.branchId === version.branchId));
      if (!report || effectiveVerdict(report) !== 'pass') return [];
      const branch = this.state.getBranch(version.branchId);
      if (!branch || branch.projectId !== projectId) return [];
      return [{ versionId: version.id, commitSha: version.commitSha, branchId: version.branchId,
        branchName: branch.branch, reportId: report.id, reportTitle: report.title, createdAt: version.createdAt }];
    });
  }

  async create(input: { projectId: string; versionId: string; reportId: string; targetIds: string[];
    idempotencyKey: string; operator: string }): Promise<ReleaseBatch> {
    this.checkKey(input.idempotencyKey);
    const fingerprint = JSON.stringify([input.versionId, input.reportId, input.targetIds]);
    const existing = this.state.getReleaseBatches(input.projectId).find(batch => batch.creationKey === input.idempotencyKey);
    if (existing) {
      if (existing.creationFingerprint !== fingerprint) throw new Error('同一请求标识不能更改版本或目标顺序');
      await this.state.flush();
      return existing;
    }
    if (input.targetIds.length < 2 || input.targetIds.length > 20 || new Set(input.targetIds).size !== input.targetIds.length) {
      throw new Error('批次需选择 2 至 20 个不重复的目标，列表顺序就是执行顺序');
    }
    const version = this.acceptedVersions(input.projectId).find(version => version.versionId === input.versionId && version.reportId === input.reportId);
    if (!version) throw new Error('请选择本项目具有通过验收记录的固定版本，验收必须关联完整提交');
    if (this.state.getReleaseBatches(input.projectId).length >= 100) throw new Error('项目批次记录已达 100 条，当前不自动删除幂等与回滚证据，请联系维护者扩容；已有批次仍可查看和恢复');
    const branch = this.state.getBranch(version.branchId)!;
    const targets = input.targetIds.map(targetId => {
      const target = this.state.getReleaseTarget(targetId);
      if (!target || target.projectId !== input.projectId || !target.isEnabled || target.lifecycle === 'archived') {
        throw new Error('发布目标不存在、不属于当前项目或已停用');
      }
      return { targetId, targetName: target.name, configFingerprint: releaseTargetConfigFingerprint(target),
        status: 'pending' as const, previousReleaseId: this.state.getLatestSuccessfulReleaseRun(targetId)?.releaseId,
        previousCommitSha: this.state.getLatestSuccessfulReleaseRun(targetId)?.commitSha, attempts: [] };
    });
    const now = stamp();
    const batch: ReleaseBatch = { id: id('batch'), ...version, projectId: input.projectId,
      source: { projectId: input.projectId, artifact: { type: 'branch-preview', commitSha: version.commitSha,
        branchId: version.branchId, branchName: version.branchName, artifactPath: branch.worktreePath,
        // Only provenance; preflight/execution reads the immutable Git blob, never current preview bytes.
        previewUrl: '' } },
      status: 'draft', createdAt: now, updatedAt: now, operator: input.operator,
      creationKey: input.idempotencyKey, creationFingerprint: fingerprint, requests: {}, targets };
    this.state.saveReleaseBatch(batch);
    await this.state.flush();
    return this.get(batch.id);
  }

  get(batchId: string): ReleaseBatch {
    const batch = this.state.getReleaseBatch(batchId);
    if (!batch) throw new Error('批次不存在');
    return batch;
  }

  private update(batchId: string, edit: (batch: ReleaseBatch) => void): ReleaseBatch {
    const batch = this.get(batchId);
    edit(batch);
    batch.updatedAt = stamp();
    this.state.saveReleaseBatch(batch);
    return batch;
  }

  private editTarget(batchId: string, targetId: string, edit: (row: ReleaseBatchTarget) => void): void {
    this.update(batchId, batch => edit(this.target(batch, targetId)));
  }

  private target(batch: ReleaseBatch, targetId: string): ReleaseBatchTarget {
    const row = batch.targets.find(row => row.targetId === targetId);
    if (!row) throw new Error('目标不属于此批次');
    return row;
  }

  private assertSource(batch: ReleaseBatch): void {
    const report = this.state.getAcceptanceReport(batch.reportId);
    if (!report || report.projectId !== batch.projectId || report.commitSha !== batch.commitSha
      || !isAcceptanceAggregationReport(report) || effectiveVerdict(report) !== 'pass') {
      throw new Error('本批次版本的验收依据已失效，请重新验收后创建批次');
    }
    const latest = this.state.listAcceptanceReports(batch.projectId).filter(isAcceptanceAggregationReport)
      .find(report => report.commitSha === batch.commitSha && (!report.branchId || report.branchId === batch.branchId));
    if (latest && effectiveVerdict(latest) !== 'pass') throw new Error('本批次版本的最新验收未通过，已停止发布');
  }

  private assertTarget(batch: ReleaseBatch, row: ReleaseBatchTarget): void {
    const target = this.state.getReleaseTarget(row.targetId);
    if (!target || target.projectId !== batch.projectId || releaseTargetConfigFingerprint(target) !== row.configFingerprint) {
      throw new Error('目标配置已变更，为避免发布到不同位置，请重新创建批次');
    }
    if (!target.isEnabled || target.lifecycle === 'archived') throw new Error('目标已停用或归档');
    const current = this.state.getLatestSuccessfulReleaseRun(row.targetId);
    const ownRuns = new Set([row.previousReleaseId, ...row.attempts.map(attempt => attempt.runId)]);
    if (current && !ownRuns.has(current.releaseId)) throw new Error('该目标已有批次之外的新发布，请核对实际版本后创建新批次，避免覆盖其他发布');
  }

  private assertDispatchAllowed(batchId: string, targetId: string): void {
    const batch = this.get(batchId);
    const drainReason = selfUpdateDrainBlockReason(Date.now());
    if (drainReason) throw new Error(drainReason);
    if (batch.cancelRequested) throw new Error('批次已取消，未执行的目标不会继续发布');
    this.assertSource(batch);
    this.assertTarget(batch, this.target(batch, targetId));
  }

  async preflight(batchId: string): Promise<ReleaseBatch> {
    if (this.cancelling.has(batchId)) throw new Error('批次正在取消');
    if (this.active.has(batchId)) return this.get(batchId);
    const batch = this.get(batchId);
    if (!['draft', 'ready', 'blocked'].includes(batch.status)) throw new Error('已执行的批次请使用逐目标重试');
    this.assertSource(batch);
    this.active.add(batchId);
    this.update(batchId, batch => { batch.status = 'checking'; });
    try {
      for (const row of batch.targets) {
        if (this.get(batchId).cancelRequested) break;
        this.editTarget(batchId, row.targetId, row => { row.status = 'checking'; row.error = undefined; });
        try {
          this.assertDispatchAllowed(batchId, row.targetId);
          const result = await this.releases.preflight(this.startInput(batch, row.targetId));
          if (this.get(batchId).cancelRequested) break;
          this.editTarget(batchId, row.targetId, row => {
            row.checks = result.checks; row.preflightId = result.preflightId;
            row.status = result.ok ? 'ready' : 'failed';
            row.error = result.ok ? undefined : '发布前检查未通过，请查看阻断项';
          });
        } catch (error) {
          this.editTarget(batchId, row.targetId, row => { row.status = 'failed'; row.error = message(error); });
        }
      }
      this.update(batchId, batch => { batch.status = batch.cancelRequested ? 'cancelled'
        : batch.targets.every(row => row.status === 'ready') ? 'ready' : 'blocked'; });
      await this.state.flush();
      return this.get(batchId);
    } finally { this.active.delete(batchId); }
  }

  private startInput(batch: ReleaseBatch, targetId: string) {
    return { branchId: batch.branchId, targetId, operator: batch.operator,
      previewUrl: batch.source.artifact.previewUrl, batchSource: batch.source, expectedCommitSha: batch.commitSha,
      preflightId: this.target(batch, targetId).preflightId };
  }

  private checkKey(key: string): void {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('请求需携带 8 至 128 位幂等标识');
  }

  private replay(batch: ReleaseBatch, key: string, action: string, targetId?: string): boolean {
    this.checkKey(key);
    const receipt = Object.hasOwn(batch.requests, key) ? batch.requests[key] : undefined;
    if (!receipt) {
      if (Object.keys(batch.requests).length >= 200) throw new Error('批次操作已达 200 次，请创建新批次；原操作记录仍保留');
      return false;
    }
    if (receipt.action !== action || receipt.targetId !== targetId) throw new Error('幂等标识已用于其他操作');
    return true;
  }

  async start(batchId: string, key: string, targetId?: string, rollback = false, operator?: string): Promise<ReleaseBatch> {
    const batch = this.get(batchId);
    const action = rollback ? 'rollback' : targetId ? 'retry' : 'start';
    if (this.replay(batch, key, action, targetId)) { await this.state.flush(); return this.get(batchId); }
    if (this.active.has(batchId) || this.cancelling.has(batchId)) throw new Error('批次操作仍在执行，请等待本次结果');
    if (!targetId && batch.status !== 'ready') throw new Error('请先完成所有目标的发布前检查');
    const rows = targetId ? [this.target(batch, targetId)] : batch.targets;
    if (targetId && !rollback && !retryable.has(rows[0].status)) throw new Error('只允许重试失败、取消或中断目标，成功目标不会重复部署');
    if (rollback && (!rows[0].previousReleaseId || !rows[0].runId)) throw new Error('该目标没有本批次发布记录或批次前的成功版本');
    if (rollback && rows[0].status === 'rolled_back') throw new Error('该目标已恢复原版本');
    for (const row of rows) {
      this.assertTarget(batch, row);
      if (this.releases.isTargetBusy(row.targetId).busy) throw new Error('发布目标仍被占用，请等待执行体退出后操作');
    }
    if (!rollback) this.assertSource(batch);
    this.active.add(batchId);
    this.update(batchId, batch => { batch.requests = { ...batch.requests, [key]: { action, targetId, operator: operator || batch.operator } }; batch.cancelRequested = false; batch.status = 'running'; });
    try { await this.state.flush(); }
    catch (error) {
      this.update(batchId, batch => {
        batch.status = 'interrupted';
        for (const row of batch.targets) if (['ready', 'pending'].includes(row.status)) {
          row.status = 'interrupted'; row.error = '批次受理记录未能持久化，未启动发布；请检查存储';
        }
      });
      this.active.delete(batchId); throw error;
    }
    // Dispatch is asynchronous but the durable request receipt already exists.
    void this.execute(batchId, rows.map(row => row.targetId), rollback, operator || batch.operator).catch(error => {
      console.error(`[release-batch] ${batchId} 收尾失败: ${message(error)}`);
      this.update(batchId, batch => {
        batch.status = batch.cancelRequested ? 'cancelled' : 'interrupted';
        for (const row of batch.targets) if (['pending', 'ready', 'running', 'rollback_running'].includes(row.status)) {
          row.status = batch.cancelRequested ? 'cancelled' : 'interrupted';
          row.error = '批次持久化或收尾失败，后续目标未继续派发；请核对现场后明确重试';
        }
      });
    }).finally(() => this.active.delete(batchId));
    return this.get(batchId);
  }

  private async execute(batchId: string, targetIds: string[], rollback: boolean, operator: string): Promise<void> {
    for (const targetId of targetIds) {
      let batch = this.get(batchId);
      if (batch.cancelRequested) break;
      const attempt = { id: id('attempt'), operator, kind: rollback ? 'rollback' as const : 'deploy' as const, createdAt: stamp() };
      this.editTarget(batchId, targetId, row => {
        row.attempts.push(attempt); row.status = rollback ? 'rollback_running' : 'running'; row.error = undefined;
        row.observedCommitSha = undefined; row.observationError = undefined;
      });
      await this.state.flush();
      try {
        batch = this.get(batchId);
        const row = this.target(batch, targetId);
        const guard = () => {
          if (rollback) {
            const drainReason = selfUpdateDrainBlockReason(Date.now());
            if (drainReason) throw new Error(drainReason);
            const latest = this.get(batchId);
            if (latest.cancelRequested) throw new Error('批次已取消');
            this.assertTarget(latest, this.target(latest, targetId));
          } else this.assertDispatchAllowed(batchId, targetId);
        };
        guard();
        const run = rollback
          ? await this.releases.startRollback(row.runId!, operator, row.previousReleaseId,
            { id: batchId, attemptId: attempt.id, assertDispatchAllowed: guard })
          : await this.releases.startRelease({ ...this.startInput(batch, targetId), operator, batchId, batchAttemptId: attempt.id, assertDispatchAllowed: guard });
        this.editTarget(batchId, targetId, row => {
          row.attempts.find(item => item.id === attempt.id)!.runId = run.releaseId;
          if (rollback) row.rollbackRunId = run.releaseId; else row.runId = run.releaseId;
        });
        await this.waitForRun(run.releaseId);
        const final = this.state.getReleaseRun(run.releaseId)!;
        this.editTarget(batchId, targetId, row => this.applyRun(row, final, rollback));
      } catch (error) {
        // A cancellation can win while preflight/flush is awaiting. Attach any run already persisted.
        const run = this.state.getReleaseRuns({ targetId }).find(run => run.batchAttemptId === attempt.id);
        if (run && !isReleaseRunTerminal(run.status)) this.releases.cancelRelease(run.releaseId, this.get(batchId).operator);
        this.editTarget(batchId, targetId, row => {
          row.attempts.find(item => item.id === attempt.id)!.error = message(error);
          if (run) {
            row.attempts.find(item => item.id === attempt.id)!.runId = run.releaseId;
            if (rollback) row.rollbackRunId = run.releaseId; else row.runId = run.releaseId;
          }
          row.status = this.get(batchId).cancelRequested ? 'cancelled' : rollback ? 'rollback_failed' : 'failed';
          row.error = message(error);
        });
      }
      await this.observe(batchId, targetId);
      await this.state.flush();
    }
    this.update(batchId, batch => { batch.status = summarizeReleaseBatch(batch); });
    await this.state.flush();
  }

  private applyRun(row: ReleaseBatchTarget, run: ReleaseRun, rollback: boolean): void {
    row.status = run.status === 'success' ? 'success' : run.status === 'rollback_success' ? 'rolled_back'
      : run.failure?.code === 'release.cancelled' ? 'cancelled'
      : run.failure?.code === 'release.interrupted' ? 'interrupted' : rollback ? 'rollback_failed' : 'failed';
    row.error = run.errorMessage;
  }

  private async waitForRun(runId: string): Promise<void> {
    for (;;) {
      const run = this.state.getReleaseRun(runId);
      if (!run) throw new Error('发布记录丢失，请检查目标实际版本');
      if (isReleaseRunTerminal(run.status) && !this.releases.isTargetBusy(run.targetId).busy) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async cancel(batchId: string, operator: string): Promise<ReleaseBatch> {
    if (!this.active.has(batchId) && !['draft', 'ready', 'blocked', 'checking', 'running'].includes(this.get(batchId).status)) return this.get(batchId);
    if (this.cancelling.has(batchId)) return this.get(batchId);
    this.cancelling.add(batchId);
    try {
      this.update(batchId, batch => {
        batch.cancelRequested = true; batch.cancelledBy = operator; batch.status = 'cancelled';
        for (const row of batch.targets) if (['pending', 'checking', 'ready'].includes(row.status)) row.status = 'cancelled';
      });
      // Stop the in-flight writer even when storage is unavailable. The in-memory
      // cancellation guard already prevents dispatch, and boot never resumes batches.
      for (const run of this.state.getReleaseRuns().filter(run => run.batchId === batchId && !isReleaseRunTerminal(run.status))) {
        this.releases.cancelRelease(run.releaseId, operator);
      }
      await this.state.flush();
      return this.get(batchId);
    } finally { this.cancelling.delete(batchId); }
  }

  private async observe(batchId: string, targetId: string): Promise<void> {
    const batch = this.get(batchId);
    try {
      this.assertTarget(batch, this.target(batch, targetId));
      const target = this.state.getReleaseTarget(targetId)!;
      const result = await this.releases.readRemoteReleaseState(target);
      const commit = result.inventory?.currentCommitSha;
      const error = commit && /^[a-f0-9]{40}$/.test(commit) ? undefined
        : result.readError || '无法从远端当前版本读取完整提交，请核对目标现场';
      this.editTarget(batchId, targetId, row => {
        row.observedCommitSha = error ? undefined : commit; row.observationError = error; row.observedAt = result.readAt;
      });
    } catch (error) {
      this.editTarget(batchId, targetId, row => { row.observedCommitSha = undefined; row.observationError = message(error); row.observedAt = stamp(); });
    }
  }

  async refresh(batchId: string): Promise<ReleaseBatch> {
    if (this.active.has(batchId)) throw new Error('批次执行期间会自动核对实际版本，请稍后刷新');
    for (const row of this.get(batchId).targets) await this.observe(batchId, row.targetId);
    this.update(batchId, batch => {
      if (!['draft', 'ready', 'blocked', 'checking'].includes(batch.status)) batch.status = summarizeReleaseBatch(batch);
    });
    await this.state.flush();
    return this.get(batchId);
  }

  /** Called on boot only. Preserve real terminal child results; never enqueue another write. */
  private reconcileInterrupted(): void {
    for (const batch of this.state.getReleaseBatches()) {
      if (!['running', 'checking'].includes(batch.status) && !batch.targets.some(row => ['running', 'checking', 'rollback_running'].includes(row.status))) continue;
      this.update(batch.id, batch => {
        for (const row of batch.targets) {
          const attempt = row.attempts.at(-1);
          const run = attempt && this.state.getReleaseRuns({ targetId: row.targetId }).find(run => run.batchAttemptId === attempt.id);
          if (run) {
            attempt!.runId = run.releaseId;
            if (attempt!.kind === 'rollback') row.rollbackRunId = run.releaseId; else row.runId = run.releaseId;
            if (isReleaseRunTerminal(run.status)) { this.applyRun(row, run, attempt!.kind === 'rollback'); continue; }
          }
          if (['running', 'rollback_running', 'checking', 'pending', 'ready'].includes(row.status)) {
            row.status = 'interrupted'; row.error = '服务已重启，批次停止；请先核对实际版本，再明确重试此目标';
          }
        }
        batch.status = batch.cancelRequested ? 'cancelled' : 'interrupted';
      });
    }
  }
}
