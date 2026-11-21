import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/services/auth-service.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { HostedSso, isCommonSite, isApplicationPath, siteReturnPath, type HostedSsoConfig } from '../../src/services/hosted-sso.js';
import type { StateService } from '../../src/services/state.js';

const authority = new URL('https://cds.shared.test');
const origin = new URL('https://map.shared.test');
const application = { loginPath: '/auth/start', callbackPath: '/auth/callback' };

async function fixture() {
  const auth = new AuthService({ store: new MemoryAuthStore(), github: null, config: {} });
  const user = await auth.createLocalUser({ username: 'work-test', password: 'isolated-test-password' });
  const session = await auth.createSessionForUser(user.id, { userAgent: null, ipAddress: null });
  const branch = { id: 'map', projectId: 'map', branch: 'main', hostedSso: undefined as HostedSsoConfig | undefined };
  const routes = [{ _id: 'route-map', host: origin.host, branchId: branch.id, upstreamPort: 9000, weight: 100 }];
  const grants = [{ principalId: 'human:' + user.id, projectId: branch.projectId }];
  const state = {
    getBranch: (id: string) => id === branch.id ? branch : undefined,
    getProject: (id: string) => ({ id, kind: 'git' }),
    getProjectGrants: () => grants,
    getHumanAccessRecoveries: () => ({}),
    getPrincipal: () => undefined,
  } as unknown as StateService;
  return { auth, user, session, routes, grants, branch, sso: new HostedSso(authority, state, auth, () => routes) };
}

describe('CDS hosted SSO', () => {
  it('requires a separate origin on the same registrable domain and local paths', () => {
    expect(isCommonSite(authority, origin)).toBe(true);
    expect(isCommonSite(authority, authority)).toBe(false);
    expect(isCommonSite(authority, new URL('https://map.external.test'))).toBe(false);
    expect(isCommonSite(authority, new URL('https://map.shared.test.external.test'))).toBe(false);
    expect(isCommonSite(authority, new URL('http://map.shared.test'))).toBe(false);
    expect(siteReturnPath('/reports/summary?filter=current#sensitive')).toBe('/reports/summary?filter=current');
    expect(siteReturnPath('//external.test')).toBe('/');
    expect(siteReturnPath('/_cds/api/auth')).toBe('/');
    expect(siteReturnPath('/%5C/external.test')).toBe('/');
    expect(isApplicationPath('/auth/start')).toBe(true);
    expect(isApplicationPath('/auth/start?x=y')).toBe(false);
    expect(isApplicationPath('/auth/start#fragment')).toBe(false);
  });

  it('admits just the exact live route of a participating branch', async () => {
    const { sso, branch, routes } = await fixture();
    expect(() => sso.configure(branch.id, new URL('https://unpublished.shared.test'), [], application)).toThrow('unpublished_origin');
    expect(() => sso.configure(branch.id, new URL('https://map.external.test'), [], application)).toThrow('wrong_origin');
    branch.hostedSso = sso.configure(branch.id, origin, [], application);
    expect(sso.siteForHost(origin.host)?.application).toEqual(application);
    routes.push({ ...routes[0], _id: 'route-b', branchId: 'unrelated-branch' });
    expect(sso.site(branch.id)).toBeUndefined();
    routes.splice(1);
    expect(sso.site(branch.id)?.origin.href).toBe(origin.href);
    routes[0].weight = 0;
    expect(sso.site(branch.id)).toBeUndefined();
  });

  it('rechecks route, project, account and session when validating a previously issued grant', async () => {
    const { sso, auth, session, user, branch, routes, grants } = await fixture();
    branch.hostedSso = sso.configure(branch.id, origin, [], application);
    const site = sso.site(branch.id)!;
    expect(await sso.authorized(site, session.token)).toMatchObject({ user: { id: user.id } });
    routes[0].weight = 0;
    expect(await sso.authorized(site, session.token)).toBeNull();
    routes[0].weight = 100;
    const removed = grants.pop()!;
    expect(await sso.authorized(site, session.token)).toBeNull();
    grants.push(removed);
    branch.hostedSso.deniedUserIds.push(user.id);
    expect(await sso.authorized(site, session.token)).toBeNull();
    branch.hostedSso.deniedUserIds.length = 0;
    await auth.logoutAllForUser(user.id);
    expect(await sso.authorized(site, session.token)).toBeNull();
  });

  it('accepts only the host-prefixed CDS sign-in cookie for site selection', async () => {
    const { sso, session, user } = await fixture();
    const browser = (await sso.browser(undefined))!;
    expect(await sso.rememberCurrent(browser.accounts, 'cds_gh_session=' + session.token)).toBeUndefined();
    expect(await sso.rememberCurrent(browser.accounts, '__Host-cds_gh_session=' + session.token)).toBe(user.id);
  });
});
