/**
 * GitHub auth middleware — P2 session gate.
 *
 * When CDS is started with CDS_AUTH_MODE=github, this middleware is
 * mounted before the route layer to enforce that requests carry a
 * valid GitHub session cookie. Unauthenticated browser requests are
 * redirected to /login-gh.html; unauthenticated API requests get 401.
 *
 * Routes that MUST remain open (OAuth start/callback, static assets
 * for the login page itself) are listed in `PUBLIC_PATHS` below.
 *
 * The middleware DOES NOT replace the existing CDS_USERNAME/CDS_PASSWORD
 * basic-auth code path — server.ts only registers this middleware when
 * mode === 'github'. See server.ts for the mode routing.
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthService } from '../services/auth-service.js';
import { GH_SESSION_COOKIE } from '../routes/auth.js';

/** Paths that bypass the auth gate entirely. */
const PUBLIC_PATHS: (string | RegExp)[] = [
  '/healthz',
  '/login-gh.html',
  '/api/auth/github/login',
  '/api/auth/github/callback',
  // Static assets the login page needs before a session exists.
  '/style.css',
  '/favicon.svg',
  /^\/_next\//,
];

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((rule) => (typeof rule === 'string' ? rule === path : rule.test(path)));
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers['accept'];
  if (typeof accept !== 'string') return false;
  return accept.includes('text/html');
}

/**
 * Build the middleware. The factory shape mirrors the existing auth
 * middleware pattern in server.ts so we can swap them uniformly.
 */
export function createGithubAuthMiddleware(deps: {
  authService: AuthService;
}) {
  const { authService } = deps;

  return async function githubAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Always let public paths through — otherwise the login page can't
    // render assets before the user is authenticated.
    if (isPublicPath(req.path)) {
      next();
      return;
    }

    const token = parseCookie(req.headers.cookie, GH_SESSION_COOKIE);
    const result = await authService.validateSession(token ?? null);

    if (!result) {
      if (wantsHtml(req)) {
        const redirect = encodeURIComponent(req.originalUrl || req.url || '/projects.html');
        res.redirect(302, `/login-gh.html?redirect=${redirect}`);
        return;
      }
      res.status(401).json({ error: 'unauthenticated', loginUrl: '/login-gh.html' });
      return;
    }

    // Attach the authenticated user onto the request for downstream handlers.
    (req as any).cdsUser = result.user;
    (req as any).cdsSession = result.session;
    next();
  };
}
