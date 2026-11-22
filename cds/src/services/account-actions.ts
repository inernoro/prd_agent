import { createHash, randomUUID } from 'node:crypto';
import { ACCOUNT_ACTIONS, ACCOUNT_ACTION_LABELS, type AccountAction, type AccountActionFilter, type AccountActionRequest } from '../domain/account-actions.js';
import { accountRole, type CdsUser } from '../domain/auth.js';
import type { AuthService } from './auth-service.js';
import { MIN_PASSWORD_LENGTH } from './password.js';

const REQUEST_TTL_MS = 30 * 60_000;

export class AccountActionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function effectiveAccountAction(request: AccountActionRequest, now = new Date()): AccountActionRequest {
  return (request.status === 'pending' || request.status === 'verified') && request.expiresAt <= now.toISOString()
    ? { ...request, status: 'expired' } : request;
}

export function publicAccountAction(request: AccountActionRequest) {
  const { targetRevision: _revision, proposalCredentialId: _credential, ...rest } = effectiveAccountAction(request);
  return rest;
}

function handle(user: CdsUser): string {
  return user.username || user.githubLogin;
}

export class AccountActionsService {
  constructor(
    private readonly auth: AuthService,
    private readonly disable: (target: CdsUser, actor: CdsUser, apply: () => Promise<void>) => Promise<void>,
  ) {}

  private get store() {
    const store = this.auth.accountActions;
    if (!store) throw new AccountActionError(503, 'account_actions_unavailable', '当前账号存储暂不支持逐次审批');
    return store;
  }

  async submit(actor: CdsUser, body: Record<string, unknown>, proposalCredentialId?: string): Promise<AccountActionRequest> {
    const action = ACCOUNT_ACTIONS.find(value => value === body.action);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!action || typeof body.targetId !== 'string' || !body.targetId || reason.length < 3 || reason.length > 500) {
      throw new AccountActionError(400, 'invalid_account_action', '请选择动作和目标，并填写 3–500 字的原因');
    }
    if (body.newPassword !== undefined || body.password !== undefined) {
      throw new AccountActionError(400, 'unexpected_credential', '申请只登记变更原因，口令在所有者确认时填写');
    }
    const target = await this.auth.findUserById(body.targetId);
    if (!target) throw new AccountActionError(404, 'account_not_found', '目标账号不存在');
    this.checkScope(actor, target, action);
    const now = new Date();
    const affectedSessions = await this.auth.countAccountSessions(target);
    const previous = (await this.store.list({ targetId: target.id, requestedByAccountId: actor.id, action }, 100))
      .find(item => item.reason === reason && item.targetRevision === target.sessionRevision &&
        item.proposalCredentialId === proposalCredentialId &&
        item.targetRole === accountRole(target) && item.targetStatus === target.status &&
        item.targetName === handle(target) && item.affectedSessions === affectedSessions);
    if (previous?.status === 'pending' && previous.expiresAt > now.toISOString()) return previous;
    // Identical concurrent submissions converge on the same primary key. A closed
    // or expired request may be followed by another deliberate, auditable attempt.
    const id = createHash('sha256').update(JSON.stringify([
      action, actor.id, target.id, handle(target), reason, target.sessionRevision ?? null,
      accountRole(target), target.status, affectedSessions, proposalCredentialId ?? null, previous?.id ?? null,
    ])).digest('hex');
    const request: AccountActionRequest = {
      id,
      action,
      status: 'pending',
      targetId: target.id,
      targetName: handle(target),
      targetRole: accountRole(target),
      targetStatus: target.status,
      ...(target.sessionRevision ? { targetRevision: target.sessionRevision } : {}),
      affectedSessions,
      reason,
      requestedByAccountId: actor.id,
      requestedBy: handle(actor),
      ...(proposalCredentialId ? { requestedVia: 'agent', proposalCredentialId } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
    };
    try {
      await this.store.insert(request);
    } catch (error) {
      const original = await this.store.get(id);
      if (original) return original;
      throw error;
    }
    return request;
  }

  async list(actor: CdsUser): Promise<AccountActionRequest[]> {
    return (await this.store.list(actor.isSystemOwner ? {} : { requestedByAccountId: actor.id }, 200))
      .filter(item => item.action !== 'recover-identity' && item.action !== 'historical-account-event');
  }

