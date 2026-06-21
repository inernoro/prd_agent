/**
 * Local username + password auth routes — coexists with GitHub OAuth.
 *
 * These mount in the same `CDS_AUTH_MODE=github` block as the OAuth routes so
 * the session gate (github-auth middleware) protects everything uniformly and
 * local + GitHub users share the exact same session-cookie mechanism.
 *
 * Endpoints (all under /api):
 *   GET  /api/auth/bootstrap-status   → public; { needsBootstrap } when zero users
 *   POST /api/auth/bootstrap          → public; create first local system-owner (only when zero users)
 *   POST /api/auth/login              → public; {username,password} → session cookie
 *   POST /api/auth/change-password    → authed; {oldPassword,newPassword}
 *   GET  /api/auth/users              → authed + system-owner; list users (no secrets)
 *   POST /api/auth/users              → authed + system-owner; create local user
 *   PATCH /api/auth/users/:id         → authed + system-owner; enable/disable / reset password
 *   GET  /api/auth/activity           → authed; owner sees all, others see only their own
 *
 * The cookie name + flags are shared with the OAuth router (GH_SESSION_COOKIE)
 * so a local login is indistinguishable from an OAuth login downstream.
 */

import { Router, type Request, type Response } from 'express';
import { AuthService, LocalAuthError } from '../services/auth-service.js';
import { GH_SESSION_COOKIE } from './auth.js';
import { toPublicUser, type CdsUser } from '../domain/auth.js';

export interface AuthLocalRouterDeps {
  authService: AuthService;
  /** Set to true for HTTPS environments; cookies get the Secure flag. */
  cookieSecure: boolean;
}

interface AuthedRequest extends Request {
  cdsUser?: CdsUser;
}

function buildSessionCookie(token: string, expiresAt: string, secure: boolean): string {
  const maxAgeSec = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const parts = [
    `${GH_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
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
      return 409;
    case 'username_invalid':
    case 'password_too_short':
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
  const { authService, cookieSecure } = deps;

  // ── First-run bootstrap (public) ──
  router.get('/auth/bootstrap-status', async (_req: Request, res: Response) => {
    const needsBootstrap = !(await authService.hasAnyUser());
    res.json({ needsBootstrap });
  });

  router.post('/auth/bootstrap', async (req: Request, res: Response) => {
    const { username, password, name } = req.body || {};
    try {
      const user = await authService.bootstrapFirstLocalUser({
        username: String(username || ''),
        password: String(password || ''),
        name: typeof name === 'string' ? name : undefined,
      });
      const session = await authService.createSessionForUser(user.id, {
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
      res.setHeader('Set-Cookie', buildSessionCookie(session.token, session.expiresAt, cookieSecure));
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
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: '请输入用户名和密码' });
      return;
    }
    const user = await authService.verifyLocalLogin(String(username), String(password));
    if (!user) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    const session = await authService.createSessionForUser(user.id, {
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
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, session.expiresAt, cookieSecure));
    res.json({ user: toPublicUser(user) });
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

  // ── User management (authed + system-owner only) ──
  function requireOwner(req: AuthedRequest, res: Response): CdsUser | null {
    const me = req.cdsUser;
    if (!me) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    if (!me.isSystemOwner) {
      res.status(403).json({ error: '仅系统所有者可管理用户' });
      return null;
    }
    return me;
  }

  router.get('/auth/users', async (req: AuthedRequest, res: Response) => {
    if (!requireOwner(req, res)) return;
    const users = await authService.listUsers();
    res.json({ users: users.map(toPublicUser) });
  });

  router.post('/auth/users', async (req: AuthedRequest, res: Response) => {
    const me = requireOwner(req, res);
    if (!me) return;
    const { username, password, name, isSystemOwner } = req.body || {};
    try {
      const user = await authService.createLocalUser({
        username: String(username || ''),
        password: String(password || ''),
        name: typeof name === 'string' ? name : undefined,
        isSystemOwner: isSystemOwner === true,
      });
      await authService.recordActivity({
        userId: me.id,
        userLogin: me.username || me.githubLogin,
        action: 'create-user',
        summary: `创建本地账号 ${user.username}`,
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
      });
      res.status(201).json({ user: toPublicUser(user) });
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
    const me = requireOwner(req, res);
    if (!me) return;
    const targetId = req.params.id;
    const { status, newPassword } = req.body || {};
    try {
      let result: CdsUser | null = await authService.findUserById(targetId);
      if (!result) {
        res.status(404).json({ error: '用户不存在' });
        return;
      }
      // 先做"可能失败"的密码重置，再做状态变更：否则状态会先落库，密码重置抛错
      // （如目标是 GitHub 账号 not_local_account）后状态已改却返回错误，无原子回滚
      // （修复 PR #865 Bugbot Medium「PATCH user applies status before password」）。
      if (typeof newPassword === 'string' && newPassword.length > 0) {
        // Admin reset: skip old-password check (caller is system owner).
        await authService.changePassword(targetId, '', newPassword, true);
        await authService.recordActivity({
          userId: me.id,
          userLogin: me.username || me.githubLogin,
          action: 'reset-password',
          summary: `重置账号 ${result?.username || result?.githubLogin} 的密码`,
          targetType: 'user',
          targetId,
          ip: clientIp(req),
        });
      }
      if (status === 'active' || status === 'disabled') {
        if (status === 'disabled' && targetId === me.id) {
          res.status(400).json({ error: '不能禁用自己的账号' });
          return;
        }
        result = await authService.setUserStatus(targetId, status);
        await authService.recordActivity({
          userId: me.id,
          userLogin: me.username || me.githubLogin,
          action: status === 'disabled' ? 'disable-user' : 'enable-user',
          summary: `${status === 'disabled' ? '禁用' : '启用'}账号 ${result?.username || result?.githubLogin}`,
          targetType: 'user',
          targetId,
          ip: clientIp(req),
        });
      }
      const fresh = (await authService.findUserById(targetId)) ?? result;
      res.json({ user: fresh ? toPublicUser(fresh) : null });
    } catch (err) {
      if (err instanceof LocalAuthError) {
        res.status(localErrStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[auth-local] patch-user failed:', err);
      res.status(500).json({ error: '更新用户失败' });
    }
  });

  // ── Activity / trace log (authed) ──
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
    const activity = await authService.listActivity({ userId, limit });
    res.json({ activity });
  });

  return router;
}
