import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { getDomain } from 'tldts';
import type { CdsSession, CdsUser } from '../domain/auth.js';
import { authCookie, readAuthCookie, trustedAuthOrigin } from '../routes/passkeys.js';
import { GH_SESSION_COOKIE } from '../routes/auth.js';
import type { AuthService } from './auth-service.js';
import { ExpiringTokens } from './expiring-tokens.js';
import { canHumanAccessProject, supportsHumanProjectGrant } from './human-project-access.js';
import type { StateService } from './state.js';
import type { Collection } from 'mongodb';
import type { OidcArtifact } from '../infra/auth-store/oidc-store.js';

export const SITE_SESSION_COOKIE = '__Host-cds-site-session';
export const SITE_FLOW_COOKIE = '__Host-cds-site-flow';
const BROWSER_COOKIE = '__Host-cds-sso-browser';
const SITE_SSO_PATH = '/_cds/sso';
export const GATEWAY_CHECK_PATH = '/api/hosted-sso/gateway';
const FLOW_TTL = 5 * 60_000;
const CODE_TTL = 45_000;
const SITE_TTL = 8 * 3_600_000;
const BROWSER_TTL = 30 * 24 * 3_600_000;

export interface HostedSsoConfig {
  /** Exact public HTTPS origin assigned by a CDS deployment route. */
  origin: string;
  /** Changes with configuration or explicit revocation. */
  revision: string;
  /** Initial and default audience is the existing project membership. */
  deniedUserIds: string[];
  suspended?: true;
  application?: { callbackPath: string; accounts: Record<string, string> };
}

export interface GatewayRequest {
  branchId: string;
  host: string;
  path: string;
  method: string;
  sessionToken: string | null;
  flowToken: string | null;
  origin?: string;
  navigation: boolean;
}

export type GatewayDecision = { allow: true; protected?: true } | {
  allow: false;
  status: number;
  location?: string;
  cookie?: string;
  cookies?: string[];
  response?: Record<string, unknown>;
  loginCancelled?: true;
};

export type Site = { id: string; projectId: string; label: string; revision: string; origin: URL; deniedUserIds: string[]; application?: HostedSsoConfig['application'] };
type SiteSession = { branchId: string; revision: string; cdsToken: string };
type SiteFlow = { branchId: string; revision: string; path: string; choose: boolean };
type Code = SiteSession & { flowToken: string; returnPath: string };
export type BrowserAccounts = { id?: string; sessions: Map<string, string>; preferences: Map<string, string> };
type Identity = { user: CdsUser; session: CdsSession };

const allow: GatewayDecision = { allow: true };
const protectedAllow: GatewayDecision = { allow: true, protected: true };
export const unavailable = { allow: false, status: 503, response: { error: 'CDS 登录暂不可用，请稍后重试。' } } satisfies GatewayDecision;
const forbidden: GatewayDecision = { allow: false, status: 403, response: { error: '当前账号无权访问此站点，请在 CDS 核对授权。' } };

export function isSsoOriginIsolated(authority: URL, site: URL): boolean {
  const authorityDomain = getDomain(authority.hostname, { allowPrivateDomains: true });
  const siteDomain = getDomain(site.hostname, { allowPrivateDomains: true });
  return Boolean(authorityDomain && siteDomain && authorityDomain !== siteDomain);
}

export function preferenceKey(site: Site): string {
  return createHash('sha256').update(`${site.id} ${site.origin.origin}`).digest('hex');
}

export function siteReturnPath(raw: string | null | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f]|%5c/i.test(raw)) return '/';
  const base = new URL('https://return.invalid');
  const url = new URL(raw, base);
  if (url.origin !== base.origin || url.pathname.startsWith('/_cds/')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isGatewaySecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(secret);
}

