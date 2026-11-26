/**
 * Local username + password auth routes — independent from the login provider.
 *
 * GitHub OAuth and legacy CDS_USERNAME/CDS_PASSWORD may both coexist with this
 * router, but neither is a prerequisite for the persisted local-user model.
 *
 * Endpoints (all under /api):
 *   GET  /api/auth/bootstrap-status   → public; { needsBootstrap } when zero users
 *   POST /api/auth/bootstrap          → public; create first local system-owner (only when zero users)
 *   POST /api/auth/login              → public; {username,password} → session cookie
 *   POST /api/auth/change-password    → authed; {oldPassword,newPassword}
 *   GET  /api/auth/users              → owner or admin, within assigned account scope
 *   POST /api/auth/users              → owner or admin; provision a personal account
 *   PATCH /api/auth/users/:id         → owner; low-risk changes, including enabling an account
 *   GET  /api/auth/activity           → authed; owner sees all, others see only their own
 *
 * The cookie name + flags are shared with the OAuth router (GH_SESSION_COOKIE)
 * so a local login is indistinguishable from an OAuth login downstream.
 */

import { Router, type Request, type Response } from 'express';
import { AuthService, LocalAuthError } from '../services/auth-service.js';
import {
  buildLegacyLogoutCookie,
  buildLogoutCookie,
  buildAccountSessionCookies,
  buildSsoLogoutCookie,
  GH_SESSION_COOKIE,
} from './auth.js';
import { accountRole, toPublicUser, type AccountIdentityProvider, type CdsUser, type PublicCdsUser, type UserActivityRecord } from '../domain/auth.js';
import { AccountActionError, AccountActionsService, publicAccountAction } from '../services/account-actions.js';
import type { StateService } from '../services/state.js';
import { isHumanSystemOwner } from '../services/human-auth.js';
import { humanPrincipalId, canManageAccountScope, beginHumanProjectGrantUpdate, boundedHumanAccessFlush,
  markHumanProjectGrantRecovery, reconcileHumanAccessRestore, type FinishHumanAccessUpdate } from '../services/human-project-access.js';

export interface LegacyLocalLoginResult {
  user: PublicCdsUser;
  setCookie: string;
  proofCookies?: string[];
}

import { readBrowserCookie, sessionCookieName } from '../services/browser-session-cookies.js';

export interface AuthLocalRouterDeps {
  authService: AuthService;
  /** Production servers synchronize linked machine credentials with account status. */
  stateService?: StateService;
  /** Set to true for HTTPS environments; cookies get the Secure flag. */
  cookieSecure: boolean;
  hostSessionCookies?: boolean;
  /**
   * Whether the auth store is durable (mongo). The public first-run bootstrap
   * endpoint is only safe on a persistent store: a volatile (memory) store is
   * empty after every restart, so bootstrap would re-open and let the first
   * visitor seize `isSystemOwner` in a reachable github-mode deployment
   * (PR #865 Codex P1). When false, bootstrap is disabled.
   */
  bootstrapAllowed: boolean;
  /**
   * Compatibility hook for the original CDS_USERNAME/CDS_PASSWORD account.
   * It runs before persisted local-account verification, so the original
   * credential keeps deterministic ownership even if old data contains the
   * same username.
   */
  legacyLogin?: (
    input: { username: string; password: string },
    req: Request,
  ) => Promise<LegacyLocalLoginResult | null> | LegacyLocalLoginResult | null;
  /** Usernames owned by external/legacy providers and unavailable for creation. */
  reservedUsernames?: string[];
  systemPasswordActivity?: () => UserActivityRecord[];
  availableProviders?: Partial<Record<AccountIdentityProvider, boolean>>;
}

interface AuthedRequest extends Request {
  cdsUser?: CdsUser;
}

function sessionToken(req: Request, hostSessionCookies: boolean): string | null {
  return readBrowserCookie(req.headers.cookie, sessionCookieName(GH_SESSION_COOKIE, hostSessionCookies)) ?? null;
}

function clientIp(req: Request): string | null {
  return (
    (req.headers['cf-connecting-ip'] as string) ||
    ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? null) ||
    req.ip ||
    null
  );
}

