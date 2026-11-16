import crypto from 'node:crypto';
import type { StateService } from './state.js';
import type { ReleaseRun, ReleaseTarget } from '../types.js';
import type { ReleaseAuthorization, ReleaseConflictCheck, ReleaseGovernanceReceipt, ReleaseMergeBack } from '../domain/release-governance.js';
import { releaseTargetConfigFingerprint, recordReleaseTargetUpsert, ReleaseTargetHistoryStore } from './release-target-history.js';
import { projectIdentityFingerprint } from './release-strategy.js';
import { FULL_SHA, type ReleaseGovernanceGit } from './release-governance-git.js';
import { isReleaseRunInFlight, isSuccessfulReleaseRun } from './release-retention.js';
import { peekReleaseTargetLock } from './release-target-lock.js';

export class ReleaseGovernanceError extends Error {}

export type MergeBackReader = (projectId: string, number: number) => Promise<Omit<ReleaseMergeBack,
  'id' | 'projectId' | 'targetId' | 'sourceSha' | 'owner' | 'linkedBy'>>;
export interface GovernanceAdmission { runId: string; projectId: string; targetId: string; branchId: string;
  commitSha: string; operator: string; action: 'release' | 'rollback'; authorizationId?: string }
const human = (actor: string) => /^user:[^:]+:[^:]+$/.test(actor);
const actorId = (actor: string) => human(actor) ? actor.split(':').slice(0, 2).join(':') : actor;
const known = (actor: string) => human(actor) || /^ai:key:[A-Za-z0-9_-]+$/.test(actor);
const id = (prefix: string) => prefix + crypto.randomBytes(12).toString('hex');

export function normalizeDebugPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new ReleaseGovernanceError('请限定 1–32 个文件或目录，目录以 / 结尾');
  const paths = [...new Set(value.map(p => {
    if (typeof p !== 'string' || p.length > 500 || !p.trim() || p !== p.trim() || p.startsWith('/')
      || /[\\*?\[\]{}\u0000-\u001f\u007f]/.test(p) || p.split('/').some((s, i, a) => s === '.' || s === '..' || !s && i < a.length - 1)) {
      throw new ReleaseGovernanceError('范围须为仓库内文件或目录，不允许通配符、绝对路径或上级目录');
    }
    return p;
  }))];
  return paths.sort();
}
export function pathAllowed(file: string, paths: string[]): boolean {
  return paths.some(p => p.endsWith('/') ? file.startsWith(p) : file === p);
}

/** One authority for every release consumer. Request/decision records and run receipts are durable. */
export class ReleaseGovernanceService {
  private writeUnconfirmed = false;
  constructor(private readonly state: StateService, readonly git: ReleaseGovernanceGit,
    private readonly readPr?: MergeBackReader, private readonly now = () => new Date(),
    private readonly history = new ReleaseTargetHistoryStore()) {}

