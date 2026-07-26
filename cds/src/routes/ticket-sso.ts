import { Router, type Request, type Response } from 'express';
import type { CdsSsoConfig } from '../types.js';
import { GH_SESSION_COOKIE } from './auth.js';
import {
  TicketSsoExchangeError,
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
  tokenExchangeTimeoutMs?: number;
  logoutGithubSession?: (token: string) => Promise<void>;
}

function externalCallbackUrl(req: Request, configuredBaseUrl?: string): string {
  const candidate = configuredBaseUrl
    ? new URL(configuredBaseUrl)
    : new URL(`${req.protocol || 'http'}://${String(req.headers.host || '').trim()}`);
  const isLoopback = candidate.hostname === 'localhost'
    || candidate.hostname === '127.0.0.1'
    || candidate.hostname === '[::1]'
    || candidate.hostname === '::1';
  const isLocalHttp = candidate.protocol === 'http:' && isLoopback;
  if (candidate.username || candidate.password || (candidate.protocol !== 'https:' && !isLocalHttp)) {
    throw new Error('SSO_CALLBACK_PROTOCOL_INVALID');
  }
  if (!configuredBaseUrl && !isLoopback) {
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

function logoutCookie(name: string, secure: boolean): string {
  const parts = [
    `${name}=`,
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
        deps.tokenExchangeTimeoutMs,
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
    } catch (error) {
      if (error instanceof TicketSsoExchangeError && error.reason === 'timeout') {
        res.status(504).json({
          error: '身份提供方响应超时，请重新发起 SSO 登录',
          code: 'sso_provider_timeout',
        });
        return;
      }
      if (error instanceof TicketSsoExchangeError && error.reason === 'unavailable') {
        res.status(502).json({
          error: '身份提供方暂时不可用，请稍后重试',
          code: 'sso_provider_unavailable',
        });
        return;
      }
      res.status(401).json({
        error: 'SSO 一次性授权无效、已使用或已过期',
        code: 'sso_exchange_failed',
      });
    }
  });

  router.post('/auth/sso/logout', async (req, res) => {
    const ssoToken = parseCookie(req.headers.cookie, TICKET_SSO_COOKIE);
    const githubToken = parseCookie(req.headers.cookie, GH_SESSION_COOKIE);
    deps.sessionStore.delete(ssoToken);
    const clearCookies = [
      logoutCookie(TICKET_SSO_COOKIE, deps.cookieSecure),
      logoutCookie(GH_SESSION_COOKIE, deps.cookieSecure),
      logoutCookie('cds_token', deps.cookieSecure),
    ];
    try {
      if (githubToken && deps.logoutGithubSession) {
        await deps.logoutGithubSession(githubToken);
      }
    } catch {
      res.setHeader('Set-Cookie', clearCookies);
      res.status(503).json({
        success: false,
        error: 'alternate_session_logout_failed',
        message: '服务端会话注销失败，本地登录状态已清除。',
      });
      return;
    }
    res.setHeader('Set-Cookie', clearCookies);
    res.json({ success: true });
  });

  return router;
}

export function createTicketSsoConfigRouter(deps: {
  getConfig: () => CdsSsoConfig;
  saveConfig: (config: CdsSsoConfig) => void;
  normalizeConfig: (input: Partial<CdsSsoConfig>) => CdsSsoConfig;
  canWriteConfig: (req: Request) => boolean;
  isEnvironmentManaged?: () => boolean;
}): Router {
  const router = Router();

  router.get('/auth/sso/config', (req: Request, res: Response) => {
    if (!deps.canWriteConfig(req)) {
      res.status(403).json({
        error: 'human_owner_required',
        message: 'SSO 属于系统级登录配置，只允许已验证的系统所有者读取。',
      });
      return;
    }
    const config = deps.getConfig();
    res.json({
      ...config,
      clientSecret: undefined,
      hasClientSecret: Boolean(config.clientSecret),
      managedByEnvironment: deps.isEnvironmentManaged?.() === true,
    });
  });

  router.put('/auth/sso/config', (req: Request, res: Response) => {
    if (!deps.canWriteConfig(req)) {
      res.status(403).json({
        error: 'human_owner_required',
        message: 'SSO 属于系统级登录配置，只允许已验证的系统所有者修改。',
      });
      return;
    }
    if (deps.isEnvironmentManaged?.() === true) {
      res.status(409).json({
        error: 'sso_config_managed_by_environment',
        message: '当前 SSO 配置由 CDS_SSO_* 环境变量托管，请在部署环境中修改后重启 CDS。',
      });
      return;
    }
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
      managedByEnvironment: false,
    });
  });

  return router;
}
