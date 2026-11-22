import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { toPublicUser, type CdsUser } from '../../src/domain/auth.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';
import { createAccountIdentitiesRouter } from '../../src/routes/account-identities.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { createAuthLocalRouter } from '../../src/routes/auth-local.js';
import { GH_SESSION_COOKIE, sessionCookieName } from '../../src/services/browser-session-cookies.js';
import { AuthService } from '../../src/services/auth-service.js';
import { GitHubOAuthClient } from '../../src/services/github-oauth-client.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

type Provider = 'github' | 'google';
type Purpose = 'bind' | 'login';
type Identity = { subject: string; label: string };

const publicBaseUrl = 'https://cds-account.fixture.invalid';
const externalReturnPath = '/project-list?panel=fixture#activity';
const legacyGithubOrigin = 'https://legacy-github.oauth.fixture.invalid';
const fixturePassword = 'isolated-fixture-password';
const providersInOrder = ['github', 'google'] as const;
const callbackPath = (provider: Provider) => `/api/auth/external/${provider}/callback`;

function fakeProvider(provider: Provider) {
  const origin = `https://${provider}.oauth.fixture.invalid`;
  const codes = new Map<string, Identity & { codeChallenge: string }>();
  const authorizationUrl = vi.fn((input: { redirectUri: string; state: string; codeChallenge: string }) => {
    const target = new URL('/authorize', origin);
    target.searchParams.set('redirect_uri', input.redirectUri);
    target.searchParams.set('state', input.state);
    target.searchParams.set('code_challenge', input.codeChallenge);
    return target.href;
  });
  const complete = vi.fn(async (input: { code: string; redirectUri: string; codeVerifier: string }) => {
    const profile = codes.get(input.code);
    if (!profile) throw new Error('Unknown fixture authorization code');
    expect(input.redirectUri).toBe(publicBaseUrl + callbackPath(provider));
    expect(createHash('sha256').update(input.codeVerifier).digest('base64url')).toBe(profile.codeChallenge);
    codes.delete(input.code);
    return { subject: profile.subject, label: profile.label };
  });
  return { origin, authorizationUrl, complete, issueCode: (code: string, codeChallenge: string, profile: Identity) => {
    codes.set(code, { ...profile, codeChallenge });
  } };
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookiePair(header: string): string {
  return header.split(';', 1)[0];
}

function activeCookie(response: Response, name: string): string | undefined {
  return cookies(response).map(cookiePair).find(pair => pair.startsWith(`${name}=`) && pair.length > name.length + 1);
}

function responseLocation(response: Response): URL {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  return new URL(location!, publicBaseUrl);
}

async function setup(hostSessionCookies = false, options: {
  store?: MemoryAuthStore;
  enabled?: readonly Provider[];
  legacyGithubProfiles?: Readonly<Record<string, Identity>>;
} = {}) {
  const store = options.store ?? new MemoryAuthStore();
  const legacyGithub = options.legacyGithubProfiles ? new GitHubOAuthClient({
    clientId: 'fixture-legacy-github-client', clientSecret: 'fixture-legacy-github-secret', oauthBaseUrl: legacyGithubOrigin,
    fetchImpl: async () => { throw new Error('No network in the legacy GitHub fixture'); },
  }) : undefined;
  if (legacyGithub) {
    vi.spyOn(legacyGithub, 'exchangeCodeForToken').mockImplementation(async code => code);
    vi.spyOn(legacyGithub, 'fetchProfile').mockImplementation(async token => {
      const profile = options.legacyGithubProfiles![token];
      if (!profile) throw new Error('Unknown legacy fixture profile');
      return { id: Number(profile.subject), login: profile.label, name: profile.label, avatarUrl: null, email: null };
    });
    vi.spyOn(legacyGithub, 'fetchOrgs').mockResolvedValue([]);
  }
  const authService = new AuthService({ store, github: legacyGithub, config: { allowedOrgs: [] } });
  const providers = { github: fakeProvider('github'), google: fakeProvider('google') };
  const enabled = options.enabled ?? providersInOrder;
  const enabledDrivers = Object.fromEntries(enabled.map(provider => [provider, providers[provider]]));
  const cookieSecure = hostSessionCookies;
  const sessionName = sessionCookieName(GH_SESSION_COOKIE, hostSessionCookies);
  const app = express();
  app.use(express.json());
  app.use('/api', createAccountIdentitiesRouter({ authService, providers: enabledDrivers, publicBaseUrl, cookieSecure, hostSessionCookies }));
  if (legacyGithub) app.use('/api', createAuthRouter({ authService, publicBaseUrl, cookieSecure, hostSessionCookies }));
  app.use('/api', createAuthLocalRouter({ authService, cookieSecure, hostSessionCookies, bootstrapAllowed: false }));
  app.use(createGithubAuthMiddleware({ authService, cookieSecure, hostSessionCookies }));
  app.get('/api/fixture-viewer', (req: Request & { cdsUser?: CdsUser }, res) => {
    const user = req.cdsUser!;
    res.json({ id: user.id, username: user.username, authProvider: user.authProvider, status: user.status });
  });
  const server = listenLoopbackFixture(app);
  if (!server.address()) await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(path: string, options: { cookie?: string; json?: unknown; method?: 'DELETE' } = {}): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.cookie) headers.set('Cookie', options.cookie);
    if (options.json) headers.set('Content-Type', 'application/json');
    return fetch(origin + path, {
      headers, method: options.method ?? (options.json ? 'POST' : 'GET'), redirect: 'manual',
      ...(options.json ? { body: JSON.stringify(options.json) } : {}),
      signal: AbortSignal.timeout(5000),
    });
  }

  async function person(username: string, externalLoginAllowed = true, email = `${username}@fixture.invalid`) {
    return authService.createLocalUser({ username, password: fixturePassword, email, externalLoginAllowed });
  }

  async function localLogin(username: string, password = fixturePassword): Promise<string> {
    const response = await call('/api/auth/login', { json: { username, password } });
    expect(response.status).toBe(200);
    const session = activeCookie(response, sessionName);
    expect(Boolean(session)).toBe(true);
    return session!;
  }

  async function viewer(session: string, user: CdsUser) {
    const response = await call('/api/fixture-viewer', { cookie: session });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: user.id, username: user.username, authProvider: 'local', status: 'active',
    });
  }

  function start(provider: Provider, purpose: Purpose, session?: string, redirect = externalReturnPath) {
    const query = new URLSearchParams({ purpose, redirect });
    return call(`/api/auth/external/${provider}/start?${query}`, { cookie: session });
  }

  function readFlow(provider: Provider, response: Response, authorize: URL) {
    expect(authorize.origin).toBe(providers[provider].origin);
    expect(authorize.searchParams.get('redirect_uri')).toBe(publicBaseUrl + callbackPath(provider));
    const state = authorize.searchParams.get('state');
    const challenge = authorize.searchParams.get('code_challenge');
    expect(Boolean(state)).toBe(true);
    expect(Boolean(challenge)).toBe(true);

    const flow = cookies(response).find(header => {
      const pair = cookiePair(header);
      return !pair.startsWith(`${sessionName}=`) && !pair.endsWith('=') && /; HttpOnly(?:;|$)/i.test(header);
    });
    expect(Boolean(flow)).toBe(true);
    expect(/; SameSite=Lax(?:;|$)/i.test(flow!)).toBe(true);
    if (hostSessionCookies) {
      expect(flow!.startsWith('__Host-')).toBe(true);
      expect(/; Path=\/(?:;|$)/i.test(flow!)).toBe(true);
      expect(/; Secure(?:;|$)/i.test(flow!)).toBe(true);
    }
    return { state: state!, challenge: challenge!, cookie: cookiePair(flow!) };
  }

  async function begin(provider: Provider, purpose: Purpose, session?: string, redirect = externalReturnPath) {
    const response = await start(provider, purpose, session, redirect);
    expect(response.status).toBe(302);
    return readFlow(provider, response, responseLocation(response));
  }

  function activateStart(provider: Provider, invitation: string) {
    return call(`/api/auth/external/${provider}/start`, { json: { purpose: 'activate', invitation } });
  }

  function unlink(provider: Provider, session?: string) {
    return call(`/api/auth/external/${provider}/link`, { method: 'DELETE', cookie: session });
  }

  async function legacyGithubLogin(code: string) {
    const start = await call(`/api/auth/github/login?${new URLSearchParams({ redirect: externalReturnPath })}`);
    expect(start.status).toBe(302);
    const outbound = responseLocation(start);
    expect(outbound.origin).toBe(legacyGithubOrigin);
    const state = outbound.searchParams.get('state');
    expect(Boolean(state)).toBe(true);
    const cookie = activeCookie(start, '__Host-cds-github-flow');
    return call(`/api/auth/github/callback?${new URLSearchParams({ state: state!, code })}`, { cookie });
  }

  async function beginActivation(provider: Provider, invitation: string) {
    const response = await activateStart(provider, invitation);
    expect(response.status).toBe(200);
    const { authorizationUrl } = await response.json();
    expect(typeof authorizationUrl).toBe('string');
    const target = new URL(authorizationUrl);
    expect(target.href.includes(invitation)).toBe(false);
    return readFlow(provider, response, target);
  }

  function callback(provider: Provider, state: string, code: string, flowCookie?: string, session?: string) {
    const query = new URLSearchParams({ state, code });
    const cookie = [flowCookie, session].filter(Boolean).join('; ');
    return call(`${callbackPath(provider)}?${query}`, { cookie });
  }

  let codeSequence = 0;
  async function finish(provider: Provider, flow: ReturnType<typeof readFlow>, identity: Identity, session?: string) {
    const code = `fixture-code-${++codeSequence}`;
    providers[provider].issueCode(code, flow.challenge, identity);
    const response = await callback(provider, flow.state, code, flow.cookie, session);
    return { response, state: flow.state, code, cookie: flow.cookie };
  }

  async function complete(provider: Provider, purpose: Purpose, identity: Identity, session?: string, redirect?: string) {
    const flow = await begin(provider, purpose, session, redirect);
    return finish(provider, flow, identity, session);
  }

  function assertBound(response: Response, provider: Provider) {
    expect(response.status).toBe(302);
    const destination = responseLocation(response);
    expect(destination.origin).toBe(publicBaseUrl);
    expect(destination.pathname).toBe('/cds-settings');
    expect(destination.searchParams.get('external'), destination.searchParams.get('code') ?? undefined).toBe('bound');
    expect(destination.searchParams.get('provider')).toBe(provider);
    expect(destination.hash).toBe('#my-account');
    expect(Boolean(activeCookie(response, sessionName))).toBe(false);
  }

  function blockedCallback(response: Response, provider: Provider, code: string, page?: '/login' | '/cds-settings') {
    expect(response.status).toBe(302);
    const destination = responseLocation(response);
    expect(destination.origin).toBe(publicBaseUrl);
    if (page) expect(destination.pathname).toBe(page);
    else expect(['/login', '/cds-settings']).toContain(destination.pathname);
    expect(destination.searchParams.get('external')).toBe('error');
    expect(destination.searchParams.get('provider')).toBe(provider);
    expect(destination.searchParams.get('code')).toBe(code);
    if (destination.pathname === '/cds-settings') expect(destination.hash).toBe('#my-account');
    expect(Boolean(activeCookie(response, sessionName))).toBe(false);
    return destination;
  }

  async function readIssuedSession(response: Response, user: CdsUser) {
    const session = activeCookie(response, sessionName);
    expect(Boolean(session)).toBe(true);
    const raw = cookies(response).find(header => cookiePair(header) === session)!;
    expect(/; HttpOnly(?:;|$)/i.test(raw)).toBe(true);
    expect(/; SameSite=Lax(?:;|$)/i.test(raw)).toBe(true);
    if (hostSessionCookies) {
      expect(/; Path=\/(?:;|$)/i.test(raw)).toBe(true);
      expect(/; Secure(?:;|$)/i.test(raw)).toBe(true);
    }
    await viewer(session!, user);
  }

  async function loggedIn(response: Response, user: CdsUser, redirect = externalReturnPath) {
    expect(response.status).toBe(302);
    expect(responseLocation(response).href).toBe(publicBaseUrl + redirect);
    await readIssuedSession(response, user);
  }

  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  return { authService, store, providers, sessionName, person, call, localLogin, begin, start, callback, complete, viewer,
    beginActivation, activateStart, unlink, legacyGithubLogin, finish, readIssuedSession, assertBound, blockedCallback, loggedIn, close };
}

