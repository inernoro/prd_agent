import { Router, type Request, type Response, type RequestHandler } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { CdsSession, CdsUser } from '../domain/auth.js';
import type { CdsPasskeyStore } from '../domain/passkey.js';
import type { AuthService } from '../services/auth-service.js';
import { readBrowserCookie } from '../services/browser-session-cookies.js';
import { ExpiringTokens } from '../services/expiring-tokens.js';
import { buildLegacyLogoutCookie, buildLogoutCookie, buildSessionCookie, buildSsoLogoutCookie, GH_SESSION_COOKIE, sessionCookieName } from './auth.js';

const CHALLENGE_COOKIE = '__Host-cds-passkey';
const CHALLENGE_TTL_MS = 2 * 60_000;
export const PASSKEY_FRESH_MS = 5 * 60_000;

export function readAuthCookie(header: string | undefined, name: string): string | null {
  const value = readBrowserCookie(header, name);
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export function authCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function trustedAuthOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function isRecentAuthentication(session: CdsSession, passkeyRequired: boolean): boolean {
  const age = Date.now() - Date.parse(session.createdAt);
  return age >= 0 && age <= PASSKEY_FRESH_MS && (!passkeyRequired || session.passkeyAuthenticated === true);
}

type VerifiedSession = { user: CdsUser; session: CdsSession };
type Challenge = { value: string; purpose: 'registration' | 'authentication'; userId?: string; sessionToken?: string };

type PasskeyRouterOptions = {
  origin: URL;
  auth: AuthService;
  store: CdsPasskeyStore;
  enabled: () => boolean;
};

export function createPasskeyRouter({ origin, auth, store, enabled }: PasskeyRouterOptions): Router {
  const router = Router();
  const challenges = new ExpiringTokens<Challenge>(4096);
  const scope = (req: Request): boolean => enabled() && req.get('host')?.toLowerCase() === origin.host;
  const currentSession = (req: Request) => auth.validateSession(readAuthCookie(req.get('cookie'), sessionCookieName(GH_SESSION_COOKIE, true)), { renew: false });
  const action = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.locals.cdsSuppressRequestBodyLog = true;
    if (!scope(req)) { res.sendStatus(404); return; }
    if (req.get('origin') !== origin.origin) { res.sendStatus(403); return; }
    void handler(req, res).catch(next);
  };

  function issue(res: Response, challenge: Challenge, options: unknown): void {
    const ticket = challenges.issue(challenge, CHALLENGE_TTL_MS);
    if (!ticket) {
      res.status(429).json({ error: '登录请求过多，请稍后重试。' });
      return;
    }
    res.append('Set-Cookie', authCookie(CHALLENGE_COOKIE, ticket, CHALLENGE_TTL_MS / 1000));
    res.json(options);
  }

  function consume(req: Request, res: Response, purpose: Challenge['purpose']): Challenge | undefined {
    const challenge = challenges.read(readAuthCookie(req.get('cookie'), CHALLENGE_COOKIE), true);
    res.append('Set-Cookie', authCookie(CHALLENGE_COOKIE, '', 0));
    if (challenge?.purpose === purpose) return challenge;
    res.status(400).json({ error: '验证请求已失效，请重新开始。' });
  }

  async function registrationSession(req: Request, res: Response): Promise<VerifiedSession | undefined> {
    const verified = await currentSession(req);
    if (!verified) {
      res.status(401).json({ error: '请先登录 CDS，再绑定通行密钥。' });
      return;
    }
    const keys = await store.list(verified.user.id);
    if (!isRecentAuthentication(verified.session, keys.length > 0)) {
      res.status(403).json({ error: keys.length ? '请先使用已有通行密钥重新验证。' : '请重新登录 CDS 后绑定通行密钥。' });
      return;
    }
    if (keys.length >= 10) {
      res.status(409).json({ error: '此账号已达到通行密钥数量上限。' });
      return;
    }
    return verified;
  }

  router.get('/auth/passkeys/status', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!scope(req)) { res.json({ enabled: false, canEnroll: false }); return; }
    void currentSession(req).then(async verified => {
      const count = verified ? (await store.list(verified.user.id)).length : 0;
      res.json({ enabled: true, canEnroll: Boolean(verified), count });
    }).catch(next);
  });

  router.post('/auth/passkeys/register/options', action(async (req, res) => {
    const verified = await registrationSession(req, res);
    if (!verified) return;
    const { user, session } = verified;
    const keys = await store.list(user.id);
    const options = await generateRegistrationOptions({
      rpName: 'CDS', rpID: origin.hostname,
      userID: new TextEncoder().encode(user.id), userName: user.username || user.githubLogin,
      userDisplayName: user.name, attestationType: 'none', timeout: CHALLENGE_TTL_MS,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: keys.map(key => ({ id: key.id, transports: key.transports })),
    });
    issue(res, { value: options.challenge, purpose: 'registration', userId: user.id, sessionToken: session.token }, options);
  }));

  router.post('/auth/passkeys/register/verify', action(async (req, res) => {
    const challenge = consume(req, res, 'registration');
    if (!challenge) return;
    const verified = await registrationSession(req, res);
    if (!verified) return;
    if (verified.user.id !== challenge.userId || verified.session.token !== challenge.sessionToken) {
      res.status(403).json({ error: '登录账号已切换，请重新发起绑定。' });
      return;
    }
    const result = await verifyRegistrationResponse({
      response: req.body, expectedChallenge: challenge.value,
      expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified || !result.registrationInfo) {
      res.status(400).json({ error: '无法验证通行密钥，请重新绑定。' });
      return;
    }
    const credential = result.registrationInfo.credential;
    await store.insert({
      id: credential.id, userId: verified.user.id, counter: credential.counter,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      transports: credential.transports, createdAt: new Date().toISOString(),
    });
    await auth.recordActivity({ userId: verified.user.id, userLogin: verified.user.username || verified.user.githubLogin,
      action: 'passkey.register', summary: '绑定通行密钥' });
    res.json({ success: true });
  }));

  router.post('/auth/passkeys/login/options', action(async (req, res) => {
    const verified = req.body?.verifyCurrent === true ? await currentSession(req) : null;
    if (req.body?.verifyCurrent === true && !verified) {
      res.status(401).json({ error: '登录状态已失效，请重新登录。' });
      return;
    }
    const options = await generateAuthenticationOptions({
      rpID: origin.hostname, userVerification: 'required', timeout: CHALLENGE_TTL_MS,
      ...(verified ? { allowCredentials: (await store.list(verified.user.id)).map(key => ({ id: key.id, transports: key.transports })) } : {}),
    });
    issue(res, { value: options.challenge, purpose: 'authentication', userId: verified?.user.id, sessionToken: verified?.session.token }, options);
  }));

  router.post('/auth/passkeys/logout-everywhere', action(async (req, res) => {
    const verified = await currentSession(req);
    if (!verified) { res.status(401).json({ error: '登录已失效，请重新登录。' }); return; }
    await auth.logoutAllForUser(verified.user.id);
    await auth.recordActivity({ userId: verified.user.id, userLogin: verified.user.username || verified.user.githubLogin,
      action: 'hosted-sso.logout', summary: '退出当前 CDS 账号的所有站点' });
    res.append('Set-Cookie', [buildLogoutCookie(true, true), buildLegacyLogoutCookie(true, true), buildSsoLogoutCookie(true, true)]);
    res.json({ success: true });
  }));

  router.post('/auth/passkeys/login/verify', action(async (req, res) => {
    const challenge = consume(req, res, 'authentication');
    if (!challenge) return;
    const invalid = () => res.status(401).json({ error: '无法使用此通行密钥登录，请检查账号后重试。' });
    const id = req.body?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(id)) return invalid();
    const key = await store.find(id);
    if (!key || (challenge.userId && key.userId !== challenge.userId)) return invalid();
    if (challenge.sessionToken) {
      const verified = await currentSession(req);
      if (verified?.session.token !== challenge.sessionToken) return invalid();
    }
    const userHandle = req.body?.response?.userHandle;
    if (userHandle != null && userHandle !== Buffer.from(key.userId).toString('base64url')) return invalid();
    const result = await verifyAuthenticationResponse({
      response: req.body, expectedChallenge: challenge.value,
      expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true,
      credential: { id: key.id, publicKey: Uint8Array.from(Buffer.from(key.publicKey, 'base64url')), counter: key.counter },
    }).catch(() => null);
    if (!result?.verified || !await store.advanceCounter(key.id, key.counter, result.authenticationInfo.newCounter)) return invalid();
    const user = await auth.findUserById(key.userId);
    if (!user || user.status !== 'active') return invalid();
    const session = await auth.createSessionForUser(user.id, {
      userAgent: req.get('user-agent') || null, ipAddress: req.ip || null, passkeyAuthenticated: true,
    });
    await auth.recordActivity({ userId: user.id, userLogin: user.username || user.githubLogin, action: 'passkey.login', summary: '使用通行密钥登录' });
    res.append('Set-Cookie', [buildSessionCookie(session.token, session.expiresAt, true, true), buildLegacyLogoutCookie(true, true), buildSsoLogoutCookie(true, true)]);
    res.json({ success: true });
  }));

  return router;
}
