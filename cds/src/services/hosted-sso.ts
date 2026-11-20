import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDomain } from 'tldts';
import type { Collection } from 'mongodb';
import type { CdsSession, CdsUser } from '../domain/auth.js';
import type { RouteRecord } from '../forwarder/types.js';
import type { OidcArtifact } from '../infra/auth-store/oidc-store.js';
import { GH_SESSION_COOKIE, sessionCookieName } from '../routes/auth.js';
import { authCookie, readAuthCookie, trustedAuthOrigin } from '../routes/passkeys.js';
import type { AuthService } from './auth-service.js';
import { ExpiringTokens } from './expiring-tokens.js';
import { canHumanAccessProject, supportsHumanProjectGrant } from './human-project-access.js';
import type { StateService } from './state.js';

const BROWSER_COOKIE = '__Host-cds-sso-browser';
const BROWSER_TTL = 30 * 24 * 3_600_000;

type Application = { callbackPath: string; loginPath: string };
export interface HostedSsoConfig {
  origin: string;
  revision: string;
  deniedUserIds: string[];
  suspended?: true;
  application?: Application;
}

export type Site = {
  id: string;
  projectId: string;
  label: string;
  revision: string;
  origin: URL;
  deniedUserIds: string[];
  application: Application;
};

export type BrowserAccounts = { id?: string; sessions: Map<string, string>; preferences: Map<string, string> };
type Identity = { user: CdsUser; session: CdsSession };

export function isCommonSite(issuer: URL, site: URL): boolean {
  const domain = getDomain(issuer.hostname, { allowPrivateDomains: true });
  return issuer.protocol === 'https:' && site.protocol === 'https:' && issuer.hostname !== site.hostname
    && Boolean(domain && domain === getDomain(site.hostname, { allowPrivateDomains: true }));
}

export function preferenceKey(site: Site): string {
  return createHash('sha256').update(`${site.id} ${site.origin.origin}`).digest('hex');
}

export function siteReturnPath(raw: string | null | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f]|%5c/i.test(raw)) return '/';
  const base = new URL('https://return.invalid');
  const url = new URL(raw, base);
  if (url.origin !== base.origin || url.pathname.startsWith('/_cds/')) return '/';
  return `${url.pathname}${url.search}`;
}

export function isApplicationPath(value: unknown): value is string {
  return typeof value === 'string' && value !== '/' && value === siteReturnPath(value) && !/[?#]/.test(value);
}

export class HostedSso {
  private readonly browsers = new ExpiringTokens<BrowserAccounts>(10_000);
  private readonly updatingSites = new Set<string>();
  private nextBrowserCleanup = 0;

  constructor(readonly authority: URL, private readonly state: StateService, private readonly auth: AuthService,
    private readonly routes: () => RouteRecord[], private readonly persistence?: Collection<OidcArtifact>) {}

  private publishedBranch(host: string): string | undefined {
    const published = this.routes().filter(route => route.host.toLowerCase() === host && route.weight > 0);
    const branch = published[0]?.branchId;
    return branch && published.every(route => route.branchId === branch) ? branch : undefined;
  }

  originsForBranch(branchId: string): string[] {
    const candidates = new Set(this.routes().filter(route => route.branchId === branchId && route.weight > 0)
      .map(route => route.host.toLowerCase()));
    const origins = [];
    for (const host of candidates) {
      if (!/^[a-z0-9.-]+$/.test(host) || this.publishedBranch(host) !== branchId) continue;
      const origin = trustedAuthOrigin(`https://${host}`);
      if (origin && isCommonSite(this.authority, origin)) origins.push(origin.origin);
    }
    return origins;
  }

  siteForHost(host: string): Site | undefined {
    const branch = this.publishedBranch(host);
    const site = branch ? this.site(branch) : undefined;
    return site?.origin.host === host ? site : undefined;
  }

  configure(branchId: string, origin: URL, deniedUserIds: string[], application?: Application, suspended = false): HostedSsoConfig {
    const branch = this.state.getBranch(branchId);
    if (!branch || !supportsHumanProjectGrant(this.state.getProject(branch.projectId))) throw new Error('wrong_project');
    if (!isCommonSite(this.authority, origin)) throw new Error('wrong_origin');
    if (!this.originsForBranch(branchId).includes(origin.origin) && !(suspended && branch.hostedSso?.origin === origin.origin)) {
      throw new Error('unpublished_origin');
    }
    return { origin: origin.origin, deniedUserIds, revision: randomUUID(), application, ...(suspended ? { suspended: true } : {}) };
  }

  site(branchId: string): Site | undefined {
    const branch = this.state.getBranch(branchId);
    const config = branch?.hostedSso;
    if (!branch || !config?.application || branch.deleting || config.suspended || this.updatingSites.has(branchId)) return undefined;
    const origin = trustedAuthOrigin(config.origin);
    const app = config.application;
    if (!origin || !isCommonSite(this.authority, origin) || this.publishedBranch(origin.host) !== branchId
      || !isApplicationPath(app.loginPath) || !isApplicationPath(app.callbackPath) || app.loginPath === app.callbackPath) return undefined;
    return { id: branch.id, projectId: branch.projectId, label: branch.branch, revision: config.revision, origin,
      deniedUserIds: config.deniedUserIds, application: app };
  }

  async updateSite(branchId: string, config: HostedSsoConfig): Promise<void> {
    const branch = this.state.getBranch(branchId);
    if (!branch || this.updatingSites.has(branchId)) throw new Error('site_update_in_progress');
    const previous = branch.hostedSso;
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
    const current = await this.auth.validateSession(readAuthCookie(cookie, sessionCookieName(GH_SESSION_COOKIE, true)), { renew: false });
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

}