function localErrStatus(err: LocalAuthError): number {
  switch (err.code) {
    case 'username_taken':
    case 'account_changed':
      return 409;
    case 'username_invalid':
    case 'password_too_short':
    case 'password_reused':
      return 400;
    case 'invalid_credentials':
    case 'not_local_account':
      return 400;
    case 'user_not_found':
      return 404;
    case 'disabled':
      return 403;
    default:
      return 500;
  }
}

export function createAuthLocalRouter(deps: AuthLocalRouterDeps): Router {
  const router = Router();
  const { authService, cookieSecure, hostSessionCookies = false, bootstrapAllowed, legacyLogin } = deps;
  const reservedUsernames = new Set(
    (deps.reservedUsernames ?? []).map((username) => String(username).trim().toLowerCase()),
  );

  // ── First-run bootstrap (public) ──
  router.get('/auth/bootstrap-status', async (_req: Request, res: Response) => {
    // 易失存储后端不开放 bootstrap（见 AuthLocalRouterDeps.bootstrapAllowed）。
    const needsBootstrap = bootstrapAllowed && !(await authService.hasAnyUser());
    res.json({ needsBootstrap });
  });

  router.post('/auth/bootstrap', async (req: Request, res: Response) => {
    if (!bootstrapAllowed) {
      // 易失(memory)后端重启即清空，公开 bootstrap 会被重复利用自封 owner。
      res.status(403).json({
        error: '本地账号初始化需要持久化存储后端（mongo）。当前为易失存储，已禁用引导。',
        code: 'bootstrap_unavailable',
      });
      return;
    }
    const { username, password, name } = req.body || {};
    try {
      const user = await authService.bootstrapFirstLocalUser({
        username: String(username || ''),
        password: String(password || ''),
        name: typeof name === 'string' ? name : undefined,
      });
      const session = await authService.createSessionForUser(user, {
        userAgent: (req.headers['user-agent'] as string) || null,
        ipAddress: clientIp(req),
      });
      await authService.recordActivity({
        userId: user.id,
        userLogin: user.username || user.githubLogin,
        action: 'bootstrap',
        summary: '首次启动创建本地系统所有者账号',
        ip: clientIp(req),
      });
      res.setHeader('Set-Cookie', [
        ...buildAccountSessionCookies(session, cookieSecure, hostSessionCookies),
        buildLegacyLogoutCookie(cookieSecure, hostSessionCookies),
        buildSsoLogoutCookie(cookieSecure, hostSessionCookies),
      ]);
      res.json({ user: toPublicUser(user) });
    } catch (err) {
      if (err instanceof LocalAuthError) {
        res.status(localErrStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[auth-local] bootstrap failed:', err);
      res.status(500).json({ error: '初始化账号失败' });
    }
  });

  // ── Local login (public) ──
  router.post('/auth/login', async (req: Request, res: Response) => {
    const { username, password, newPassword } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: '请输入用户名和密码' });
      return;
    }
    try {
      const normalizedUsername = String(username);
      const normalizedPassword = String(password);
      const legacy = await legacyLogin?.(
        { username: normalizedUsername, password: normalizedPassword },
        req,
      );
      if (legacy) {
        res.setHeader('Set-Cookie', [
          legacy.setCookie,
          buildLogoutCookie(cookieSecure, hostSessionCookies),
          buildSsoLogoutCookie(cookieSecure, hostSessionCookies),
          ...(legacy.proofCookies ?? []),
        ]);
        res.json({ user: legacy.user });
        return;
      }
      let user = await authService.verifyLocalLogin(normalizedUsername, normalizedPassword);
      if (!user) {
        res.status(401).json({ error: '用户名或密码错误' });
        return;
      }
      if (user.temporaryPassword) {
        res.setHeader('Cache-Control', 'private, no-store');
        if (newPassword === undefined) {
          res.status(409).json({ code: 'initial_password_change_required', error: '请设置个人口令后登录' });
          return;
        }
        user = await authService.completeTemporaryPassword(user, newPassword);
        await authService.recordActivity({
          userId: user.id, userLogin: user.username || user.githubLogin, action: 'change-password',
          summary: '首次登录设置个人口令', ip: clientIp(req),
        });
      }
      const session = await authService.createSessionForUser(user, {
        userAgent: (req.headers['user-agent'] as string) || null,
        ipAddress: clientIp(req),
      });
      await authService.recordActivity({
        userId: user.id,
        userLogin: user.username || user.githubLogin,
        action: 'login',
        summary: '本地账号登录',
        ip: clientIp(req),
      });
      res.setHeader('Set-Cookie', [
        ...buildAccountSessionCookies(session, cookieSecure, hostSessionCookies),
        buildLegacyLogoutCookie(cookieSecure, hostSessionCookies),
        buildSsoLogoutCookie(cookieSecure, hostSessionCookies),
      ]);
      res.json({ user: toPublicUser(user) });
    } catch (err) {
      if (err instanceof LocalAuthError) {
        res.status(localErrStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      // 存储后端在 verifyLocalLogin / 建会话 / 记活动时拒绝时，async Express 4
      // 处理器若不兜底会变成未处理 rejection，请求挂起甚至拖垮进程（修复 PR #865
      // Codex P2「catch local-login store failures」）。统一兜底 500。
      // eslint-disable-next-line no-console
      console.error('[auth-local] login failed:', err);
      res.status(500).json({ error: '登录失败' });
    }
  });

  // ── Local session logout ──
  // In GitHub mode the OAuth router registers the same path first; in basic
  // mode this handler owns it. Both clear the shared persisted-session cookie.
  router.post('/auth/logout', async (req: Request, res: Response) => {
    const token = sessionToken(req, hostSessionCookies);
    if (token) await authService.logout(token);
    res.setHeader('Set-Cookie', [
      buildLogoutCookie(cookieSecure, hostSessionCookies),
      buildLegacyLogoutCookie(cookieSecure, hostSessionCookies),
      buildSsoLogoutCookie(cookieSecure, hostSessionCookies),
    ]);
    res.json({ ok: true });
  });

  // ── Change own password (authed) ──
  router.post('/auth/change-password', async (req: AuthedRequest, res: Response) => {
    const me = req.cdsUser;
    if (!me) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const { oldPassword, newPassword } = req.body || {};
    try {
      await authService.changePassword(me.id, String(oldPassword || ''), String(newPassword || ''));
      await authService.recordActivity({
        userId: me.id,
        userLogin: me.username || me.githubLogin,
        action: 'change-password',
        summary: '修改了自己的密码',
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof LocalAuthError) {
        res.status(localErrStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[auth-local] change-password failed:', err);
      res.status(500).json({ error: '修改密码失败' });
    }
  });

  // ── Account management ──
  function requireAccountManager(req: AuthedRequest, res: Response, ownerOnly = false): CdsUser | null {
    const me = req.cdsUser;
    if (!me) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    if (me.authProvider === 'sso' || (!me.isSystemOwner && (ownerOnly || !me.isAdministrator))) {
      res.status(403).json({ error: ownerOnly ? '仅系统所有者可执行此操作' : '需要账号管理权限' });
      return null;
    }
    return me;
  }

  router.get('/auth/users', async (req: AuthedRequest, res: Response) => {
    const me = requireAccountManager(req, res);
    if (!me) return;
    try {
      const users = await authService.listUsers();
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        users: users.filter(user => me.isSystemOwner || user.id === me.id || accountRole(user) === 'member').map(user => ({
          ...toPublicUser(user), canManageAccount: canManageAccountScope(deps.stateService, me, user),
        })),
      });
    } catch {
      res.status(503).json({ error: '账号列表读取失败，请重试' });
    }
  });

  router.get('/auth/users/:id/impact', async (req: AuthedRequest, res: Response) => {
    const me = requireAccountManager(req, res);
    if (!me) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const user = await authService.findUserById(req.params.id);
      if (!user || user.id === me.id || user.isSystemOwner || (!me.isSystemOwner && user.isAdministrator)) {
        res.status(404).json({ error: '当前管理范围内没有该账号' });
        return;
      }
      const affectedSessions = await authService.countAccountSessions(user);
      res.json({ affectedSessions, canDisableImmediately: affectedSessions === 0 && accountRole(user) === 'member'
        && canManageAccountScope(deps.stateService, me, user) });
    } catch {
      res.status(503).json({ error: '会话影响读取失败，请重试' });
    }
  });

  router.post('/auth/users', async (req: AuthedRequest, res: Response) => {
    const me = requireAccountManager(req, res);
    if (!me) return;
    const { username, password, name, isSystemOwner, role, externalLoginAllowed, invite, temporaryPassword } = req.body || {};
    if (!me.isSystemOwner && (isSystemOwner === true || role === 'admin' || role === 'owner')) {
      res.status(403).json({ error: '仅系统所有者可创建授权账号' });
      return;
    }
    if (role !== undefined && role !== 'admin' && role !== 'member') {
      res.status(400).json({ error: '请选择成员或管理员' });
      return;
    }
    if (temporaryPassword !== undefined && typeof temporaryPassword !== 'boolean'
        || temporaryPassword === true && (invite === true || isSystemOwner === true)) {
      res.status(400).json({ error: '初始口令只可用于直接创建个人账号', code: 'invalid_initial_password_mode' });
      return;
    }
    try {
      const normalizedUsername = String(username || '').trim().toLowerCase();
      if (reservedUsernames.has(normalizedUsername)) {
        res.status(409).json({
          error: `用户名 ${normalizedUsername} 由原始管理员账号占用`,
          code: 'username_taken',
        });
        return;
      }
      const account = {
        username: normalizedUsername,
        name: typeof name === 'string' ? name : undefined,
        isAdministrator: role === 'admin',
        externalLoginAllowed: externalLoginAllowed === true,
        createdByAccountId: me.id,
      };
      if (invite === true && (password !== undefined || isSystemOwner === true)) {
        res.status(400).json({ error: '请选择一次性邀请，或填写初始口令创建账号' });
        return;
      }
      const activation = invite === true ? await authService.createAccountInvitation(account) : null;
      const user = activation?.user ?? await authService.createLocalUser({
        ...account, password: String(password || ''), isSystemOwner: isSystemOwner === true, temporaryPassword: temporaryPassword === true,
      });
      await authService.recordActivity({
        userId: me.id,
        userLogin: me.username || me.githubLogin,
        action: 'create-user',
        summary: `创建${role === 'admin' ? '管理员' : '本地'}账号 ${user.username}`,
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({
        user: toPublicUser(user),
        ...(activation ? { invitation: { path: `/login#invite=${activation.invitation}`, expiresAt: activation.expiresAt } } : {}),
      });
    } catch (err) {
      if (err instanceof LocalAuthError) {
        res.status(localErrStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[auth-local] create-user failed:', err);
      res.status(500).json({ error: '创建用户失败' });
    }
  });

  router.patch('/auth/users/:id', async (req: AuthedRequest, res: Response) => {
    const targetId = req.params.id;
    const { status, newPassword, role, externalLoginAllowed } = req.body || {};
    const bindingChange = status === undefined && newPassword === undefined && role === undefined
      && typeof externalLoginAllowed === 'boolean';
    const enableMember = status === 'active' && newPassword === undefined && role === undefined && externalLoginAllowed === undefined;
    const me = requireAccountManager(req, res, !bindingChange && !enableMember);
    if (!me) return;
    try {
      let result: CdsUser | null = await authService.findUserById(targetId);
      if (!result) {
        res.status(404).json({ error: '用户不存在' });
        return;
      }
      if (bindingChange) {
        if (!me.isSystemOwner && (result.id === me.id || accountRole(result) !== 'member')) {
          res.status(403).json({ error: '管理员只能为普通成员设置绑定资格' });
          return;
        }
        const current = await authService.setExternalLoginAllowed(result, externalLoginAllowed);
        if (!current) {
          res.status(409).json({ error: '账号已停用或权限有变化，请刷新当前成员' });
          return;
        }
        await authService.recordActivity({
          userId: me.id, userLogin: me.username || me.githubLogin,
          action: 'set-login-binding-eligibility', targetType: 'user', targetId,
          summary: externalLoginAllowed ? '开通本人绑定第三方账号资格' : '暂停新增第三方账号绑定资格',
        });
        res.json({ user: toPublicUser(current) });
        return;
      }
      if (newPassword !== undefined || status === 'disabled' || (role === 'member' && result.isAdministrator)) {
        res.status(409).json({ code: 'account_action_required', error: '请从「账号与登录」为这次操作逐次确认' });
        return;
      }
      if (role === 'admin') {
        if (status !== undefined || result.isSystemOwner || result.status !== 'active') {
          res.status(400).json({ error: '只能为单个启用的非所有者账号授予管理员角色' });
          return;
        }
        if (result.isAdministrator) {
          res.json({ user: toPublicUser(result) });
          return;
        }
        result = await authService.setUserAdministrator(targetId, true);
        if (!result) {
          res.status(409).json({ error: '账号状态已改变，请刷新后重试' });
          return;
        }
        await authService.recordActivity({
          userId: me.id,
          userLogin: me.username || me.githubLogin,
          action: 'grant-admin',
          summary: `授予账号 ${result.username || result.githubLogin} 管理员角色`,
          targetType: 'user',
          targetId,
          ip: clientIp(req),
        });
        res.json({ user: toPublicUser(result) });
        return;
      }
      if (status === 'active') {
        if (!me.isSystemOwner && !canManageAccountScope(deps.stateService, me, result)) {
          res.status(403).json({ error: '管理员只能启用当前管理范围内的普通成员' });
          return;
        }
        await setLinkedAccountStatus(deps.stateService, result, me, 'active', async () => {
          result = await authService.setUserStatus(targetId, 'active');
          if (!result) throw new AccountActionError(404, 'account_not_found', '目标账号不存在');
        });
        await authService.recordActivity({
          userId: me.id,
          userLogin: me.username || me.githubLogin,
          action: 'enable-user',
          summary: `启用账号 ${result?.username || result?.githubLogin}`,
          targetType: 'user',
          targetId,
          ip: clientIp(req),
        });
      }
      const fresh = (await authService.findUserById(targetId)) ?? result;
      res.json({ user: fresh ? toPublicUser(fresh) : null });
    } catch (err) {
      if (err instanceof AccountActionError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof LocalAuthError) {
        res.status(localErrStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: '更新用户失败' });
    }
  });

  const accountActions = new AccountActionsService(authService, (target, actor, apply) =>
    setLinkedAccountStatus(deps.stateService, target, actor, 'disabled', apply), deps.availableProviders,
    (actor, target) => canManageAccountScope(deps.stateService, actor, target));

  function accountActionRoute(
    ownerOnly: boolean,
    handle: (req: AuthedRequest, res: Response, actor: CdsUser) => Promise<void>,
  ) {
    return async (req: AuthedRequest, res: Response): Promise<void> => {
      const actor = requireAccountManager(req, res, ownerOnly);
      if (!actor) return;
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        await handle(req, res, actor);
      } catch (err) {
        if (err instanceof AccountActionError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        res.status(503).json({ error: '账号操作暂时无法确认，请刷新原申请', code: 'account_action_readback_required' });
      }
    };
  }

  router.get('/auth/account-actions', accountActionRoute(false, async (_req, res, actor) => {
    const requests = await accountActions.list(actor);
    res.json({ requests: requests.map(publicAccountAction) });
  }));
  router.get('/auth/account-actions/pending', accountActionRoute(true, async (_req, res, actor) => {
    const requests = await accountActions.list(actor);
    res.json({ pending: requests.filter(item => item.status === 'pending').length });
  }));
  router.post('/auth/account-actions', accountActionRoute(false, async (req, res, actor) => {
    const request = await accountActions.submit(actor, req.body || {});
    res.status(201).json({ request: publicAccountAction(request) });
  }));
  router.post('/auth/account-actions/:id/confirm', accountActionRoute(true, async (req, res, actor) => {
    const request = await accountActions.confirm(actor, req.params.id, req.body || {});
    res.json({ request: publicAccountAction(request) });
  }));
  router.post('/auth/account-actions/:id/reject', accountActionRoute(true, async (req, res, actor) => {
    const request = await accountActions.decide(actor, req.params.id, 'rejected', req.body?.reason);
    res.json({ request: publicAccountAction(request) });
  }));
  router.post('/auth/account-actions/:id/cancel', accountActionRoute(false, async (req, res, actor) => {
    const request = await accountActions.decide(actor, req.params.id, 'cancelled', req.body?.reason);
    res.json({ request: publicAccountAction(request) });
  }));
  router.get('/auth/account-action-audit', async (req: AuthedRequest, res: Response) => {
    const actor = req.cdsUser;
    if (!actor) {
      res.status(401).json({ error: '请登录后查看账号审计' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      res.json({ records: await accountActions.audit(actor, req.query) });
    } catch (error) {
      if (error instanceof AccountActionError) res.status(error.status).json({ code: error.code, error: error.message });
      else res.status(503).json({ error: '账号审计读取失败，请重试' });
    }
  });
  router.post('/auth/account-action-audit/backfill', accountActionRoute(true, async (req, res, actor) => {
    const request = await accountActions.backfill(actor, req.body || {});
    res.status(201).json({ request: publicAccountAction(request) });
  }));

  // ── Activity / trace log (authed) ──
  router.get('/auth/my-sessions', async (req: AuthedRequest, res: Response) => {
    const me = req.cdsUser;
    if (!me) { res.status(401).json({ error: '请先登录' }); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      res.json(await authService.personalBrowserSessions(me, sessionToken(req, hostSessionCookies)));
    } catch {
      res.status(503).json({ error: '本人会话读取失败，请重试' });
    }
  });
  router.get('/auth/activity', async (req: AuthedRequest, res: Response) => {
    const me = req.cdsUser;
    if (!me) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
    // System owner can query any user (or all); others are pinned to themselves.
    let userId: string | undefined;
    if (me.isSystemOwner) {
      userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;
    } else {
      userId = me.id;
    }
    try {
      const activity = await authService.listActivity({ userId, limit });
      if (deps.systemPasswordActivity && isHumanSystemOwner(req)) {
        activity.push(...deps.systemPasswordActivity().filter(row => !userId || row.userId === userId));
        activity.sort((a, b) => b.at.localeCompare(a.at));
      }
      res.json({ activity: activity.slice(0, limit) });
    } catch {
      res.status(503).json({ error: '无法完整读取用户操作痕迹，请稍后重试。' });
    }
  });

  return router;
}

/** Keep the account and linked machine credentials consistent when access changes. */
async function setLinkedAccountStatus(
  state: StateService | undefined,
  target: CdsUser,
  actor: CdsUser,
  status: CdsUser['status'],
  apply: () => Promise<void>,
): Promise<void> {
  if (!state) {
    await apply();
    return;
  }
  const principalId = humanPrincipalId(target.id);
  const changedBy = actor.username || actor.githubLogin;
  let finishUpdate: FinishHumanAccessUpdate | undefined = beginHumanProjectGrantUpdate(state, principalId, 'disabled') ?? undefined;
  if (!finishUpdate) {
    throw new AccountActionError(409, 'account_access_update_pending', '此账号的访问状态正在保存或恢复，请稍后刷新并重试');
  }
  let writing: Promise<void> | undefined;
  const changeCredentials = async () => {
    if (!state.getPrincipal(principalId)) return;
    state.setPrincipalStatus(principalId, status, changedBy);
    writing = state.flush();
    await boundedHumanAccessFlush(writing);
  };
  try {
    // Disable credentials first. Enable them only after the account is durable.
    if (status === 'disabled') await changeCredentials();
    await apply();
    if (status === 'active') await changeCredentials();
    const cleared = await finishUpdate();
    finishUpdate = undefined;
    if (cleared === false) {
      throw new AccountActionError(500, 'account_access_reconciliation_pending', '账号更新已保存，关联凭据正在核对，请刷新账号状态');
    }
  } catch (error) {
    if (!finishUpdate || !state.getPrincipal(principalId)) throw error;
    // Serialize compensation after an outstanding write and keep access paused.
    try { state.setPrincipalStatus(principalId, 'disabled', changedBy); }
    catch { /* Retry durable compensation after the outstanding write. */ }
    const restored = (writing || Promise.resolve()).catch(() => {}).then(async () => {
      state.save();
      await state.flush();
    });
    try {
      await boundedHumanAccessFlush(restored);
    } catch {
      markHumanProjectGrantRecovery(state, principalId);
      reconcileHumanAccessRestore(state, restored, finishUpdate);
      finishUpdate = undefined;
    }
    throw new AccountActionError(500, 'account_access_update_failed', '账号更新未能完整保存；关联机器凭据已暂停，请恢复存储后刷新账号状态并重试。');
  } finally {
    await finishUpdate?.();
  }
}