  async audit(actor: CdsUser, query: Record<string, unknown>) {
    const filter: AccountActionFilter = {};
    if (typeof query.targetId === 'string' && query.targetId) filter.targetId = query.targetId;
    if (query.action !== undefined) {
      const action = Object.keys(ACCOUNT_ACTION_LABELS).find(value => value === query.action) as AccountAction | undefined;
      if (!action) throw new AccountActionError(400, 'invalid_audit_action', '请选择已知的账号操作');
      filter.action = action;
    }
    for (const key of ['from', 'until'] as const) {
      const value = query[key];
      if (value === undefined) continue;
      const date = typeof value === 'string' && value.length <= 32 ? Date.parse(value) : NaN;
      if (!Number.isFinite(date)) throw new AccountActionError(400, 'invalid_audit_time', '请输入有效的审计时间');
      filter[key] = new Date(date).toISOString();
    }
    if (filter.from && filter.until && filter.until < filter.from) {
      throw new AccountActionError(400, 'invalid_audit_time', '结束时间须晚于起始时间');
    }
    const status = query.status;
    const matchesStatus = (item: AccountActionRequest) => typeof status !== 'string' || effectiveAccountAction(item).status === status;
    if (actor.isSystemOwner) return (await this.store.list(filter, 200)).filter(matchesStatus).map(publicAccountAction);
    const own = !filter.targetId || filter.targetId === actor.id
      ? (await this.store.list({ ...filter, targetId: actor.id }, 200)).filter(item => item.status === 'completed' && matchesStatus(item))
      : [];
    const submitted = actor.isAdministrator ? await this.store.list({ ...filter, requestedByAccountId: actor.id }, 200) : [];
    return [
      ...own.map(item => ({
        id: item.id, action: item.action, status: item.status, targetId: item.targetId, targetName: item.targetName,
        createdAt: item.createdAt, decidedAt: item.decidedAt, affectedSessions: item.affectedSessions,
      })),
      ...submitted.filter(matchesStatus).map(publicAccountAction),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }

  async backfill(actor: CdsUser, body: Record<string, unknown>): Promise<AccountActionRequest> {
    const details = typeof body.description === 'string' ? body.description.trim() : '';
    const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : '';
    const time = typeof body.occurredAt === 'string' && body.occurredAt.length <= 32 ? Date.parse(body.occurredAt) : NaN;
    const priorApproval = body.priorApproval;
    if (details.length < 3 || details.length > 500 || evidence.length < 3 || evidence.length > 500 ||
        !Number.isFinite(time) || time > Date.now() || (priorApproval !== 'missing' && priorApproval !== 'verified')) {
      throw new AccountActionError(400, 'backfill_evidence_required', '请登记历史时间、经过、证据和原审批情况');
    }
    const target = typeof body.targetId === 'string' ? await this.auth.findUserById(body.targetId) : null;
    const account = target ?? (body.targetId === actor.id ? actor : null);
    if (!account) throw new AccountActionError(404, 'account_not_found', '目标账号不存在，请核对账号编号');
    const now = new Date().toISOString();
    const request: AccountActionRequest = {
      id: randomUUID(), action: 'historical-account-event', status: 'completed',
      targetId: account.id, targetName: handle(account), targetStatus: account.status, targetRole: accountRole(account),
      affectedSessions: 0, reason: details, requestedByAccountId: actor.id, requestedBy: handle(actor),
      createdAt: now, expiresAt: now, decidedAt: now,
      backfill: { occurredAt: new Date(time).toISOString(), evidence, priorApproval },
    };
    await this.store.insert(request);
    return request;
  }

  async confirm(actor: CdsUser, id: string, body: Record<string, unknown>): Promise<AccountActionRequest> {
    const request = await this.load(id);
    if (!ACCOUNT_ACTIONS.some(action => action === request.action)) {
      throw new AccountActionError(409, 'specific_confirmation_required', '请到对应账号视图核对并处理此申请');
    }
    if (request.status === 'completed') return request;
    if (request.status === 'executing') {
      const applied = await this.auth.findUserById(request.targetId);
      if (applied?.lastAccountAction?.id === id && request.action !== 'disable-user') {
        return this.finish(request);
      }
      throw new AccountActionError(409, 'account_action_in_progress', '正在核对原执行结果，请刷新原申请');
    }
    this.requirePending(request);
    if (body.targetName !== request.targetName) {
      throw new AccountActionError(400, 'account_name_mismatch', '请输入申请内显示的目标账号名');
    }
    const password = typeof body.newPassword === 'string' ? body.newPassword : undefined;
    if (request.action === 'reset-password' &&
        (!password || password.length < MIN_PASSWORD_LENGTH || password.length > 512 || /[\u0000\r\n]/.test(password))) {
      throw new AccountActionError(400, 'invalid_new_password', `新口令需为 ${MIN_PASSWORD_LENGTH}–512 位且不含换行`);
    }
    const target = await this.auth.findUserById(request.targetId);
    if (!target || target.sessionRevision !== request.targetRevision || target.status !== request.targetStatus ||
        accountRole(target) !== request.targetRole || handle(target) !== request.targetName ||
        await this.auth.countAccountSessions(target) > request.affectedSessions) {
      throw new AccountActionError(409, 'account_impact_changed', '目标账号或受影响会话有变化，请重新发起并确认');
    }
    this.checkScope(actor, target, request.action);
    const executing = {
      ...request,
      status: 'executing' as const,
      approvedAt: new Date().toISOString(),
      approvedByAccountId: actor.id,
      approvedBy: handle(actor),
      executedByAccountId: actor.id,
    };
    if (!await this.store.transition(executing, 'pending')) {
      const current = await this.load(id);
      if (current.status === 'completed') return current;
      throw new AccountActionError(409, 'account_action_conflict', '这条申请已由另一请求处理，请刷新原申请');
    }
    const apply = async () => {
      if (!await this.auth.applyAccountAction(target, request, password)) {
        throw new AccountActionError(409, 'account_impact_changed', '账号状态已改变，请重新发起申请');
      }
    };
    try {
      if (request.action === 'disable-user') await this.disable(target, actor, apply);
      else await apply();
    } catch (error) {
      const failure = error instanceof AccountActionError
        ? error : new AccountActionError(500, 'account_action_execution_failed', '操作未能完整保存，请查看原申请和账号现状');
      await this.store.transition({
        ...executing, status: 'failed', decidedAt: new Date().toISOString(), failureCode: failure.code,
      }, 'executing');
      throw failure;
    }
    return this.finish(executing);
  }

  async decide(actor: CdsUser, id: string, status: 'rejected' | 'cancelled', rawReason: unknown): Promise<AccountActionRequest> {
    const request = await this.load(id);
    if (request.action === 'recover-identity') {
      throw new AccountActionError(409, 'specific_confirmation_required', '请到身份恢复视图处理此申请');
    }
    if (status === 'rejected' ? !actor.isSystemOwner : request.requestedByAccountId !== actor.id) {
      throw new AccountActionError(403, 'account_action_forbidden', '当前身份不能处理这条申请');
    }
    if (request.status === status) return request;
    this.requirePending(request);
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (status === 'rejected' && (!reason || reason.length > 500)) {
      throw new AccountActionError(400, 'decision_reason_required', '请填写退回原因（最多 500 字）');
    }
    const decided = {
      ...request, status, decidedAt: new Date().toISOString(),
      ...(reason ? { decisionReason: reason.slice(0, 500) } : {}),
    };
    if (!await this.store.transition(decided, 'pending')) {
      throw new AccountActionError(409, 'account_action_conflict', '这条申请已处理，请刷新原申请');
    }
    return decided;
  }

  private async finish(request: AccountActionRequest): Promise<AccountActionRequest> {
    const completed = { ...request, status: 'completed' as const, decidedAt: new Date().toISOString() };
    if (!await this.store.transition(completed, 'executing')) return this.load(request.id);
    await this.auth.recordActivity({
      userId: request.executedByAccountId ?? request.requestedByAccountId,
      userLogin: request.approvedBy ?? request.requestedBy,
      action: request.action,
      targetType: 'user',
      targetId: request.targetId,
      summary: `${ACCOUNT_ACTION_LABELS[request.action]} · ${request.targetName} · ${request.id}`,
    });
    return completed;
  }

  private async load(id: string): Promise<AccountActionRequest> {
    const request = await this.store.get(id);
    if (!request) throw new AccountActionError(404, 'account_action_not_found', '账号操作申请不存在');
    return effectiveAccountAction(request);
  }

  private requirePending(request: AccountActionRequest): void {
    if (request.status !== 'pending') {
      throw new AccountActionError(409, 'account_action_closed', '此申请已结束，请查看回执或重新发起');
    }
  }

  private checkScope(actor: CdsUser, target: CdsUser, action: AccountAction): void {
    if (actor.id === target.id || target.isSystemOwner || (!actor.isSystemOwner && target.isAdministrator)) {
      throw new AccountActionError(403, 'account_action_forbidden', '当前身份不能对该账号发起此操作');
    }
    if (target.status !== 'active' || (action === 'revoke-admin' && !target.isAdministrator) ||
        (action === 'reset-password' && (target.authProvider !== 'local' || !target.passwordHash))) {
      throw new AccountActionError(409, 'invalid_account_state', '目标账号当前状态不支持此操作');
    }
  }
}