export function requiresGatewaySecret(header: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function captureGatewayRequest(req: IncomingMessage, branchId: string): GatewayRequest {
  return {
    branchId,
    host: req.headers.host?.toLowerCase() ?? '',
    path: req.url ?? '/',
    method: req.method?.toUpperCase() ?? 'GET',
    sessionToken: readAuthCookie(req.headers.cookie, SITE_SESSION_COOKIE),
    flowToken: readAuthCookie(req.headers.cookie, SITE_FLOW_COOKIE),
    origin: req.headers.origin,
    navigation: req.headers['sec-fetch-mode'] === 'navigate' || Boolean(req.headers.accept?.includes('text/html')),
  };
}

export function isHostedSsoPath(path: string | undefined): boolean {
  return Boolean(path?.startsWith(`${SITE_SSO_PATH}/`));
}

const protectedRequests = new WeakSet<IncomingMessage>();

export function markHostedSsoRequest(req: IncomingMessage): void {
  protectedRequests.add(req);
  stripSiteCredentials(req);
}

export function isHostedSsoRequest(req: IncomingMessage): boolean {
  return protectedRequests.has(req);
}

export function stripSiteCredentials(req: IncomingMessage): void {
  if (!req.headers.cookie) return;
  const cookies = req.headers.cookie.split(';').filter(cookie => !/^__Host-cds-(?:site-session|site-flow)=/.test(cookie.trim()));
  if (cookies.length) req.headers.cookie = cookies.join(';');
  else delete req.headers.cookie;
}

export function respondToGateway(res: ServerResponse, decision: Exclude<GatewayDecision, { allow: true }>): void {
  const headers: Record<string, string | string[]> = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'application/json; charset=utf-8' };
  if (decision.location) headers.Location = decision.location;
  if (decision.cookie || decision.cookies) headers['Set-Cookie'] = decision.cookies ?? [decision.cookie!];
  if (decision.loginCancelled) {
    headers['Content-Type'] = 'text/html; charset=utf-8';
    headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    res.writeHead(decision.status, headers);
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录已取消</title><h1>登录已取消</h1><p><a href="/_cds/sso/start">重新登录站点</a></p></html>');
    return;
  }
  res.writeHead(decision.status, headers);
  res.end(decision.response ? JSON.stringify(decision.response) : undefined);
}

export function watchSiteConnection(socket: Duplex, check: () => Promise<GatewayDecision>): void {
  const timer = setInterval(() => {
    void check().then(decision => {
      if (!decision.allow || !decision.protected) socket.destroy();
    }).catch(() => socket.destroy());
  }, 30_000);
  timer.unref();
  socket.once('close', () => clearInterval(timer));
}

export class HostedSso {
  private readonly flows = new ExpiringTokens<SiteFlow>(4096);
  private readonly codes = new ExpiringTokens<Code>(4096);
  private readonly siteSessions = new ExpiringTokens<SiteSession>(50_000);
  private readonly browsers = new ExpiringTokens<BrowserAccounts>(10_000);
  private readonly updatingSites = new Set<string>();
  private readonly counters = { startedAt: new Date().toISOString(), callbackSucceeded: 0, callbackFailed: 0, denied: 0 };
  private nextBrowserCleanup = 0;

  constructor(readonly authority: URL, private readonly state: StateService, private readonly auth: AuthService,
    private readonly markPrivate?: (branchId: string) => void, private readonly persistence?: Collection<OidcArtifact>) {}

  configure(branchId: string, origin: URL, deniedUserIds: string[]): HostedSsoConfig {
    const branch = this.state.getBranch(branchId);
    if (!branch || !supportsHumanProjectGrant(this.state.getProject(branch.projectId))) throw new Error('wrong_project');
    if (!isSsoOriginIsolated(this.authority, origin)) throw new Error('same_site');
    return { origin: origin.origin, deniedUserIds, revision: randomUUID() };
  }

  site(branchId: string): Site | undefined {
    const branch = this.state.getBranch(branchId);
    const config = branch?.hostedSso;
    if (!branch || !config || branch.deleting || config.suspended || this.updatingSites.has(branchId)) return undefined;
    const origin = trustedAuthOrigin(config.origin);
    if (!origin || !isSsoOriginIsolated(this.authority, origin)) return undefined;
    return { id: branch.id, projectId: branch.projectId, label: branch.branch, revision: config.revision, origin, deniedUserIds: config.deniedUserIds, application: config.application };
  }

  async updateSite(branchId: string, config: HostedSsoConfig): Promise<void> {
    const branch = this.state.getBranch(branchId);
    if (!branch || this.updatingSites.has(branchId)) throw new Error('site_update_in_progress');
    const previous = branch.hostedSso;
    this.markPrivate?.(branchId);
    this.updatingSites.add(branchId);
    branch.hostedSso = config;
    try {
      this.state.save();
      await this.state.flush();
    } catch (error) {
      branch.hostedSso = previous || { ...config, suspended: true };
      this.state.save();
      await this.state.flush();
      throw error;
    } finally {
      this.updatingSites.delete(branchId);
    }
  }

