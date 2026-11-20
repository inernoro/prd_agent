import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/services/auth-service.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { HostedSso, isSsoOriginIsolated, siteReturnPath, type GatewayRequest } from '../../src/services/hosted-sso.js';
import type { StateService } from '../../src/services/state.js';

const authority = new URL('https://cds.example.net');
const originA = new URL('https://a.previews.example.org');
const originB = new URL('https://b.previews.example.org');

function cookieValue(header: string): string {
  return header.split(';')[0].split('=')[1];
}

async function fixture() {
  const auth = new AuthService({ store: new MemoryAuthStore(), github: null, config: {} });
  const user = await auth.createLocalUser({ username: 'work-test', password: 'isolated-test-password' });
  const session = await auth.createSessionForUser(user.id, { userAgent: null, ipAddress: null });
  const makeBranch = (id: string, origin: URL) => ({ id, projectId: id, branch: 'preview', hostedSso: {
    origin: origin.origin, revision: id + '-policy', deniedUserIds: [] as string[],
  } });
  const branches = { a: makeBranch('a', originA), b: makeBranch('b', originB) };
  let grants = ['a', 'b'].map(projectId => ({ projectId, principalId: 'human:' + user.id }));
  const state = {
    getBranch: (id: keyof typeof branches) => branches[id],
    getProject: (id: string) => ({ id, kind: 'git' }),
    getProjectGrants: () => grants,
    getHumanAccessRecoveries: () => ({}),
    getPrincipal: () => undefined,
  } as unknown as StateService;
  const sso = new HostedSso(authority, state, auth);
  const cookies = (await sso.browser(undefined))!;
  await sso.rememberCurrent(cookies.accounts, 'cds_gh_session=' + session.token);
  const request: GatewayRequest = { branchId: 'a', host: originA.host, method: 'GET', path: '/deep?view=list',
    navigation: true, sessionToken: null, flowToken: null };
  return { sso, auth, user, request, cookies, branches, revokeProject: (id: string) => {
    grants = grants.filter(grant => grant.projectId !== id);
  } };
}

describe('CDS hosted SSO', () => {
  it('isolates authorization from sibling registrable domains and validates the return path', () => {
    expect(isSsoOriginIsolated(authority, originA)).toBe(true);
    expect(isSsoOriginIsolated(authority, new URL('https://preview.example.net'))).toBe(false);
    expect(siteReturnPath('/reports/summary?filter=current#today')).toBe('/reports/summary?filter=current#today');
    expect(siteReturnPath('//unregistered.example')).toBe('/');
    expect(siteReturnPath('/_cds/sso/callback')).toBe('/');
    expect(siteReturnPath('/%5C/unregistered.example')).toBe('/');
  });

  it('binds the callback to its original site and browser flow and consumes it once', async () => {
    const { sso, request, cookies, user } = await fixture();
    const redirect = await sso.check(request);
    if (redirect.allow) throw new Error('anonymous request unexpectedly approved');
    expect(redirect.location).toMatch(/^https:\/\/cds\.example\.net\/api\/hosted-sso\/authorize\?/);
    const flowToken = cookieValue(redirect.cookie!);
    const site = sso.flow(flowToken)!.site;
    const callback = (await sso.completeAuthorization(cookies.accounts, site, flowToken, user.id))!;
    const input = { ...request, path: callback.pathname + callback.search, flowToken };
    expect(await sso.check({ ...input, flowToken: null })).toMatchObject({ allow: false, status: 403 });
    expect(await sso.check({ ...input, branchId: 'b', host: originB.host })).toMatchObject({ allow: false, status: 403 });
    const candidates = await Promise.all([sso.check(input), sso.check(input)]);
    expect(candidates.map(decision => decision.allow ? 200 : decision.status).sort()).toEqual([303, 403]);
    expect(candidates.find(decision => !decision.allow && decision.status === 303)).toMatchObject({ location: '/deep?view=list' });
  });

  it('validates membership, account state and origin on every private request', async () => {
    const { sso, request, cookies, user, branches, revokeProject, auth } = await fixture();
    const start = await sso.check(request);
    if (start.allow) throw new Error('anonymous request unexpectedly approved');
    const flowToken = cookieValue(start.cookie!);
    const callback = (await sso.completeAuthorization(cookies.accounts, sso.flow(flowToken)!.site, flowToken, user.id))!;
    const response = await sso.check({ ...request, path: callback.pathname + callback.search, flowToken });
    if (response.allow) throw new Error('callback unexpectedly forwarded');
    const sessionToken = cookieValue(response.cookies![0]);
    const signedIn = { ...request, sessionToken };
    expect(await sso.check(signedIn)).toEqual({ allow: true, protected: true });
    expect(await sso.check({ ...signedIn, method: 'POST', origin: originB.origin })).toMatchObject({ status: 403 });
    expect(await sso.check({ ...signedIn, host: 'alias.example.org' })).toMatchObject({ status: 403 });
    expect(await sso.check({ ...signedIn, branchId: 'b', host: originB.host })).toMatchObject({ status: 401 });
    branches.a.hostedSso.deniedUserIds.push(user.id);
    expect(await sso.check(signedIn)).toMatchObject({ status: 401 });
    branches.a.hostedSso.deniedUserIds.length = 0;
    revokeProject('a');
    expect(await sso.check(signedIn)).toMatchObject({ status: 401 });
    await auth.setUserStatus(user.id, 'disabled');
    expect(await sso.accountsForSite(cookies.accounts, sso.site('b')!)).toEqual([]);
  });
});
