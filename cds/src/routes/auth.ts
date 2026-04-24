/**
 * GitHub OAuth routes — P2 implementation.
 *
 * Endpoints:
 *   GET  /api/auth/github/login       → 302 to GitHub authorize URL
 *   GET  /api/auth/github/callback    → handles OAuth callback, creates session cookie
 *   POST /api/auth/logout             → destroys the session
 *   GET  /api/me                      → returns the current authenticated user
 *
 * These routes only become functional when CDS is started with
 *   CDS_AUTH_MODE=github
 *   CDS_GITHUB_CLIENT_ID=...
 *   CDS_GITHUB_CLIENT_SECRET=...
 *   CDS_ALLOWED_ORGS=org1,org2
 *
 * At other modes (`disabled` default, `basic` for legacy username/password),
 * the routes are NOT mounted — see server.ts.
 */

import { Router, type Request, type Response } from 'express';
import { AuthService, AuthServiceError } from '../services/auth-service.js';

/** Cookie name used for the GitHub session token. Keeps `cds_token` free for legacy auth. */
export const GH_SESSION_COOKIE = 'cds_gh_session';

export interface AuthRouterDeps {
  authService: AuthService;
  /** Absolute public URL base (e.g. https://cds.example.com). Used for GitHub redirect_uri. */
  publicBaseUrl: string;
  /** Set to true for HTTPS environments; cookies get the Secure flag. */
  cookieSecure: boolean;
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
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

function buildLogoutCookie(secure: boolean): string {
  const parts = [
    `${GH_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const { authService, publicBaseUrl, cookieSecure } = deps;

  // The GitHub OAuth App must have this exact URL registered as a
  // callback URL. Kept as a constant here so admins know what to enter
  // in the GitHub Developer Settings screen.
  const redirectUri = `${publicBaseUrl.replace(/\/$/, '')}/api/auth/github/callback`;

  router.get('/auth/github/login', (req: Request, res: Response) => {
    const postLogin = typeof req.query.redirect === 'string' ? req.query.redirect : '/project-list';
    const { authorizeUrl } = authService.startLogin(redirectUri, postLogin);
    res.redirect(302, authorizeUrl);
  });

  router.get('/auth/github/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    if (!code || !state) {
      res.status(400).send(renderErrorPage('缺少 code 或 state 参数', '/login-gh.html'));
      return;
    }

    try {
      const result = await authService.handleCallback({
        code,
        state,
        redirectUri,
        userAgent: (req.headers['user-agent'] as string) || null,
        ipAddress:
          (req.headers['cf-connecting-ip'] as string) ||
          ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? null) ||
          req.ip ||
          null,
      });

      res.setHeader('Set-Cookie', buildSessionCookie(result.session.token, result.session.expiresAt, cookieSecure));
      res.redirect(302, result.redirect || '/project-list');
    } catch (err) {
      if (err instanceof AuthServiceError) {
        const status = err.code === 'org_not_allowed' ? 403 : err.code === 'state_mismatch' ? 400 : 500;
        res.status(status).send(renderErrorPage(formatError(err), '/login-gh.html'));
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[auth] callback failed:', err);
      res.status(500).send(renderErrorPage('登录过程中发生未知错误，请稍后重试', '/login-gh.html'));
    }
  });

  router.post('/auth/logout', async (req: Request, res: Response) => {
    const token = parseCookie(req.headers.cookie, GH_SESSION_COOKIE);
    if (token) {
      await authService.logout(token);
    }
    res.setHeader('Set-Cookie', buildLogoutCookie(cookieSecure));
    res.json({ ok: true });
  });

  router.get('/me', async (req: Request, res: Response) => {
    const token = parseCookie(req.headers.cookie, GH_SESSION_COOKIE);
    const result = await authService.validateSession(token ?? null);
    if (!result) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const { user, session } = result;
    res.json({
      user: {
        id: user.id,
        githubLogin: user.githubLogin,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        orgs: user.orgs,
        isSystemOwner: user.isSystemOwner,
      },
      session: {
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      },
    });
  });

  return router;
}

function formatError(err: AuthServiceError): string {
  switch (err.code) {
    case 'state_mismatch':
      return 'CSRF 校验失败：OAuth state token 无效或已过期，请重新登录';
    case 'invalid_state':
      return 'CSRF 校验失败：state 参数缺失';
    case 'org_not_allowed':
      return `账号未通过组织白名单：${err.message}`;
    case 'oauth_upstream':
      return `GitHub OAuth 流程失败：${err.message}`;
    case 'bootstrap_failed':
      return `首次登录初始化失败：${err.message}`;
    default:
      return '登录失败';
  }
}

function renderErrorPage(message: string, retryUrl: string): string {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>登录失败</title>
<style>body{background:#131314;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1E1F20;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:32px;max-width:480px;text-align:center}h1{font-size:18px;margin:0 0 12px;color:#f43f5e}p{font-size:13px;color:#a1a1aa;line-height:1.6;margin:0 0 20px}a{display:inline-block;padding:9px 18px;background:#10b981;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600}a:hover{background:#059669}</style>
</head><body><div class="card"><h1>登录失败</h1><p>${safe}</p><a href="${retryUrl}">返回登录</a></div></body></html>`;
}