  async authorized(site: Site, token: string | null): Promise<Identity | null> {
    const identity = await this.auth.validateSession(token, { renew: false });
    const live = this.site(site.id);
    if (!identity || live?.revision !== site.revision || live.deniedUserIds.includes(identity.user.id)) return null;
    const project = this.state.getProject(site.projectId);
    if (!supportsHumanProjectGrant(project) || !canHumanAccessProject({ cdsUser: identity.user, cdsSession: identity.session }, this.state, site.projectId)) return null;
    return identity;
  }

  async browser(cookie: string | undefined): Promise<{ accounts: BrowserAccounts; newCookie?: string } | undefined> {
    const token = readAuthCookie(cookie, BROWSER_COOKIE);
    if (this.persistence) {
      const idFor = (value: string) => `Browser:${createHash('sha256').update(value).digest('hex')}`;
      const existing = token && await this.persistence.findOne({ _id: idFor(token), expiresAt: { $gt: new Date() } });
      if (existing && existing.browser) {
        return { accounts: { id: existing._id, sessions: new Map(Object.entries(existing.browser.sessions)),
          preferences: new Map(Object.entries(existing.browser.preferences)) } };
      }
      const next = randomBytes(32).toString('base64url');
      const id = idFor(next);
      await this.persistence.insertOne({ _id: id, model: 'Browser', expiresAt: new Date(Date.now() + BROWSER_TTL),
        browser: { sessions: {}, preferences: {} } });
      if (Date.now() >= this.nextBrowserCleanup) {
        this.nextBrowserCleanup = Date.now() + 60_000;
        void this.persistence.deleteMany({ model: 'Browser', expiresAt: { $lte: new Date() } }).catch(() => undefined);
      }
      return { accounts: { id, sessions: new Map(), preferences: new Map() }, newCookie: authCookie(BROWSER_COOKIE, next, BROWSER_TTL / 1000) };
    }
    const existing = this.browsers.read(token);
    if (existing) return { accounts: existing };
    const accounts = { sessions: new Map<string, string>(), preferences: new Map<string, string>() };
    const next = this.browsers.issue(accounts, BROWSER_TTL);
    return next ? { accounts, newCookie: authCookie(BROWSER_COOKIE, next, BROWSER_TTL / 1000) } : undefined;
  }