describe('GitHub and Google account identities', () => {
  it('keeps both provider identities on the original account and preserves password login', async () => {
    const fixture = await setup();
    try {
      const user = await fixture.person('existing-member');
      await fixture.person('unrelated-member');
      const session = await fixture.localLogin(user.username!);
      const subject = '45420042';

      for (const provider of providersInOrder) {
        const bound = await fixture.complete(provider, 'bind', { subject, label: `original-${provider}` }, session);
        fixture.assertBound(bound.response, provider);
      }
      await fixture.viewer(session, user);

      for (const provider of providersInOrder) {
        const login = await fixture.complete(provider, 'login', { subject, label: `renamed-${provider}` });
        await fixture.loggedIn(login.response, user);
        expect(fixture.providers[provider].complete).toHaveBeenCalledTimes(2);
      }
      await fixture.viewer(await fixture.localLogin(user.username!), user);
      expect(await fixture.store.countUsers()).toBe(2);
    } finally { await fixture.close(); }
  });

  it('allows bind only from an opted-in stored personal session', async () => {
    const fixture = await setup();
    try {
      const restricted = await fixture.person('restricted-member', false);
      const restrictedSession = await fixture.localLogin(restricted.username!);
      const anonymous = await fixture.start('github', 'bind');
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: 'personal_session_required' });
      const forged = await fixture.start('github', 'bind', 'cds_gh_session=fixture-unissued; cds_token=fixture-legacy');
      expect(forged.status).toBe(401);
      expect(await forged.json()).toEqual({ error: 'personal_session_required' });
      const optedOut = await fixture.start('google', 'bind', restrictedSession);
      expect(optedOut.status).toBe(403);
      expect(await optedOut.json()).toEqual({ error: 'binding_not_enabled' });
      for (const provider of providersInOrder) {
        expect(fixture.providers[provider].authorizationUrl).not.toHaveBeenCalled();
        expect(fixture.providers[provider].complete).not.toHaveBeenCalled();
      }
      expect(await fixture.store.countUsers()).toBe(1);
    } finally { await fixture.close(); }
  });

  it('rejects missing or mismatched browser handshakes before reaching either provider', async () => {
    const fixture = await setup();
    try {
      const member = await fixture.person('handshake-member');
      const session = await fixture.localLogin(member.username!);

      const noCookie = await fixture.begin('github', 'bind', session);
      const invalidState = await fixture.begin('github', 'bind', session);
      const wrongBrowser = await fixture.begin('github', 'bind', session);
      const wrongProvider = await fixture.begin('github', 'bind', session);
      const differentBrowser = await fixture.begin('github', 'bind', session);
      for (const [provider, state, cookie] of [
        ['github', noCookie.state, undefined],
        ['github', 'fixture-unissued-state', invalidState.cookie],
        ['github', wrongBrowser.state, differentBrowser.cookie],
        ['google', wrongProvider.state, wrongProvider.cookie],
      ] as const) {
        const response = await fixture.callback(provider, state, 'fixture-unused-code', cookie, session);
        const destination = fixture.blockedCallback(response, provider, 'oauth_state_invalid');
        expect(destination.href.includes('fixture-unused-code')).toBe(false);
      }

      expect(fixture.providers.github.complete).not.toHaveBeenCalled();
      expect(fixture.providers.google.complete).not.toHaveBeenCalled();
      const originalBrowser = await fixture.complete('github', 'bind', { subject: '45420043', label: 'fixture label' }, session);
      fixture.assertBound(originalBrowser.response, 'github');
      expect(await fixture.store.countUsers()).toBe(1);
    } finally { await fixture.close(); }
  });

  it('requires the same still-active personal session at the bind callback', async () => {
    const fixture = await setup();
    try {
      const original = await fixture.person('original-member');
      const different = await fixture.person('different-member');
      const originalSession = await fixture.localLogin(original.username!);
      const otherSession = await fixture.localLogin(different.username!);
      const newOriginalSession = await fixture.localLogin(original.username!);
      const switchUser = await fixture.begin('google', 'bind', originalSession);
      const switchSession = await fixture.begin('google', 'bind', originalSession);
      const revoked = await fixture.begin('google', 'bind', originalSession);

      const differentUser = await fixture.callback('google', switchUser.state, 'fixture-unused-code', switchUser.cookie, otherSession);
      fixture.blockedCallback(differentUser, 'google', 'binding_session_changed', '/cds-settings');
      const differentSession = await fixture.callback('google', switchSession.state, 'fixture-unused-code', switchSession.cookie, newOriginalSession);
      fixture.blockedCallback(differentSession, 'google', 'binding_session_changed', '/cds-settings');

      await fixture.authService.logout(originalSession.slice(fixture.sessionName.length + 1));
      const loggedOut = await fixture.callback('google', revoked.state, 'fixture-unused-code', revoked.cookie, originalSession);
      fixture.blockedCallback(loggedOut, 'google', 'binding_session_changed', '/cds-settings');
      expect(fixture.providers.google.complete).not.toHaveBeenCalled();
      await fixture.viewer(otherSession, different);
      await fixture.viewer(newOriginalSession, original);
      expect(await fixture.store.countUsers()).toBe(2);
    } finally { await fixture.close(); }
  });

  it('does not transfer an existing identity or perform the same callback twice', async () => {
    const fixture = await setup();
    try {
      const original = await fixture.person('identity-owner');
      const second = await fixture.person('identity-contender');
      const originalSession = await fixture.localLogin(original.username!);
      const secondSession = await fixture.localLogin(second.username!);
      const profile = { subject: '45420044', label: 'fixture-identity-label' };

      const first = await fixture.complete('github', 'bind', profile, originalSession);
      fixture.assertBound(first.response, 'github');

      const replay = await fixture.callback('github', first.state, first.code, first.cookie, originalSession);
      fixture.blockedCallback(replay, 'github', 'oauth_state_invalid', '/login');
      expect(fixture.providers.github.complete).toHaveBeenCalledTimes(1);

      const conflict = await fixture.complete('github', 'bind', profile, secondSession);
      const destination = fixture.blockedCallback(conflict.response, 'github', 'identity_taken', '/cds-settings');
      expect([profile.subject, profile.label, conflict.state, conflict.code].every(value => !destination.href.includes(value))).toBe(true);
      const audit = await fixture.authService.listActivity({ userId: second.id });
      const refusal = audit.find(row => row.action === 'link-identity-denied');
      expect(refusal).toMatchObject({ userId: second.id, targetId: second.id });
      expect([original.id, profile.subject, profile.label, conflict.state, conflict.code].every(value =>
        !JSON.stringify(refusal).includes(value))).toBe(true);

      const login = await fixture.complete('github', 'login', profile);
      await fixture.loggedIn(login.response, original);
      await fixture.viewer(secondSession, second);
      expect(await fixture.store.countUsers()).toBe(2);
    } finally { await fixture.close(); }
  });

  it('never infers an unbound account by the upstream label or creates a user on login', async () => {
    const fixture = await setup();
    try {
      const user = await fixture.person('matching-member');
      for (const provider of providersInOrder) {
        const label = provider === 'github' ? user.username! : user.email!;
        const subject = '45420045';
        const attempt = await fixture.complete(provider, 'login', { subject, label });
        const destination = fixture.blockedCallback(attempt.response, provider, 'account_unavailable', '/login');
        expect(destination.href.includes(subject)).toBe(false);
      }
      expect(await fixture.store.countUsers()).toBe(1);
      await fixture.viewer(await fixture.localLogin(user.username!), user);
    } finally { await fixture.close(); }
  });

  it('issues host-scoped cookies and redirects a successful login only within CDS', async () => {
    const fixture = await setup(true);
    try {
      const user = await fixture.person('hosted-member');
      const session = await fixture.localLogin(user.username!);
      const profile = { subject: 'fixture-hosted-subject', label: 'Hosted member' };
      const bind = await fixture.complete('google', 'bind', profile, session);
      fixture.assertBound(bind.response, 'google');

      for (const redirect of ['//outside.fixture.invalid/path', '/fixture/..//outside.fixture.invalid/path']) {
        const login = await fixture.complete('google', 'login', profile, undefined, redirect);
        await fixture.loggedIn(login.response, user, '/project-list');
      }
    } finally { await fixture.close(); }
  });
});

