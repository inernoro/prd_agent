import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { canDetachAccountIdentity, toPublicUser, type AccountIdentityProvider, type CdsUser } from '../domain/auth.js';
import type { AccountOAuthDriver } from '../services/account-oauth.js';
import { LocalAuthError, type AuthService } from '../services/auth-service.js';
import { readBrowserCookie, sessionCookieName } from '../services/browser-session-cookies.js';
import { buildLegacyLogoutCookie, buildAccountSessionCookies, buildSsoLogoutCookie, GH_SESSION_COOKIE } from './auth.js';

export type { AccountOAuthDriver } from '../services/account-oauth.js';

interface Options {
  authService: AuthService;
  providers: Partial<Record<AccountIdentityProvider, AccountOAuthDriver>>;
  publicBaseUrl: string;
  cookieSecure: boolean;
  hostSessionCookies?: boolean;
  legacyGithubEnabled?: boolean;
}

interface Flow {
  provider: AccountIdentityProvider;
  purpose: 'bind' | 'login' | 'activate';
  browserProof: string;
  verifier: string;
  expiresAt: number;
  redirect: string;
  binding?: { accountId: string; sessionFingerprint: string };
  activation?: { accountId: string; invitationHash: string };
}

const FLOW_TTL_MS = 5 * 60_000;
const ACCOUNT_PATH = '/cds-settings';
const safeRedirect = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\/(?![/%\\])/.test(value) || /[\\\r\n\u0000]/.test(value)) return '/project-list';
  const parsed = new URL(value, 'https://cds.invalid');
  return parsed.origin === 'https://cds.invalid' && /^\/(?![/%\\])/.test(parsed.pathname)
    ? parsed.pathname + parsed.search + parsed.hash : '/project-list';
};
const sha = (value: string): string => createHash('sha256').update(value).digest('base64url');

function verifiedProvider(value: string): AccountIdentityProvider | undefined {
  return value === 'github' || value === 'google' ? value : undefined;
}

