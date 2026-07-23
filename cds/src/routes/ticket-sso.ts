import { Router, type Request, type Response } from 'express';
import type { CdsSsoConfig } from '../types.js';
import {
  TicketSsoSessionStore,
  TicketSsoStateStore,
  buildTicketSsoAuthorizationUrl,
  exchangeTicketSsoCode,
  publicTicketSsoConfig,
} from '../services/ticket-sso.js';

export const TICKET_SSO_COOKIE = 'cds_sso_session';

export interface TicketSsoRouterDeps {
  resolveConfig: () => CdsSsoConfig;
  publicBaseUrl?: string;
  cookieSecure: boolean;
  stateStore: TicketSsoStateStore;
  sessionStore: TicketSsoSessionStore;
  fetchImpl?: typeof fetch;
}

function externalCallbackUrl(req: Request, configuredBaseUrl?: string): string {
  if (configuredBaseUrl) {
    return `${configuredBaseUrl.replace(/\/$/, '')}/auth/sso`;
  }
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  const candidate = new URL(`${protocol}://${host}`);
  const isLocalHttp = candidate.protocol === 'http:'
    && (candidate.hostname === 'localhost' || candidate.hostname === '127.0.0.1');
  if (candidate.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('SSO_CALLBACK_PROTOCOL_INVALID');
  }
  candidate.pathname = '/auth/sso';
  candidate.search = '';
  candidate.hash = '';
  return candidate.toString().replace(/\/$/, '');
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const parts = [
    `${TICKET_SSO_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function logoutCookie(secure: boolean): string {
  const parts = [
    `${TICKET_SSO_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function ticketSsoIdentity(req: Request, store: TicketSsoSessionStore) {
  return store.get(parseCookie(req.headers.cookie, TICKET_SSO_COOKIE));
}

export function createTicketSsoPublicRouter(deps: TicketSsoRouterDeps): Router {
  const router = Router();

  router.get('/auth/sso/public-config', (_req, res) => {
    res.json(publicTicketSsoConfig(deps.resolveConfig()));
  });

  router.get('/auth/sso/start', (req, res) => {
    const config = deps.resolveConfig();
    const publicConfig = publicTicketSsoConfig(config);
    if (!publicConfig.enabled) {
      res.redirect(302, '/login?sso_error=not_configured');
      return;
    }
    let callbackUrl: string;
    try {
      callbackUrl = externalCallbackUrl(req, deps.publicBaseUrl);
    } catch {
      res.redirect(302, '/login?sso_error=invalid_callback');
      return;
    }
    const issued = deps.stateStore.issue(req.query.redirect, callbackUrl);
    res.redirect(302, buildTicketSsoAuthorizationUrl(config, callbackUrl, issued.state));
  });

  router.post('/auth/sso/exchange', async (req, res) => {
    const config = deps.resolveConfig();
    if (!publicTicketSsoConfig(config).enabled) {
      res.status(503).json({ error: 'SSO 尚未配置完成', code: 'sso_not_configured' });
      return;
    }
    const state = deps.stateStore.consume(req.body?.state);
    if (!state) {
      res.status(400).json({ error: 'SSO 登录状态无效或已过期', code: 'sso_state_invalid' });
      return;
    }
    try {
      const identity = await exchangeTicketSsoCode(
        config,
        req.body?.code,
        state.callbackUrl,
        deps.fetchImpl,
      );
      const session = deps.sessionStore.create(identity);
      res.setHeader(
        'Set-Cookie',
        sessionCookie(
          session.token,
          session.expiresAt,
          deps.cookieSecure || state.callbackUrl.startsWith('https://'),
        ),
      );
      res.json({
        success: true,
        redirect: state.redirect || config.defaultRedirect || '/project-list',
        user: {
          username: identity.username,
          name: identity.displayName,
          authProvider: config.providerId,
        },
      });
    } catch {
      res.status(401).json({
        error: 'SSO 一次性授权无效、已使用或已过期',
        code: 'sso_exchange_failed',
      });
    }
  });

  router.post('/auth/sso/logout', (req, res) => {
    deps.sessionStore.delete(parseCookie(req.headers.cookie, TICKET_SSO_COOKIE));
    res.setHeader('Set-Cookie', logoutCookie(deps.cookieSecure));
    res.json({ success: true });
  });

  return router;
}

export function createTicketSsoConfigRouter(deps: {
  getConfig: () => CdsSsoConfig;
  saveConfig: (config: CdsSsoConfig) => void;
  normalizeConfig: (input: Partial<CdsSsoConfig>) => CdsSsoConfig;
}): Router {
  const router = Router();

  router.get('/auth/sso/config', (_req: Request, res: Response) => {
    const config = deps.getConfig();
    res.json({
      ...config,
      clientSecret: undefined,
      hasClientSecret: Boolean(config.clientSecret),
    });
  });

  router.put('/auth/sso/config', (req: Request, res: Response) => {
    const current = deps.getConfig();
    const next = deps.normalizeConfig({
      ...current,
      ...req.body,
      clientSecret: typeof req.body?.clientSecret === 'string' && req.body.clientSecret.trim()
        ? req.body.clientSecret
        : current.clientSecret,
    });
    if (next.enabled && (!next.authorizationUrl || !next.tokenUrl || !next.clientId || !next.clientSecret)) {
      res.status(400).json({ error: '启用 SSO 前必须填写授权地址、换票地址、客户端标识和客户端密钥' });
      return;
    }
    deps.saveConfig(next);
    res.json({
      ...next,
      clientSecret: undefined,
      hasClientSecret: Boolean(next.clientSecret),
    });
  });

  return router;
}