describe('personal account invitations', () => {
  const activationPath = '/api/auth/invitations/activate';

  it('starts with no password and activates the existing account with a new local password', async () => {
    const fixture = await setup();
    try {
      const username = 'invited-password-member';
      const { user, invitation } = await fixture.authService.createAccountInvitation({
        username, name: '合成受邀成员', isAdministrator: true, externalLoginAllowed: true,
      });
      expect(user.username).toBe(username);
      expect(user.externalLoginAllowed).toBe(true);
      expect(Boolean(user.passwordHash)).toBe(false);
      expect(Boolean(user.passwordSalt)).toBe(false);
      expect(typeof invitation).toBe('string');
      expect(invitation.length).toBeGreaterThan(0);

      const password = 'member-chosen-fixture-password';
      const premature = await fixture.call('/api/auth/login', { json: { username, password } });
      expect(premature.status).toBe(401);
      expect(Boolean(activeCookie(premature, fixture.sessionName))).toBe(false);

      const activation = await fixture.call(activationPath, { json: { invitation, password } });
      expect(activation.status).toBe(200);
      const payload = await activation.json();
      expect(payload.user).toMatchObject({
        id: user.id, username, role: 'admin', externalLoginAllowed: true, hasPassword: true, invitationPending: false,
      });
      expect(payload.user).not.toHaveProperty('passwordHash');
      expect(payload.user).not.toHaveProperty('passwordSalt');
      expect(payload.user).not.toHaveProperty('invitationHash');
      const activated = activeCookie(activation, fixture.sessionName);
      expect(Boolean(activated)).toBe(true);
      await fixture.viewer(activated!, user);
      await fixture.viewer(await fixture.localLogin(username, password), user);
      expect(await fixture.store.countUsers()).toBe(1);
    } finally { await fixture.close(); }
  });

  it('preserves a ticket after password validation and denies forged, expired and repeated invitations', async () => {
    const fixture = await setup();
    try {
      const { user, invitation } = await fixture.authService.createAccountInvitation({ username: 'invite-retry-member' });
      const expired = await fixture.authService.createAccountInvitation({ username: 'invite-expired-member' });
      expect(Boolean(user.externalLoginAllowed)).toBe(false);
      const password = 'first-valid-fixture-password';
      const activate = (ticket: string, proposedPassword: string) =>
        fixture.call(activationPath, { json: { invitation: ticket, password: proposedPassword } });
      const invalid = async (response: Response) => {
        expect(response.status).toBe(400);
        expect(await response.json()).toHaveProperty('code', 'invalid_invitation');
        expect(Boolean(activeCookie(response, fixture.sessionName))).toBe(false);
      };

      await invalid(await fixture.activateStart('github', invitation));
      expect(fixture.providers.github.authorizationUrl).not.toHaveBeenCalled();
      const weak = await activate(invitation, 'short');
      expect(weak.status).toBe(400);
      expect(Boolean(activeCookie(weak, fixture.sessionName))).toBe(false);
      await invalid(await activate('fixture-unissued-invitation', password));
      await invalid(await activate('A'.repeat(43), password));

      const issued = await activate(invitation, password);
      expect(issued.status).toBe(200);
      const session = activeCookie(issued, fixture.sessionName);
      expect(Boolean(session)).toBe(true);
      await invalid(await activate(invitation, 'different-valid-fixture-password'));
      await fixture.viewer(session!, user);
      await fixture.viewer(await fixture.localLogin(user.username!, password), user);

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const expiresAt = Date.parse(expired.expiresAt);
        expect(Number.isFinite(expiresAt)).toBe(true);
        vi.setSystemTime(expiresAt + 1);
        await invalid(await activate(expired.invitation, password));
      } finally { vi.useRealTimers(); }
      expect(await fixture.store.countUsers()).toBe(2);
      expect(Boolean((await fixture.store.findUserById(expired.user.id))?.passwordHash)).toBe(false);
    } finally { await fixture.close(); }
  });

  it('activates an invited person through either provider while keeping the original ID and no password', async () => {
    const fixture = await setup();
    try {
      for (const provider of providersInOrder) {
        const username = `invited-${provider}-member`;
        const { user, invitation } = await fixture.authService.createAccountInvitation({ username, externalLoginAllowed: true });
        const profile = { subject: provider === 'github' ? '45420046' : 'fixture-activate-google-46', label: 'Fixture invited person' };
        const flow = await fixture.beginActivation(provider, invitation);
        const activated = await fixture.finish(provider, flow, profile);

        expect(activated.response.status).toBe(302);
        const destination = responseLocation(activated.response);
        expect(destination.origin).toBe(publicBaseUrl);
        expect(destination.pathname).toBe('/cds-settings');
        expect(destination.hash).toBe('#my-account');
        expect(destination.searchParams.get('external')).not.toBe('error');
        expect(destination.href.includes(invitation)).toBe(false);
        await fixture.readIssuedSession(activated.response, user);
        expect((await fixture.authService.findUserByExternalIdentity(provider, profile.subject))?.id).toBe(user.id);
        expect(Boolean((await fixture.store.findUserById(user.id))?.passwordHash)).toBe(false);

        const externalLogin = await fixture.complete(provider, 'login', { ...profile, label: 'Changed upstream label' });
        await fixture.loggedIn(externalLogin.response, user);
      }
      expect(await fixture.store.countUsers()).toBe(2);
    } finally { await fixture.close(); }
  });

  it('requires the activation browser proof and a still-unused invitation when an OAuth callback completes', async () => {
    const fixture = await setup();
    try {
      const { user, invitation } = await fixture.authService.createAccountInvitation({
        username: 'invited-once-member', externalLoginAllowed: true,
      });
      const firstBrowser = await fixture.beginActivation('github', invitation);
      const otherBrowser = await fixture.beginActivation('google', invitation);
      const invalid = await fixture.callback('github', firstBrowser.state, 'fixture-unused-code', otherBrowser.cookie);
      fixture.blockedCallback(invalid, 'github', 'oauth_state_invalid');
      expect(fixture.providers.github.complete).not.toHaveBeenCalled();

      const firstProfile = { subject: '45420047', label: 'Fixture first activation' };
      const secondProfile = { subject: 'fixture-second-activation-47', label: 'Fixture second activation' };
      const first = await fixture.finish('github', firstBrowser, firstProfile);
      await fixture.readIssuedSession(first.response, user);

      const second = await fixture.finish('google', otherBrowser, secondProfile);
      fixture.blockedCallback(second.response, 'google', 'invalid_invitation', '/login');
      expect(await fixture.authService.findUserByExternalIdentity('google', secondProfile.subject)).toBeNull();
      expect((await fixture.authService.findUserByExternalIdentity('github', firstProfile.subject))?.id).toBe(user.id);

      const reused = await fixture.activateStart('github', invitation);
      expect(reused.status).toBe(400);
      const rejection = await reused.json();
      expect(rejection.code ?? rejection.error).toBe('invalid_invitation');
      expect(Boolean(activeCookie(reused, fixture.sessionName))).toBe(false);
      await fixture.readIssuedSession(first.response, user);
      expect(await fixture.store.countUsers()).toBe(1);
    } finally { await fixture.close(); }
  });
});