  private async persist(value: ReturnType<StateService['getReleaseGovernance']>, revocation = false): Promise<void> {
    if (!revocation && Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) {
      throw new ReleaseGovernanceError('审批历史达到存储上限，已停止新增；请联系管理员导出并迁移历史记录后重试');
    }
    this.state.saveReleaseGovernance(value);
    try { await this.state.flush(); this.writeUnconfirmed = false; }
    catch { this.writeUnconfirmed = true; throw new ReleaseGovernanceError('发布治理记录保存未确认，尚未放行；请恢复存储后重试'); }
  }
  private target(targetId: string): ReleaseTarget {
    const target = this.state.getReleaseTarget(targetId);
    if (!target || !target.isEnabled || target.lifecycle === 'archived') throw new ReleaseGovernanceError('发布环境已停用或不存在');
    return target;
  }
  list(projectId: string) {
    const data = this.state.getReleaseGovernance();
    return { authorizations: Object.values(data.authorizations).filter(a => a.projectId === projectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
      checks: Object.values(data.checks || {}).filter(a => a.projectId === projectId),
      attempts: data.attempts.filter(a => a.projectId === projectId).slice(-200).reverse(),
      mergeBacks: Object.values(data.mergeBacks).filter(a => a.projectId === projectId) };
  }
  async enable(targetId: string, actor: string): Promise<void> {
    if (!human(actor)) throw new ReleaseGovernanceError('只能由已登录的人类账号启用发布审批');
    const target = this.target(targetId);
    if (target.governance?.required) return;
    if (peekReleaseTargetLock(targetId) || this.state.getReleaseRuns({ targetId }).some(isReleaseRunInFlight)) {
      throw new ReleaseGovernanceError('本环境仍有进行中的操作，请等待结束后启用审批');
    }
    recordReleaseTargetUpsert({ state: this.state, history: this.history },
      { ...target, governance: { required: true, enabledAt: this.now().toISOString(), enabledBy: actor } }, { actor });
    await this.state.flush();
  }
  async inspect(targetId: string, branchId?: string): Promise<ReleaseConflictCheck> {
    const target = this.target(targetId), current = this.state.getLatestSuccessfulReleaseRun(targetId);
    const branch = branchId ? this.state.getBranch(branchId) : undefined;
    if (branchId && (!branch || branch.projectId !== target.projectId)) throw new ReleaseGovernanceError('分支与发布环境不属于同一项目');
    const sha = branch ? branch.pinnedCommit || branch.githubCommitSha : current?.commitSha;
    if (!sha || !FULL_SHA.test(sha)) throw new ReleaseGovernanceError('没有可核验的完整版本');
    const check = await this.git.inspect(target.projectId, sha, current?.commitSha);
    await this.saveCheck(targetId, check); return check;
  }
  private async saveCheck(targetId: string, check: ReleaseConflictCheck): Promise<void> {
    const data = this.state.getReleaseGovernance(); data.checks ||= {}; data.checks[targetId] = { ...check, targetId };
    await this.persist(data);
  }
  async request(input: { targetId: string; branchId: string; kind: 'single' | 'debug'; action?: 'release' | 'rollback';
    rollbackReleaseId?: string; expiresAt: string; allowedPaths?: unknown; reason: string; actor: string }): Promise<ReleaseAuthorization> {
    if (!known(input.actor)) throw new ReleaseGovernanceError('请使用真实登录账号或项目执行凭据发起申请');
    const target = this.target(input.targetId);
    const action = input.action || 'release';
    const previous = action === 'rollback' && input.rollbackReleaseId ? this.state.getReleaseRun(input.rollbackReleaseId) : undefined;
    if (action === 'rollback' && (!previous || previous.targetId !== target.id || !isSuccessfulReleaseRun(previous))) throw new ReleaseGovernanceError('请选择同一环境的历史成功版本');
    if (input.kind === 'debug' && action === 'rollback') throw new ReleaseGovernanceError('回滚须使用单次批准，不能借用连续调试授权');
    const branch = action === 'rollback' && previous
      ? this.state.getBranch(previous.branchId) || { id: previous.branchId, projectId: previous.projectId, branch: previous.artifact.branchName || previous.branchId,
        pinnedCommit: previous.commitSha, githubCommitSha: previous.commitSha }
      : this.state.getBranch(input.branchId);
    if (!branch || branch.projectId !== target.projectId) throw new ReleaseGovernanceError('分支与发布环境不属于同一项目');
    const candidate = previous?.commitSha || branch.pinnedCommit || branch.githubCommitSha || '';
    if (!FULL_SHA.test(candidate)) throw new ReleaseGovernanceError('申请必须绑定完整提交');
    const expires = Date.parse(input.expiresAt), now = this.now();
    if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 24 * 60 * 60_000) throw new ReleaseGovernanceError('有效期须在当前时间之后，最长 24 小时');
    if (typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.length > 2000) throw new ReleaseGovernanceError('请填写 8–2000 字的发布目的');
    const allowedPaths = input.kind === 'debug' ? normalizeDebugPaths(input.allowedPaths) : [];
    const baseline = this.state.getLatestSuccessfulReleaseRun(target.id);
    const check = await this.git.inspect(target.projectId, candidate, baseline?.commitSha);
    await this.saveCheck(target.id, check);
    if (check.status !== 'clean') throw new ReleaseGovernanceError(check.status === 'conflicts' ? `存在真实合并冲突：${check.conflicts.slice(0,5).join('、')}` : check.reason || '冲突核验未完成');
    if (action === 'release' && baseline && !check.includesBaseline) throw new ReleaseGovernanceError('候选未包含当前生产基线，请先合入线上热修');
    if (input.kind === 'debug' && check.changedPaths.some(p => !pathAllowed(p, allowedPaths))) throw new ReleaseGovernanceError('候选累计改动超出调试范围，请收窄分支或修正申请范围');
    if (this.state.getLatestSuccessfulReleaseRun(target.id)?.releaseId !== baseline?.releaseId) throw new ReleaseGovernanceError('生产基线已变化，请重新申请');
    const record: ReleaseAuthorization = { id: id('ra_'), projectId: target.projectId, targetId: target.id,
      branchId: branch.id, branchName: branch.branch, kind: input.kind, action, candidateSha: candidate,
      basisSha: baseline?.commitSha || check.mainSha, baselineReleaseId: baseline?.releaseId || null, mainSha: check.mainSha,
      targetFingerprint: releaseTargetConfigFingerprint(target), projectFingerprint: projectIdentityFingerprint(this.state.getProject(target.projectId)),
      allowedPaths, requestedBy: input.actor, reason: input.reason.trim(), createdAt: now.toISOString(),
      expiresAt: new Date(expires).toISOString(), status: 'pending', conflictCheck: check };
    const data = this.state.getReleaseGovernance();
    if (Object.keys(data.authorizations).length >= 5000) throw new ReleaseGovernanceError('审批记录容量已满，请先归档历史记录');
    data.authorizations[record.id] = record; await this.persist(data); return record;
  }
  async decide(authorizationId: string, decision: 'approved' | 'rejected' | 'revoked', actor: string, reason: string): Promise<ReleaseAuthorization> {
    const original = this.state.getReleaseGovernance().authorizations[authorizationId];
    if (!original) throw new ReleaseGovernanceError('审批申请不存在');
    if (!human(actor) && !(decision === 'revoked' && known(actor) && actorId(actor) === actorId(original.requestedBy))) {
      throw new ReleaseGovernanceError('批准和拒绝必须由人类账号完成；执行凭据仅能撤销自己的申请');
    }
    if (decision !== 'revoked' && original.status !== 'pending' || decision === 'revoked' && !['pending','approved'].includes(original.status)) throw new ReleaseGovernanceError('申请状态已变化，请刷新后重试');
    if (decision === 'approved' && actorId(actor) === actorId(original.requestedBy)) throw new ReleaseGovernanceError('不能批准自己发起的申请，请由另一位项目成员批准');
    if (typeof reason !== 'string' || reason.trim().length < 4 || reason.length > 2000) throw new ReleaseGovernanceError('请填写至少 4 字的审批意见');
    if (decision === 'approved') {
      this.validate(original, { projectId: original.projectId, targetId: original.targetId, branchId: original.branchId,
        commitSha: original.candidateSha, operator: original.requestedBy, action: original.action, runId: '' }, false);
      const check = await this.git.inspect(original.projectId, original.candidateSha, original.basisSha);
      await this.saveCheck(original.targetId, check);
      this.validateCheck(original, check);
      this.validate(original, { projectId: original.projectId, targetId: original.targetId, branchId: original.branchId,
        commitSha: original.candidateSha, operator: original.requestedBy, action: original.action, runId: '' }, false);
    }
    const data = this.state.getReleaseGovernance(), current = data.authorizations[authorizationId];
    if (JSON.stringify(current) !== JSON.stringify(original)) throw new ReleaseGovernanceError('申请已被其他操作更新，请刷新后重试');
    const at = this.now().toISOString();
    const next = { ...current, status: decision, decidedBy: actor, decidedAt: at, decisionReason: reason.trim(),
      decisions: [...(current.decisions || []), { action: decision, by: actor, at, reason: reason.trim() }] };
    data.authorizations[authorizationId] = next; await this.persist(data, decision === 'revoked'); return next;
  }
  private validate(record: ReleaseAuthorization, input: GovernanceAdmission, approved = true): void {
    if (!record) throw new ReleaseGovernanceError('批准记录不存在或已被撤销');
    if (this.writeUnconfirmed) throw new ReleaseGovernanceError('治理存储状态未确认，请恢复后再发布');
    if (approved && record.status !== 'approved') throw new ReleaseGovernanceError('申请尚未批准或已撤销');
    if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= this.now().getTime()) throw new ReleaseGovernanceError('批准已过期，请重新申请');
    if (record.projectId !== input.projectId || record.targetId !== input.targetId || record.branchId !== input.branchId
      || actorId(record.requestedBy) !== actorId(input.operator) || record.action !== input.action) throw new ReleaseGovernanceError('批准的项目、环境、分支、执行凭据或操作不匹配');
    if (record.kind === 'single' && (record.candidateSha !== input.commitSha || record.consumedBy && record.consumedBy !== input.runId)) throw new ReleaseGovernanceError('单次批准已使用或版本已变化');
    const target = this.target(input.targetId), branch = this.state.getBranch(input.branchId);
    if ((!branch && record.action !== 'rollback') || branch && (branch.branch !== record.branchName || branch.projectId !== record.projectId)) throw new ReleaseGovernanceError('批准的分支身份已变化');
    if (releaseTargetConfigFingerprint(target) !== record.targetFingerprint
      || projectIdentityFingerprint(this.state.getProject(record.projectId)) !== record.projectFingerprint) throw new ReleaseGovernanceError('环境配置或项目身份已变化，请重新申请');
    const baseline = this.state.getLatestSuccessfulReleaseRun(input.targetId);
    if ((baseline?.releaseId || null) !== record.baselineReleaseId
      && !(record.kind === 'debug' && baseline?.governance?.authorizationId === record.id)) throw new ReleaseGovernanceError('生产基线已被其他发布改变，批准已失效');
  }
  private validateCheck(record: ReleaseAuthorization, check: ReleaseConflictCheck): void {
    if (check.status !== 'clean') throw new ReleaseGovernanceError(check.status === 'conflicts' ? '实际合并存在冲突，请解决后重新申请' : check.reason || '冲突检查不可用');
    if (check.mainSha !== record.mainSha) throw new ReleaseGovernanceError('主干已前进，请重新核验并申请批准');
    if (record.action === 'release' && record.baselineReleaseId && !check.includesBaseline) throw new ReleaseGovernanceError('候选未包含批准时的生产基线');
    if (record.kind === 'debug' && (!check.includesBaseline || check.changedPaths.some(p => !pathAllowed(p, record.allowedPaths)))) throw new ReleaseGovernanceError('累计改动已越过批准范围或分支改写了历史，调试发布被拒绝');
  }
  private findAuthorization(input: GovernanceAdmission): ReleaseAuthorization | undefined {
    const data = this.state.getReleaseGovernance();
    if (input.authorizationId) return data.authorizations[input.authorizationId];
    return Object.values(data.authorizations).filter(a => a.status === 'approved' && a.targetId === input.targetId
      && a.branchId === input.branchId && actorId(a.requestedBy) === actorId(input.operator) && a.action === input.action
      && (a.kind === 'debug' || a.candidateSha === input.commitSha && !a.consumedBy))
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt)).find(record => {
        try { this.validate(record,input); return true; } catch { return false; }
      });
  }
  availability(input: GovernanceAdmission): { ok: boolean; message: string } {
    try {
      const record = this.findAuthorization(input);
      if (!record) throw new ReleaseGovernanceError('尚无有效的独立批准，请先到发布中心申请并获批后再发布');
      this.validate(record,input); return { ok: true, message: `批准 ${record.id} 有效，实际执行前仍会核验主干与累计范围` };
    } catch (error) { return { ok: false, message: error instanceof ReleaseGovernanceError ? error.message : '审批状态未确认，请刷新后重试' }; }
  }
  async authorize(input: GovernanceAdmission): Promise<ReleaseGovernanceReceipt | undefined> {
    if (!this.target(input.targetId).governance?.required) return undefined;
    let authorizationId = input.authorizationId;
    try {
      const record = this.findAuthorization(input);
      if (!record) throw new ReleaseGovernanceError('发布需要独立批准，请先到发布中心申请本次版本或限定范围的调试授权');
      authorizationId = record.id; this.validate(record, input);
      const check = await this.git.inspect(input.projectId, input.commitSha, record.basisSha);
      await this.saveCheck(record.targetId, check);
      this.validateCheck(record, check);
      // Re-read after every asynchronous boundary: revocation/config/baseline changes win.
      const current = this.state.getReleaseGovernance().authorizations[record.id];
      this.validate(current, input);
      if (JSON.stringify(current) !== JSON.stringify(record)) throw new ReleaseGovernanceError('批准记录已变化，请重新发布');
      if (record.kind === 'single') {
        const next = this.state.getReleaseGovernance(); next.authorizations[record.id].consumedBy = input.runId;
        await this.persist(next);
      }
      return { authorizationId: record.id, kind: record.kind, action: record.action, requestedBy: record.requestedBy,
        approvedBy: record.decidedBy!, approvedAt: record.decidedAt!, expiresAt: record.expiresAt,
        targetFingerprint: record.targetFingerprint, projectFingerprint: record.projectFingerprint,
        baselineReleaseId: this.state.getLatestSuccessfulReleaseRun(input.targetId)?.releaseId || null,
        mainSha: check.mainSha, candidateSha: input.commitSha, checkedAt: check.checkedAt, allowedPaths: record.allowedPaths };
    } catch (error) {
      await this.attempt(input, 'denied', (error as Error).message, authorizationId); throw error;
    }
  }
  assertExecution(run: ReleaseRun): void {
    if (!this.target(run.targetId).governance?.required) return;
    if (!run.governance) throw new ReleaseGovernanceError('本次运行没有批准凭据，已停止执行');
    const record = this.state.getReleaseGovernance().authorizations[run.governance.authorizationId];
    if (!record) throw new ReleaseGovernanceError('本次批准记录不可用，已停止执行');
    this.validate(record, { runId: run.releaseId, projectId: run.projectId, targetId: run.targetId,
      branchId: run.branchId, commitSha: run.commitSha, operator: run.operator || 'unknown', action: run.governance.action });
  }
  async attempt(input: GovernanceAdmission, result: 'accepted' | 'denied', reason: string, authorizationId?: string): Promise<void> {
    const data = this.state.getReleaseGovernance();
    data.attempts.push({ id: id('gat_'), ...input, operator: input.operator, at: this.now().toISOString(),
      candidateSha: input.commitSha, authorizationId, releaseId: result === 'accepted' ? input.runId : undefined, result, reason });
    data.attempts = data.attempts.slice(-2000); await this.persist(data);
  }
  async linkMergeBack(targetId: string, number: number, owner: string, actor: string, sourceSha?: string): Promise<ReleaseMergeBack> {
    const target = this.target(targetId), source = sourceSha || this.state.getLatestSuccessfulReleaseRun(targetId)?.commitSha;
    if (!known(actor) || !source || !FULL_SHA.test(source) || !Number.isSafeInteger(number) || number < 1
      || typeof owner !== 'string' || !owner.trim() || owner.length > 200 || !this.readPr) throw new ReleaseGovernanceError('请选择已发布版本、PR 编号和回并负责人');
    if (!this.state.getReleaseRuns({ targetId }).some(r => r.commitSha === source && isSuccessfulReleaseRun(r))) throw new ReleaseGovernanceError('该版本没有本环境的成功发布证据');
    const recordId = `${target.id}:${source}`;
    const original = this.state.getReleaseGovernance().mergeBacks[recordId];
    const pr = await this.readPr(target.projectId, number);
    if (pr.baseRef !== (this.state.getProject(target.projectId)?.gitDefaultBranch || 'main')
      || !await this.git.includesPr(target.projectId, source, number, pr.headSha)) throw new ReleaseGovernanceError('该 PR 未面向项目主干或未包含此线上版本，请核对回并 PR');
    if (JSON.stringify(this.state.getReleaseGovernance().mergeBacks[recordId]) !== JSON.stringify(original)) throw new ReleaseGovernanceError('回并记录已变化，请刷新后重试');
    const record: ReleaseMergeBack = { ...pr, id: recordId, projectId: target.projectId, targetId,
      sourceSha: source, owner: owner.trim(), linkedBy: actor };
    const data = this.state.getReleaseGovernance(); data.mergeBacks[record.id] = record; await this.persist(data); return record;
  }
  async refreshMergeBack(recordId: string, actor: string): Promise<ReleaseMergeBack> {
    const record = this.state.getReleaseGovernance().mergeBacks[recordId];
    if (!record) throw new ReleaseGovernanceError('回并记录不存在');
    try { return await this.linkMergeBack(record.targetId, record.number, record.owner, actor, record.sourceSha); }
    catch {
      const data = this.state.getReleaseGovernance();
      if (JSON.stringify(data.mergeBacks[recordId]) !== JSON.stringify(record)) throw new ReleaseGovernanceError('回并记录已变化，请刷新后重试');
      const unknown: ReleaseMergeBack = { ...record, state: 'unknown', reason: 'PR 状态暂未核实，请检查仓库授权后重试；保留上次核验时间' };
      data.mergeBacks[recordId] = unknown; await this.persist(data); return unknown;
    }
  }
}
