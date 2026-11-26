import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AccountActionRequest } from '../domain/account-actions.js';
import { accountRole, type CdsUser } from '../domain/auth.js';
import { AccountActionError, effectiveAccountAction, publicAccountAction } from '../services/account-actions.js';
import type { AuthService } from '../services/auth-service.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from '../services/human-auth.js';

const ACTION = 'recover-identity' as const;
const lifetime = 7 * 24 * 60 * 60_000;

export function createAccountRecoveryRouters(auth: AuthService): { publicRouter: Router; managedRouter: Router } {
  const publicRouter = Router();
  const managedRouter = Router();
  const rate = new Map<string, { until: number; count: number }>();

  function store() {
    if (!auth.accountActions) throw new AccountActionError(503, 'account_recovery_unavailable', '身份恢复台账暂不可用');
    return auth.accountActions;
  }

  function cleaned(value: unknown, min: number): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length >= min && text.length <= 500 ? text : null;
  }

  async function intake(username: string, reason: string): Promise<void> {
    const user = await auth.findAccountByUsername(username);
    if (!user || user.isSystemOwner || user.authProvider !== 'local' || user.status !== 'active') return;
    const now = new Date();
    const previous = (await store().list({ targetId: user.id, action: ACTION }, 10))[0];
    if (previous && ['pending', 'verified', 'executing'].includes(effectiveAccountAction(previous, now).status)) return;
    const id = createHash('sha256').update(JSON.stringify([ACTION, user.id, previous?.id ?? null])).digest('hex');
    try {
      await store().insert({
        id, action: ACTION, status: 'pending',
        targetId: user.id, targetName: user.username || user.githubLogin, targetRole: accountRole(user), targetStatus: user.status,
        ...(user.sessionRevision ? { targetRevision: user.sessionRevision } : {}),
        affectedSessions: await auth.countAccountSessions(user), reason,
        requestedByAccountId: 'unverified', requestedBy: '登录页申请',
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + lifetime).toISOString(),
      });
    } catch (error) {
      if (!await store().get(id)) throw error;
    }
  }

  publicRouter.post('/auth/recovery-requests', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const reason = cleaned(req.body?.reason, 3);
    if (!/^[a-z0-9._-]{3,32}$/.test(username) || !reason) {
      res.status(400).json({ code: 'invalid_recovery_request', error: '请填写账号和 3–500 字的恢复说明' });
      return;
    }
    const now = Date.now();
    for (const [source, state] of rate) if (state.until <= now) rate.delete(source);
    const source = req.ip || 'unknown';
    const state = rate.get(source) ?? { until: now + 60 * 60_000, count: 0 };
    if (rate.size < 500 && state.count < 10) {
      state.count++;
      rate.set(source, state);
      // The public response does not depend on whether this account exists.
      void intake(username, reason).catch(() => {});
    }
    res.status(202).json({ accepted: true });
  });

  function manager(op: (req: Request, res: Response, actor: CdsUser) => Promise<void>, owner = false) {
    return async (req: Request, res: Response): Promise<void> => {
      const actor = (req as Request & { cdsUser?: CdsUser }).cdsUser;
      if (!actor || !isAuthenticatedHuman(req) || actor.authProvider === 'sso') {
        res.status(401).json({ error: '请登录后查看恢复申请' });
        return;
      }
      if (!isHumanSystemOwner(req) && (owner || !actor.isAdministrator)) {
        res.status(403).json({ error: '当前账号不能处理此恢复申请' });
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      try { await op(req, res, actor); }
      catch (error) {
        if (error instanceof AccountActionError) res.status(error.status).json({ code: error.code, error: error.message });
        else res.status(503).json({ code: 'account_recovery_unavailable', error: '暂时无法处理恢复申请，请回读当前状态' });
      }
    };
  }

  async function load(id: string, actor: CdsUser) {
    const item = await store().get(id);
    const target = item?.action === ACTION ? await auth.findUserById(item.targetId) : null;
    if (!item || !target || target.isSystemOwner || target.id === actor.id || (!actor.isSystemOwner && target.isAdministrator)) {
      throw new AccountActionError(404, 'recovery_not_found', '当前管理范围没有此恢复申请');
    }
    return { request: effectiveAccountAction(item), target };
  }

  managedRouter.get('/auth/recovery-requests', manager(async (_req, res, actor) => {
    const requests = await store().list({ action: ACTION }, 200);
    const members = actor.isSystemOwner ? null : new Set((await auth.listUsers()).filter(user => accountRole(user) === 'member').map(user => user.id));
    const visible = members ? requests.filter(request => request.targetRole === 'member' && members.has(request.targetId)) : requests;
    res.json({ requests: visible.map(publicAccountAction) });
  }));

  managedRouter.post('/auth/recovery-requests/:id/verify', manager(async (req, res, actor) => {
    const { request } = await load(req.params.id, actor);
    const evidence = cleaned(req.body?.evidence, 3);
    if (!evidence) throw new AccountActionError(400, 'recovery_evidence_required', '请登记身份核实依据');
    const verified: AccountActionRequest = {
      ...request, status: 'verified',
      verification: { byAccountId: actor.id, by: actor.username || actor.githubLogin, at: new Date().toISOString(), evidence },
    };
    if (request.status !== 'pending' || !await store().transition(verified, 'pending')) {
      throw new AccountActionError(409, 'recovery_not_pending', '申请已变更，请重新读取');
    }
    res.json({ request: publicAccountAction(verified) });
  }));

  managedRouter.post('/auth/recovery-requests/:id/approve', manager(async (req, res, actor) => {
    const { request, target } = await load(req.params.id, actor);
    if (request.status === 'completed') {
      res.json({ request: publicAccountAction(request) });
      return;
    }
    if (request.status !== 'verified' || !request.verification) {
      throw new AccountActionError(409, 'recovery_verification_required', '请先核实身份');
    }
    if (request.verification.byAccountId === actor.id) {
      throw new AccountActionError(403, 'separate_approver_required', '核实人和批准人必须不同');
    }
    if (req.body?.targetName !== request.targetName) {
      throw new AccountActionError(400, 'account_name_mismatch', '请输入目标账号名');
    }
    if (target.status !== 'active' || target.sessionRevision !== request.targetRevision || accountRole(target) !== request.targetRole) {
      throw new AccountActionError(409, 'account_impact_changed', '账号状态已变更，请重新核实身份');
    }
    const executing: AccountActionRequest = {
      ...request, status: 'executing', approvedAt: new Date().toISOString(),
      approvedByAccountId: actor.id, approvedBy: actor.username || actor.githubLogin, executedByAccountId: actor.id,
    };
    if (!await store().transition(executing, 'verified')) {
      throw new AccountActionError(409, 'recovery_in_progress', '此申请正在处理，请重新读取');
    }
    try {
      const invitation = await auth.issueRecoveryInvitation(target);
      if (!invitation) throw new AccountActionError(409, 'account_impact_changed', '无法保存恢复链接，请重新核实身份');
      const completed: AccountActionRequest = { ...executing, status: 'completed', decidedAt: new Date().toISOString() };
      if (!await store().transition(completed, 'executing')) {
        throw new AccountActionError(409, 'recovery_in_progress', '恢复台账正在更新，请重新读取');
      }
      res.json({ request: publicAccountAction(completed), invitation });
    } catch (error) {
      await store().transition({ ...executing, status: 'failed', decidedAt: new Date().toISOString(), failureCode: 'recovery_issue_failed' }, 'executing');
      throw error;
    }
  }, true));

  return { publicRouter, managedRouter };
}