function equal(left: string | undefined, right: string): boolean {
  return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function publicError(purpose: Flow['purpose'], provider: AccountIdentityProvider, code: string): string {
  const query = new URLSearchParams({ external: 'error', provider, code });
  return purpose === 'bind' ? `${ACCOUNT_PATH}?${query}#my-account` : `/login?${query}`;
}

export function createAccountIdentitiesRouter(options: Options): Router {
  const router = Router();
  const { authService, providers, publicBaseUrl, cookieSecure, hostSessionCookies = false } = options;
  const flows = new Map<string, Flow>();
  const flowCookie = sessionCookieName('cds_account_oauth', hostSessionCookies);
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: cookieSecure || hostSessionCookies, path: '/' };
  const callbackUri = (provider: AccountIdentityProvider) => new URL(`/api/auth/external/${provider}/callback`, publicBaseUrl).toString();
  const sessionToken = (req: Request) => readBrowserCookie(req.headers.cookie, sessionCookieName(GH_SESSION_COOKIE, hostSessionCookies)) ?? null;

  router.delete('/auth/external/:provider/link', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const provider = verifiedProvider(req.params.provider);
    if (!provider) { res.status(404).json({ error: '未找到指定身份提供方' }); return; }
    try {
      const active = await authService.validateSession(sessionToken(req), { renew: false });
      if (!active) { res.status(401).json({ error: '请用个人账号登录后操作' }); return; }
      const { user } = active;
      if (!canDetachAccountIdentity(user, provider, {
        github: Boolean(providers.github || options.legacyGithubEnabled), google: Boolean(providers.google),
      })) {
        res.status(409).json({ code: 'last_login_method', error: '须保留另一种可用登录方式' }); return;
      }
      const current = await authService.detachIdentity(user, provider);
      if (!current) { res.status(409).json({ code: 'account_changed', error: '账号状态已变化，请重新读取' }); return; }
      await authService.recordActivity({
        userId: user.id, userLogin: user.username || user.githubLogin, action: 'unlink-identity',
        targetType: 'user', targetId: user.id, summary: `本人解除 ${provider === 'github' ? 'GitHub' : 'Google'} 绑定`,
      });
      res.json({ user: toPublicUser(current) });
    } catch {
      res.status(503).json({ error: '无法确认解绑结果，请重新登录后读取当前身份' });
    }
  });

  async function signIn(req: Request, res: Response, user: CdsUser, activity: string): Promise<void> {
    const session = await authService.createSessionForUser(user, {
      userAgent: req.get('user-agent') || null, ipAddress: req.ip || null,
    });
    await authService.recordActivity({
      userId: user.id, userLogin: user.username || user.githubLogin, action: 'login', summary: activity,
    });
    res.append('Set-Cookie', [
      ...buildAccountSessionCookies(session, cookieSecure || hostSessionCookies, hostSessionCookies),
      buildLegacyLogoutCookie(cookieSecure || hostSessionCookies, hostSessionCookies),
      buildSsoLogoutCookie(cookieSecure || hostSessionCookies, hostSessionCookies),
    ]);
  }

  router.post('/auth/invitations/activate', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const invited = await authService.findAccountInvitation(req.body?.invitation);
      const user = invited && typeof req.body?.password === 'string'
        ? await authService.acceptAccountInvitation(invited, req.body.password) : null;
      if (!user) {
        res.status(400).json({ code: 'invalid_invitation', error: '邀请链接已使用或已过期，请联系签发人' });
        return;
      }
      await signIn(req, res, user, '设置个人口令并激活 CDS 账号');
      res.json({ user: toPublicUser(user) });
    } catch (error) {
      if (error instanceof LocalAuthError) res.status(400).json({ code: error.code, error: error.message });
      else res.status(503).json({ code: 'invitation_unavailable', error: '暂时无法激活，请重新读取登录页' });
    }
  });

  async function start(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const provider = verifiedProvider(req.params.provider);
    const driver = provider && providers[provider];
    if (!provider || !driver) {
      res.status(404).json({ error: 'provider_not_configured' });
      return;
    }
    const purpose = req.method === 'POST' ? req.body?.purpose : req.query.purpose;
    if (req.method === 'POST' ? purpose !== 'activate' : purpose !== 'bind' && purpose !== 'login') {
      res.status(400).json({ error: 'invalid_oauth_purpose' });
      return;
    }
    try {
      const now = Date.now();
      for (const [key, flow] of flows) if (flow.expiresAt <= now) flows.delete(key);
      if (flows.size >= 500) {
        res.status(429).json({ error: 'oauth_busy' });
        return;
      }
      const token = sessionToken(req);
      const bound = purpose === 'bind' ? await authService.validateSession(token, { renew: false }) : null;
      if (purpose === 'bind' && !bound) {
        res.status(401).json({ error: 'personal_session_required' });
        return;
      }
      if (bound && !bound.user.externalLoginAllowed) {
        res.status(403).json({ error: 'binding_not_enabled' });
        return;
      }
      const invited = purpose === 'activate' ? await authService.findAccountInvitation(req.body?.invitation) : null;
      if (purpose === 'activate' && (!invited?.invitationHash || !invited.externalLoginAllowed)) {
        res.status(400).json({ code: 'invalid_invitation', error: '邀请链接已使用或已过期，请联系签发人' });
        return;
      }
      const state = randomBytes(32).toString('base64url');
      const browserProof = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      // A second start on the same browser invalidates its prior handshake.
      const previous = readBrowserCookie(req.headers.cookie, flowCookie);
      if (previous) {
        for (const [key, flow] of flows) if (equal(previous, flow.browserProof)) flows.delete(key);
      }
      const uri = driver.authorizationUrl({ redirectUri: callbackUri(provider), state, codeChallenge: sha(verifier) });
      flows.set(state, {
        provider, purpose, verifier, browserProof, expiresAt: now + FLOW_TTL_MS,
        redirect: safeRedirect(req.query.redirect),
        ...(bound && token ? { binding: { accountId: bound.user.id, sessionFingerprint: sha(token) } } : {}),
        ...(invited?.invitationHash ? { activation: { accountId: invited.id, invitationHash: invited.invitationHash } } : {}),
      });
      res.cookie(flowCookie, browserProof, { ...cookieOptions, maxAge: FLOW_TTL_MS });
      if (purpose === 'activate') res.json({ authorizationUrl: uri });
      else res.redirect(302, uri);
    } catch {
      if (purpose === 'activate') res.status(503).json({ code: 'invitation_unavailable', error: '暂时无法打开第三方登录，请稍后重试' });
      else res.redirect(302, publicError(purpose, provider, 'oauth_unavailable'));
    }
  }
  router.get('/auth/external/:provider/start', start);
  router.post('/auth/external/:provider/start', start);

  router.get('/auth/external/:provider/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const provider = verifiedProvider(req.params.provider);
    const driver = provider && providers[provider];
    if (!provider || !driver) {
      res.status(404).json({ error: 'provider_not_configured' });
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = flows.get(state);
    const fail = (code: string) => res.redirect(302, publicError(flow?.purpose ?? 'login', provider, code));
    if (!flow || flow.provider !== provider || flow.expiresAt <= Date.now() ||
        !equal(readBrowserCookie(req.headers.cookie, flowCookie), flow.browserProof)) {
      fail('oauth_state_invalid');
      return;
    }

    flows.delete(state);
    res.clearCookie(flowCookie, cookieOptions);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || code.length > 2048) {
      fail('oauth_not_completed');
      return;
    }
    const validBindingAccount = async () => {
      if (!flow.binding) return null;
      const token = sessionToken(req);
      if (!token || !equal(sha(token), flow.binding.sessionFingerprint)) return null;
      const session = await authService.validateSession(token, { renew: false });
      return session?.user.id === flow.binding.accountId && session.user.externalLoginAllowed ? session.user : null;
    };

    try {
      if (flow.binding && !await validBindingAccount()) {
        fail('binding_session_changed');
        return;
      }
      const { subject, label } = await driver.complete({ code, redirectUri: callbackUri(provider), codeVerifier: flow.verifier });
      const validSubject = typeof subject === 'string' && subject.length > 0 && subject.length <= 255 &&
        !/[\s\u0000]/.test(subject) && (provider !== 'github' || (/^[1-9]\d*$/.test(subject) && Number.isSafeInteger(Number(subject))));
      if (!validSubject) {
        fail('provider_subject_invalid');
        return;
      }
      if (flow.purpose === 'bind') {
        const user = await validBindingAccount();
        if (!user) {
          fail('binding_session_changed');
          return;
        }
        const providerName = provider === 'github' ? 'GitHub' : 'Google';
        const result = await authService.linkIdentity(user, provider, subject, String(label).trim().slice(0, 160) || provider);
        if (result !== 'linked') {
          if (result === 'identity_taken') await authService.recordActivity({
            userId: user.id, userLogin: user.username || user.githubLogin, action: 'link-identity-denied',
            targetType: 'user', targetId: user.id, summary: `本人绑定 ${providerName} 失败，身份已被绑定`,
          });
          fail(result);
          return;
        }
        await authService.recordActivity({
          userId: user.id, userLogin: user.username || user.githubLogin, action: 'link-identity', targetType: 'user',
          targetId: user.id, summary: `本人绑定 ${providerName} 登录身份`,
        });
        res.redirect(302, `${ACCOUNT_PATH}?external=bound&provider=${provider}#my-account`);
        return;
      }
      const safeLabel = String(label).trim().slice(0, 160) || provider;
      if (flow.purpose === 'activate') {
        const invited = flow.activation ? await authService.findUserById(flow.activation.accountId) : null;
        const user = invited && invited.invitationHash === flow.activation?.invitationHash
          ? await authService.acceptAccountInvitation(invited, { provider, subject, label: safeLabel }) : null;
        if (!user) {
          fail('invalid_invitation');
          return;
        }
        await signIn(req, res, user, '使用已验证的第三方身份激活 CDS 账号');
        res.redirect(302, `${ACCOUNT_PATH}#my-account`);
        return;
      }
      const user = await authService.findUserByExternalIdentity(provider, subject);
      if (!user || user.status !== 'active') {
        fail('account_unavailable');
        return;
      }
      await signIn(req, res, user, `使用已绑定的 ${provider === 'github' ? 'GitHub' : 'Google'} 登录`);
      res.redirect(302, flow.redirect);
    } catch {
      fail('oauth_unavailable');
    }
  });

  return router;
}
