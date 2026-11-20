import type { RequestHandler } from 'express';
import { CDS_BROWSER_COOKIE_NAMES, readBrowserCookie } from '../services/browser-session-cookies.js';

const loginNavigation = /^\/api\/(?:oidc\/auth(?:\/[A-Za-z0-9_-]+)?|hosted-sso\/interaction\/[A-Za-z0-9_-]+|auth\/github\/(?:login|callback)|auth\/sso\/start)$/;
const loginMutation = /^\/api\/(?:login|auth\/(?:login|bootstrap|sso\/exchange))\/?$/i;

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return 'null'; }
}

/** Hosted sibling pages share SameSite with CDS, but never share its request origin. */
export function protectControlBrowser(authority: URL): RequestHandler {
  return (req, res, next) => {
    if (req.get('x-cds-internal') === '1' && req.get('x-cds-source-host') && req.headers.cookie) {
      // Preview passthrough can carry cookies issued by the project host. Their
      // names do not make them control-plane browser credentials.
      const allowed = req.headers.cookie.split(';').filter(cookie => !CDS_BROWSER_COOKIE_NAMES.includes(cookie.trim().split('=', 1)[0]));
      if (allowed.length) req.headers.cookie = allowed.join(';');
      else delete req.headers.cookie;
    }
    if (req.get('host')?.toLowerCase() !== authority.host) { next(); return; }
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!/^\/api(?:\/|$)/i.test(req.path)) { next(); return; }
    res.set('Cross-Origin-Resource-Policy', 'same-origin');

    const origin = req.get('origin');
    const referer = originOf(req.get('referer'));
    const source = req.get('sec-fetch-site');
    const external = source === 'same-site' || source === 'cross-site'
      || Boolean(origin && origin !== authority.origin) || Boolean(referer && referer !== authority.origin);
    const sameOrigin = origin === authority.origin || referer === authority.origin || source === 'same-origin';
    const mode = req.get('sec-fetch-mode');
    const navigation = req.method === 'GET'
      && (mode === 'navigate' && req.get('sec-fetch-dest') === 'document' || !mode && !origin);
    const cookieAuth = CDS_BROWSER_COOKIE_NAMES.some(name => readBrowserCookie(req.get('cookie'), name) !== undefined);
    const interactive = cookieAuth || loginMutation.test(req.path);
    if ((!external && (!interactive || sameOrigin || (source === 'none' && navigation)))
      || (navigation && loginNavigation.test(req.path))) {
      next();
      return;
    }
    res.status(403).json({ error: '请在 CDS 页面内完成此操作。', code: 'cds_browser_origin_required' });
  };
}
