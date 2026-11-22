import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AccountActionRequest } from '../domain/account-actions.js';
import type { CdsUser } from '../domain/auth.js';
import { AccountActionError, publicAccountAction } from '../services/account-actions.js';
import type { AuthService } from '../services/auth-service.js';
import { isHumanSystemOwner } from '../services/human-auth.js';
import { MIN_PASSWORD_LENGTH } from '../services/password.js';

interface SystemPasswordDeps {
  authService: AuthService;
  target: { id: string; name: string };
  currentGeneration: () => string;
  sessions: () => Promise<Awaited<ReturnType<AuthService['systemBrowserSessions']>>>;
  verifyPassword: (password: string) => boolean;
  rotate: (current: string, replacement: string, generation: string, expectedGeneration: string) => void;
}

export function createSystemPasswordRouter(deps: SystemPasswordDeps): Router {
  const router = Router();
  const { authService, target } = deps;

  function ownerRoute(handle: (req: Request, res: Response, user: CdsUser) => Promise<void>) {
    return async (req: Request, res: Response): Promise<void> => {
      const user = (req as Request & { cdsUser?: CdsUser }).cdsUser;
      if (!user || !isHumanSystemOwner(req)) {
        res.status(user ? 403 : 401).json({ code: 'system_owner_required', error: '此操作需要已验证的系统所有者' });
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      try { await handle(req, res, user); }
      catch (error) {
        if (error instanceof AccountActionError) res.status(error.status).json({ error: error.message, code: error.code });
        else res.status(503).json({ code: 'system_password_readback_required', error: '无法确认当前执行结果，请从账号审计回读原申请' });
      }
    };
  }

  function requestStore() {
    const store = authService.accountActions;
    if (!store) throw new AccountActionError(503, 'account_actions_unavailable', '审批记录存储暂不可用');
    return store;
  }

  router.get('/auth/system-password', ownerRoute(async (_req, res) => {
    res.json({
      account: { id: target.id, name: target.name },
      available: Boolean(authService.accountActions),
      sessions: await deps.sessions(),
    });
  }));

  router.post('/auth/system-password/prepare', ownerRoute(async (req, res, user) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500 || req.body?.newPassword !== undefined || req.body?.oldPassword !== undefined) {
      throw new AccountActionError(400, 'invalid_account_action', '请填写 3–500 字的变更原因');
    }
    const store = requestStore();
    const now = new Date();
    const revision = deps.currentGeneration();
    const affectedSessions = (await deps.sessions()).length;
    const pending = (await store.list({ targetId: target.id, requestedByAccountId: user.id, action: 'rotate-system-password' }, 100))
      .find(item => item.status === 'pending' && item.expiresAt > now.toISOString() && item.targetRevision === revision &&
        item.reason === reason && item.affectedSessions === affectedSessions);
    const request: AccountActionRequest = pending ?? {
      id: randomUUID(),
      action: 'rotate-system-password',
      status: 'pending',
      targetId: target.id,
      targetName: target.name,
      targetRole: 'owner',
      targetStatus: 'active',
      targetRevision: revision,
      affectedSessions,
      scope: 'all-system-sessions',
      reason,
      requestedByAccountId: user.id,
      requestedBy: user.username || user.githubLogin,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    };
    if (!pending) await store.insert(request);
    res.status(201).json({ request: publicAccountAction(request) });
  }));

  router.post('/auth/system-password/:id/confirm', ownerRoute(async (req, res, user) => {
    const store = requestStore();
    const request = await store.get(req.params.id);
    if (!request || request.action !== 'rotate-system-password' || request.targetId !== target.id) {
      throw new AccountActionError(404, 'account_action_not_found', '未找到这次系统账号变更');
    }
    if (request.requestedByAccountId !== user.id) {
      throw new AccountActionError(403, 'approval_actor_mismatch', '请由发起本次更改的所有者逐次确认');
    }
    if (request.status === 'completed') {
      res.json({ request: publicAccountAction(request) });
      return;
    }

    async function finish(applied: AccountActionRequest): Promise<AccountActionRequest> {
      const completed: AccountActionRequest = { ...applied, status: 'completed', decidedAt: new Date().toISOString() };
      if (!await store.transition(completed, 'executing')) return (await store.get(applied.id)) ?? applied;
      await authService.recordActivity({
        userId: user.id, userLogin: user.username || user.githubLogin,
        targetId: target.id, targetType: 'user', action: applied.action,
        summary: `确认变更系统账号口令 · ${applied.id}`,
      });
      return completed;
    }

    if (request.status === 'executing' && deps.currentGeneration() === request.id) {
      res.json({ request: publicAccountAction(await finish(request)) });
      return;
    }
    const retryable = request.status === 'failed' &&
      (request.failureCode === 'system_password_source_busy' || request.failureCode === 'system_password_source_mismatch');
    if ((request.status !== 'pending' && !retryable) || request.expiresAt <= new Date().toISOString() ||
        request.targetRevision !== deps.currentGeneration()) {
      throw new AccountActionError(409, 'account_action_closed', '此申请已结束或系统账号已变更，请重读后重新发起');
    }
    const { targetName, oldPassword, newPassword, notify } = req.body || {};
    if (targetName !== target.name || notify !== true) {
      throw new AccountActionError(400, 'system_confirmation_required', '请确认目标账号及全部旧会话退出的影响');
    }
    if (typeof oldPassword !== 'string' || !deps.verifyPassword(oldPassword)) {
      throw new AccountActionError(400, 'invalid_credentials', '原密码不正确');
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 512) {
      throw new AccountActionError(400, 'password_too_short', `口令需为 ${MIN_PASSWORD_LENGTH}–512 位`);
    }
    if (/[\u0000\r\n]/.test(newPassword) || newPassword === oldPassword) {
      throw new AccountActionError(400, 'invalid_new_password', '请设置不同且不含换行的口令');
    }
    if ((await deps.sessions()).length > request.affectedSessions) {
      throw new AccountActionError(409, 'account_impact_changed', '系统账号会话有增加，请重新查看影响并发起申请');
    }
    const executing: AccountActionRequest = {
      ...request, status: 'executing', approvedAt: new Date().toISOString(),
      approvedByAccountId: user.id, approvedBy: user.username || user.githubLogin, executedByAccountId: user.id,
      notifiedAt: new Date().toISOString(),
    };
    if (!await store.transition(executing, request.status)) {
      throw new AccountActionError(409, 'account_action_in_progress', '正在执行，请回读原申请');
    }
    try { deps.rotate(oldPassword, newPassword, request.id, request.targetRevision ?? ''); }
    catch (error) {
      const failure = error instanceof AccountActionError ? error
        : new AccountActionError(503, 'system_password_update_failed', '系统账号口令保存失败');
      await store.transition({ ...executing, status: 'failed', decidedAt: new Date().toISOString(), failureCode: failure.code }, 'executing');
      throw failure;
    }
    res.json({ request: publicAccountAction(await finish(executing)) });
  }));
  return router;
}