  async rememberCurrent(accounts: BrowserAccounts, cookie: string | undefined): Promise<string | undefined> {
    const current = await this.auth.validateSession(readAuthCookie(cookie, GH_SESSION_COOKIE), { renew: false });
    if (!current) return undefined;
    const userId = current.user.id;
    if (!accounts.sessions.has(userId) && accounts.sessions.size >= 16) return undefined;
    if (accounts.id && accounts.sessions.get(userId) !== current.session.token) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return undefined;
      await this.persistence?.updateOne({ _id: accounts.id }, { $set: { [`browser.sessions.${userId}`]: current.session.token } });
    }
    accounts.sessions.set(userId, current.session.token);
    return userId;
  }

  async rememberSelection(accounts: BrowserAccounts, site: Site, userId: string): Promise<void> {
    const key = preferenceKey(site);
    if (accounts.preferences.get(key) === userId) return;
    if (accounts.id) await this.persistence?.updateOne({ _id: accounts.id }, { $set: { [`browser.preferences.${key}`]: userId } });
    accounts.preferences.set(key, userId);
  }

  async accountsForSite(accounts: BrowserAccounts, site: Site): Promise<CdsUser[]> {
    const users: CdsUser[] = [];
    for (const token of accounts.sessions.values()) {
      const identity = await this.authorized(site, token);
      if (identity) users.push(identity.user);
    }
    return users;
  }

  flow(token: unknown): { flow: SiteFlow; site: Site } | undefined {
    const flow = this.flows.read(token);
    const site = flow && this.site(flow.branchId);
    if (flow && site && site.revision === flow.revision) return { flow, site };
    return undefined;
  }

  cancelLogin(flowToken: string): void { this.flows.read(flowToken, true); }

  async completeAuthorization(accounts: BrowserAccounts, site: Site, flowToken: string, userId: string): Promise<URL | undefined> {
    const token = accounts.sessions.get(userId);
    if (!token || !await this.authorized(site, token)) return undefined;
    const flow = this.flows.read(flowToken, true);
    if (!flow || flow.branchId !== site.id || flow.revision !== site.revision) return undefined;
    const code = this.codes.issue({ branchId: site.id, revision: site.revision, cdsToken: token, flowToken, returnPath: flow.path }, CODE_TTL);
    if (!code) return undefined;
    await this.rememberSelection(accounts, site, userId);
    const callback = new URL(`${SITE_SSO_PATH}/callback`, site.origin);
    callback.searchParams.set('code', code);
    return callback;
  }

  private startLogin(site: Site, path: string, choose: boolean): GatewayDecision {
    const flowToken = this.flows.issue({ branchId: site.id, revision: site.revision, path: siteReturnPath(path), choose }, FLOW_TTL);
    if (!flowToken) return { allow: false, status: 429, response: { error: '登录请求过多，请稍后重试。' } };
    const target = new URL('/api/hosted-sso/authorize', this.authority);
    target.searchParams.set('flow', flowToken);
    return { allow: false, status: 303, location: target.toString(), cookie: authCookie(SITE_FLOW_COOKIE, flowToken, FLOW_TTL / 1000) };
  }

  statistics(): Readonly<typeof this.counters> { return { ...this.counters }; }

  async check(input: GatewayRequest): Promise<GatewayDecision> {
    const decision = await this.decide(input);
    if (!decision.allow) {
      if (input.path.split('?')[0] === `${SITE_SSO_PATH}/callback`) {
        if (decision.status === 303) this.counters.callbackSucceeded++;
        else this.counters.callbackFailed++;
      }
      if (decision.status === 401 || decision.status === 403) this.counters.denied++;
    }
    return decision;
  }

  private async decide(input: GatewayRequest): Promise<GatewayDecision> {
    const branch = this.state.getBranch(input.branchId);
    if (!branch || branch.deleting) return forbidden;
    const ssoPath = input.path.split('?')[0].startsWith(`${SITE_SSO_PATH}/`);
    if (!branch.hostedSso) {
      if (ssoPath && input.path.split('?')[0] === `${SITE_SSO_PATH}/status`) return { allow: false, status: 200, response: { enabled: false } };
      return ssoPath ? { allow: false, status: 404 } : allow;
    }
    const site = this.site(input.branchId);
    if (!site || site.origin.host !== input.host) return forbidden;
    if (!input.path.startsWith('/') || input.path.startsWith('//') || /[\\\x00-\x1f]/.test(input.path)) return { allow: false, status: 400 };
    const url = new URL(input.path, site.origin);
    if (input.method === 'GET' && url.pathname === `${SITE_SSO_PATH}/cancelled`) {
      return { allow: false, status: 401, loginCancelled: true, cookie: authCookie(SITE_FLOW_COOKIE, '', 0) };
    }
    if (input.method === 'GET' && url.pathname === `${SITE_SSO_PATH}/start`) {
      return this.startLogin(site, url.searchParams.get('return') || '/', url.searchParams.get('choose') === '1');
    }
    if (input.method === 'GET' && url.pathname === `${SITE_SSO_PATH}/callback`) {
      const code = this.codes.read(url.searchParams.get('code'));
      if (!code || code.flowToken !== input.flowToken || code.branchId !== site.id || code.revision !== site.revision) return forbidden;
      const consumed = this.codes.read(url.searchParams.get('code'), true);
      if (!consumed || !await this.authorized(site, consumed.cdsToken)) return forbidden;
      const token = this.siteSessions.issue({ branchId: site.id, revision: site.revision, cdsToken: consumed.cdsToken }, SITE_TTL);
      if (!token) return unavailable;
      // Session replacement is site-local, including when the user switches accounts.
      const previous = this.siteSessions.read(input.sessionToken);
      if (previous?.branchId === site.id) this.siteSessions.read(input.sessionToken, true);
      return { allow: false, status: 303, location: consumed.returnPath,
        cookies: [authCookie(SITE_SESSION_COOKIE, token, SITE_TTL / 1000), authCookie(SITE_FLOW_COOKIE, '', 0)] };
    }
    const session = this.siteSessions.read(input.sessionToken);
    const identity = session && session.branchId === site.id && session.revision === site.revision
      ? await this.authorized(site, session.cdsToken) : null;
    if (input.method === 'GET' && url.pathname === `${SITE_SSO_PATH}/status`) {
      return { allow: false, status: 200, response: { enabled: true, name: identity?.user.name ?? null } };
    }
    if (ssoPath) return { allow: false, status: 404 };
    if (identity) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(input.method) && input.origin !== site.origin.origin) return forbidden;
      if (input.origin && input.origin !== site.origin.origin && input.path.startsWith('/_cds/')) return forbidden;
      return protectedAllow;
    }
    if (!session && input.method === 'GET' && input.navigation) return this.startLogin(site, input.path, false);
    return { allow: false, status: 401, response: { error: '站点登录已失效，请从 CDS 面板重新登录。' } };
  }
}