describe('unlinking a personal login identity', () => {
  it('keeps the last usable login and session when there is no enabled alternative', async () => {
    const store = new MemoryAuthStore();
    const fixture = await setup(false, { store });
    const github = { subject: '45420048', label: 'Fixture sole GitHub login' };
    const google = { subject: 'fixture-disabled-google-48', label: 'Fixture secondary Google login' };
    const assertLastMethod = async (response: Response) => {
      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty('code', 'last_login_method');
    };
    let user: CdsUser;
    let session: string;
    try {
      const account = await fixture.authService.createAccountInvitation({
        username: 'last-login-member', externalLoginAllowed: true,
      });
      user = account.user;
      const flow = await fixture.beginActivation('github', account.invitation);
      const activation = await fixture.finish('github', flow, github);
      await fixture.readIssuedSession(activation.response, user);
      session = activeCookie(activation.response, fixture.sessionName)!;
      expect((await fixture.unlink('github')).status).toBe(401);
      await assertLastMethod(await fixture.unlink('github', session));
      await fixture.viewer(session, user);
      expect(Boolean((await store.findUserById(user.id))?.passwordHash)).toBe(false);

      const secondary = await fixture.complete('google', 'bind', google, session);
      fixture.assertBound(secondary.response, 'google');
    } finally { await fixture.close(); }

    // Keep the stored account and session but start another router with Google disabled.
    const githubOnly = await setup(false, { store, enabled: ['github'] });
    try {
      expect((await githubOnly.authService.findUserByExternalIdentity('google', google.subject))?.id).toBe(user.id);
      expect((await githubOnly.start('google', 'login')).status).toBe(404);
      await assertLastMethod(await githubOnly.unlink('github', session));
      await githubOnly.viewer(session, user);
      const login = await githubOnly.complete('github', 'login', github);
      await githubOnly.loggedIn(login.response, user);
      expect(await store.countUsers()).toBe(1);
    } finally { await githubOnly.close(); }
  });

  it('allows unlink with either remaining method and revokes old sessions for only that account', async () => {
    const fixture = await setup();
    try {
      const passwordUser = await fixture.person('unlink-password-member');
      const passwordSession = await fixture.localLogin(passwordUser.username!);
      const github = { subject: '45420049', label: 'Fixture removable GitHub login' };
      const bound = await fixture.complete('github', 'bind', github, passwordSession);
      fixture.assertBound(bound.response, 'github');

      const { user: externalUser, invitation } = await fixture.authService.createAccountInvitation({
        username: 'unlink-external-member', externalLoginAllowed: true,
      });
      const firstProfile = { subject: 'fixture-unlink-google-49', label: 'Fixture removable Google login' };
      const otherProfile = { subject: '45420050', label: 'Fixture retained GitHub login' };
      const flow = await fixture.beginActivation('google', invitation);
      const activation = await fixture.finish('google', flow, firstProfile);
      await fixture.readIssuedSession(activation.response, externalUser);
      const externalSession = activeCookie(activation.response, fixture.sessionName)!;
      const other = await fixture.complete('github', 'bind', otherProfile, externalSession);
      fixture.assertBound(other.response, 'github');

      async function remove(provider: Provider, profile: Identity, session: string, user: CdsUser) {
        const oldProviderLogin = await fixture.complete(provider, 'login', profile);
        await fixture.loggedIn(oldProviderLogin.response, user);
        const oldProviderSession = activeCookie(oldProviderLogin.response, fixture.sessionName)!;
        const response = await fixture.unlink(provider, session);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.user).toMatchObject({ id: user.id, username: user.username, authProvider: 'local' });
        expect(body.user.linkedLogins).not.toHaveProperty(provider);
        for (const cookie of [session, oldProviderSession]) {
          expect((await fixture.call('/api/fixture-viewer', { cookie })).status).toBe(401);
        }
        expect(await fixture.authService.findUserByExternalIdentity(provider, profile.subject)).toBeNull();
        const removed = await fixture.complete(provider, 'login', profile);
        fixture.blockedCallback(removed.response, provider, 'account_unavailable', '/login');
        return body.user;
      }

      expect((await remove('github', github, passwordSession, passwordUser)).hasPassword).toBe(true);
      await fixture.viewer(externalSession, externalUser);
      const freshPassword = await fixture.localLogin(passwordUser.username!);
      await fixture.viewer(freshPassword, passwordUser);

      const remaining = await remove('google', firstProfile, externalSession, externalUser);
      expect(remaining).toMatchObject({ hasPassword: false, linkedLogins: { github: otherProfile.label } });
      const freshProvider = await fixture.complete('github', 'login', otherProfile);
      await fixture.loggedIn(freshProvider.response, externalUser);
      await fixture.viewer(freshPassword, passwordUser);
      expect(await fixture.store.countUsers()).toBe(2);
    } finally { await fixture.close(); }
  });

  it('blocks legacy GitHub account creation after unlink while allowing explicit rebinding', async () => {
    const detached = { subject: '45420051', label: 'fixture-legacy-detached' };
    const unseen = { subject: '45420052', label: 'fixture-legacy-unseen' };
    const fixture = await setup(false, { legacyGithubProfiles: { detached, unseen } });
    try {
      await fixture.authService.createLocalUser({ username: 'fixture-legacy-owner', password: fixturePassword, isSystemOwner: true });
      const user = await fixture.person('legacy-unlink-member');
      const bind = async (session: string) => {
        const bound = await fixture.complete('github', 'bind', detached, session);
        fixture.assertBound(bound.response, 'github');
      };
      const session = await fixture.localLogin(user.username!);
      await bind(session);
      await fixture.loggedIn(await fixture.legacyGithubLogin('detached'), user);
      expect((await fixture.unlink('github', session)).status).toBe(200);

      const rejected = await fixture.legacyGithubLogin('detached');
      expect({
        status: rejected.status, sessionIssued: Boolean(activeCookie(rejected, fixture.sessionName)),
        userCount: await fixture.store.countUsers(),
      }).toEqual({ status: 403, sessionIssued: false, userCount: 2 });
      const recovery = await rejected.text();
      expect(recovery).toContain('href="/login"');
      expect(recovery).toContain('重新绑定 GitHub');

      await bind(await fixture.localLogin(user.username!));
      await fixture.loggedIn(await fixture.legacyGithubLogin('detached'), user);
      expect(await fixture.store.countUsers()).toBe(2);

      const registered = await fixture.legacyGithubLogin('unseen');
      expect(registered.status).toBe(302);
      expect(Boolean(activeCookie(registered, fixture.sessionName))).toBe(true);
      const newUser = await fixture.authService.findUserByExternalIdentity('github', unseen.subject);
      expect(newUser).not.toBeNull();
      expect(toPublicUser(newUser!)).toMatchObject({ githubLogin: unseen.label, authProvider: 'github' });
      expect(newUser?.id).not.toBe(user.id);
      expect(await fixture.store.countUsers()).toBe(3);
    } finally { await fixture.close(); }
  });
});
