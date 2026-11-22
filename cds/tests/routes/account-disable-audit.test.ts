import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createServer } from '../../src/server.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const actionsPath = '/api/auth/account-actions';
const auditPath = '/api/auth/account-action-audit';
const fakePassword = 'fixture-disable-audit-91+';
const ownerName = 'fixture-disable-audit-owner';
const reason = 'Synthetic change for the account workflow fixture';
const projectA = 'account-audit-team-a';
const projectB = 'account-audit-team-b';
const repositoryFor = (id: string) => `https://git.example.invalid/fixture/${id}.git`;

type Account = { id: string; username: string; role: 'owner' | 'admin' | 'member'; status: 'active' | 'disabled' };
type RequestRecord = {
  id: string;
  action: 'disable-user' | 'revoke-sessions';
  targetId: string;
  targetName: string;
  status: 'pending' | 'completed';
  affectedSessions: number;
  requestedByAccountId: string;
  executedByAccountId?: string;
  requestedVia?: 'agent';
};

describe('account disable and team audit through CDS', () => {
  let root: string;
  let server: Server;
  let ownerCookie: string;

  async function call<T = unknown>(method: string, url: string, cookie = '', body?: object, extraHeaders: Record<string, string> = {}) {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture');
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body && { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json() as T,
      cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('=')).join('; '),
    };
  }

  function login(username: string) {
    return call<{ user: Account }>('POST', '/api/auth/login', '', { username, password: fakePassword });
  }

  async function signIn(username: string) {
    const result = await login(username);
    expect(result.status).toBe(200);
    expect(Boolean(result.cookie)).toBe(true);
    return result.cookie!;
  }

  async function createUser(username: string, role: 'admin' | 'member', actor = ownerCookie) {
    const result = await call<{ user: Account }>('POST', '/api/auth/users', actor, { username, role, password: fakePassword });
    expect(result.status).toBe(201);
    return result.body.user;
  }

  async function submit(action: RequestRecord['action'], target: Account, actor = ownerCookie) {
    const response = await call<{ request: RequestRecord }>('POST', actionsPath, actor, { action, targetId: target.id, reason });
    expect(response.status).toBe(201);
    return response.body.request;
  }

  async function confirm(request: RequestRecord, target: Account, actor = ownerCookie) {
    return call<{ request: RequestRecord }>('POST', `${actionsPath}/${request.id}/confirm`, actor, { targetName: target.username });
  }

  async function audit(cookie: string, query: Record<string, string>) {
    const result = await call<{ records: RequestRecord[] }>('GET', `${auditPath}?${new URLSearchParams(query)}`, cookie);
    expect(result.status).toBe(200);
    return result.body.records;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cds-disable-audit-'));
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', ownerName);
    vi.stubEnv('CDS_PASSWORD', fakePassword);
    vi.stubEnv('CDS_ENV_FILE', path.join(root, 'fixture.env'));
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://127.0.0.1');
    vi.stubEnv('CDS_SSO_ENABLED', 'false');
    vi.stubEnv('CDS_UPSTREAM', '');
    vi.stubEnv('AI_ACCESS_KEY', '');
    vi.stubEnv('CDS_AI_ACCESS_KEY', '');
    vi.stubEnv('CDS_PASSKEYS_ENABLED', 'false');
    const store = new MemoryAuthStore();
    const stateService = new StateService(path.join(root, 'state.json'), root);
    stateService.load();
    const now = new Date().toISOString();
    for (const id of [projectA, projectB]) {
      stateService.addProject({ id, slug: id, name: id, dockerNetwork: id, repoPath: root,
        kind: 'git', legacyFlag: false, gitRepoUrl: repositoryFor(id), createdAt: now, updatedAt: now });
    }
    const shell = new MockShellExecutor();
    const app = createServer({
      stateService, authStore: store, shell, worktreeService: new WorktreeService(shell, root),
      containerService: {} as Parameters<typeof createServer>[0]['containerService'],
      proxyService: {
        getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress: () => {},
      } as unknown as Parameters<typeof createServer>[0]['proxyService'],
      bridgeService: {} as Parameters<typeof createServer>[0]['bridgeService'],
      config: {
        repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900, workerPort: 5500,
        dockerNetwork: 'cds-test', portStart: 10001, sharedEnv: {}, jwt: { secret: 'fixture-only', issuer: 'fixture' },
        mode: 'standalone', executorPort: 9901, rootDomains: ['test.example.invalid'],
      },
    });
    server = listenLoopbackFixture(app);
    if (!server.address()) await once(server, 'listening');
    ownerCookie = await signIn(ownerName);
  });

  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await flushAllJsonStateStores();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('disables an ordinary member with zero active sessions immediately and records the completed action', async () => {
    const member = await createUser('fixture-offline-member', 'member');
    const owner = (await call<{ user: Account }>('GET', '/api/me', ownerCookie)).body.user;
    const impact = await call<{ affectedSessions: number }>('GET', `/api/auth/users/${member.id}/impact`, ownerCookie);
    expect(impact).toMatchObject({ status: 200, body: { affectedSessions: 0 } });

    const stopped = await submit('disable-user', member);
    expect(stopped).toMatchObject({
      action: 'disable-user', targetId: member.id, status: 'completed', affectedSessions: 0,
      requestedByAccountId: owner.id, executedByAccountId: owner.id,
    });
    const accounts = await call<{ users: Account[] }>('GET', '/api/auth/users', ownerCookie);
    expect(accounts.body.users.find(user => user.id === member.id)?.status).toBe('disabled');
    expect((await login(member.username)).status).toBe(401);
    expect(await audit(ownerCookie, { action: 'disable-user', targetId: member.id, status: 'completed' })).toEqual([
      expect.objectContaining({ id: stopped.id, status: 'completed', executedByAccountId: owner.id }),
    ]);
  });

  it('leaves an online ordinary member active until owner approval', async () => {
    const member = await createUser('fixture-online-member', 'member');
    const memberCookie = await signIn(member.username);
    const impact = await call<{ affectedSessions: number }>('GET', `/api/auth/users/${member.id}/impact`, ownerCookie);
    expect(impact).toMatchObject({ status: 200, body: { affectedSessions: 1 } });

    const requested = await submit('disable-user', member);
    expect(requested).toMatchObject({ status: 'pending', affectedSessions: 1 });
    expect((await call('GET', '/api/me', memberCookie)).status).toBe(200);
    expect(await audit(ownerCookie, { targetId: member.id, status: 'completed' })).toEqual([]);

    const confirmed = await confirm(requested, member);
    expect(confirmed).toMatchObject({ status: 200, body: { request: { id: requested.id, status: 'completed' } } });
    expect((await call('GET', '/api/me', memberCookie)).status).toBe(401);
    expect((await login(member.username)).status).toBe(401);
    expect(await audit(ownerCookie, { action: 'disable-user', targetId: member.id })).toEqual([
      expect.objectContaining({ id: requested.id, status: 'completed' }),
    ]);
  });

  it('still confirms a request when one of the approved devices already signed out', async () => {
    const member = await createUser('fixture-device-signed-out', 'member');
    const first = await signIn(member.username);
    const second = await signIn(member.username);
    const request = await submit('revoke-sessions', member);
    expect(request).toMatchObject({ status: 'pending', affectedSessions: 2 });
    expect(request).not.toHaveProperty('sessionSnapshot');
    expect((await call('POST', '/api/auth/logout', first)).status).toBe(200);

    expect(await confirm(request, member)).toMatchObject({ status: 200, body: { request: { id: request.id, status: 'completed' } } });
    expect((await call('GET', '/api/me', second)).status).toBe(401);
    const records = await audit(ownerCookie, { targetId: member.id, status: 'completed' });
    expect(records).toEqual([expect.objectContaining({ id: request.id })]);
    expect(records[0]).not.toHaveProperty('sessionSnapshot');
  });

  it('requires refreshed approval when a newly signed-in device replaced one from the request', async () => {
    const member = await createUser('fixture-device-replaced', 'member');
    const original = await signIn(member.username);
    const request = await submit('revoke-sessions', member);
    expect(request).toMatchObject({ status: 'pending', affectedSessions: 1 });
    expect((await call('POST', '/api/auth/logout', original)).status).toBe(200);
    const replacement = await signIn(member.username);

    expect((await confirm(request, member)).status).toBe(409);
    expect((await call('GET', '/api/me', replacement)).status).toBe(200);
    expect(await audit(ownerCookie, { targetId: member.id, status: 'completed' })).toEqual([]);
    const refreshed = await submit('revoke-sessions', member);
    expect(refreshed).toMatchObject({ status: 'pending', affectedSessions: 1 });
    expect(refreshed.id).not.toBe(request.id);
    expect((await confirm(refreshed, member)).status).toBe(200);
    expect((await call('GET', '/api/me', replacement)).status).toBe(401);
  });

  it('keeps an opted-in agent proposal pending even for a member without active sessions', async () => {
    const admin = await createUser('fixture-agent-sponsor', 'admin');
    const target = await createUser('fixture-agent-offline-target', 'member');
    for (const account of [admin, target]) {
      expect((await call('PUT', `/api/auth/users/${account.id}/projects`, ownerCookie, { projectIds: [projectA] })).status).toBe(200);
    }
    const ticket = await call<{ requestId: string; pollToken: string }>('POST', '/api/identity-connections', '', {
      repository: repositoryFor(projectA), projectId: projectA, agentName: 'Disable audit fixture', allowAccountProposals: true,
    });
    expect(ticket.status).toBe(201);
    const { requestId, pollToken } = ticket.body;
    expect((await call('POST', `/api/identity/connections/${requestId}/approve`, ownerCookie,
      { projectId: projectA, userId: admin.id, allowAccountProposals: true })).status).toBe(200);
    const credential = await call<{ status: string; userCredential: string }>('GET', `/api/identity-connections/${requestId}`, '', undefined,
      { 'X-Poll-Token': pollToken });
    expect(credential.status).toBe(200);
    expect(credential.body.status).toBe('approved');
    expect(Boolean(credential.body.userCredential)).toBe(true);

    const proposal = await call<{ request: RequestRecord }>('POST', '/api/auth/account-proposals', '',
      { action: 'disable-user', targetId: target.id, reason }, { 'X-AI-Access-Key': credential.body.userCredential });
    expect(proposal).toMatchObject({ status: 201, body: { request: {
      targetId: target.id, action: 'disable-user', affectedSessions: 0, requestedVia: 'agent', status: 'pending',
    } } });
    const users = await call<{ users: Account[] }>('GET', '/api/auth/users', ownerCookie);
    expect(users.body.users.find(user => user.id === target.id)?.status).toBe('active');
    expect(await audit(ownerCookie, { action: 'disable-user', targetId: target.id, status: 'completed' })).toEqual([]);
  });

  it('lists only audited ordinary members whose full project scope the administrator holds and preserves personal audit', async () => {
    const adminA = await createUser('fixture-team-admin-a', 'admin');
    const adminB = await createUser('fixture-team-admin-b', 'admin');
    const managed = await createUser('fixture-managed-member', 'member');
    const unrelated = await createUser('fixture-unrelated-member', 'member');
    const shared = await createUser('fixture-partially-managed-member', 'member');
    const grants = [
      { account: adminA, ids: [projectA, projectB] }, { account: adminB, ids: [projectB] },
      { account: managed, ids: [projectA] }, { account: unrelated, ids: [projectB] },
      { account: shared, ids: [projectA, projectB] },
    ];
    for (const { account, ids } of grants) {
      const grant = await call('PUT', `/api/auth/users/${account.id}/projects`, ownerCookie, { projectIds: ids });
      expect(grant.status).toBe(200);
    }
    const priorAdminCookie = await signIn(adminA.username);
    const audited = new Map<string, string>();
    for (const account of [managed, unrelated, shared, adminA, adminB]) {
      const request = await submit('revoke-sessions', account, account === unrelated ? priorAdminCookie : ownerCookie);
      expect((await confirm(request, account)).status).toBe(200);
      audited.set(account.id, request.id);
    }
    const narrowed = await call('PUT', `/api/auth/users/${adminA.id}/projects`, ownerCookie, { projectIds: [projectA] });
    expect(narrowed.status).toBe(200);
    const query = { action: 'revoke-sessions', status: 'completed' };
    expect((await audit(ownerCookie, query)).map(record => record.id)).toEqual(expect.arrayContaining([...audited.values()]));

    const adminCookie = await signIn(adminA.username);
    const records = await audit(adminCookie, query);
    expect(records.map(record => record.id).sort()).toEqual([audited.get(managed.id), audited.get(adminA.id)].sort());
    for (const account of [unrelated, shared, adminB]) {
      expect(await audit(adminCookie, { ...query, targetId: account.id })).toEqual([]);
    }
    const memberCookie = await signIn(managed.username);
    expect((await audit(memberCookie, query)).map(record => record.id)).toEqual([audited.get(managed.id)]);
    expect(await audit(memberCookie, { ...query, targetId: unrelated.id })).toEqual([]);
  });

  it('allows an administrator to grant their projects and enable their ordinary member while preserving the scope of other accounts', async () => {
    const admin = await createUser('fixture-grant-admin', 'admin');
    const peer = await createUser('fixture-grant-peer', 'admin');
    const outside = await createUser('fixture-restore-outside', 'member');
    const projectsPath = (target: Account) => `/api/auth/users/${target.id}/projects`;
    for (const [target, projectId] of [[admin, projectA], [peer, projectA], [outside, projectB]] as const) {
      expect((await call('PUT', projectsPath(target), ownerCookie, { projectIds: [projectId] })).status).toBe(200);
    }

    const adminCookie = await signIn(admin.username);
    const member = await createUser('fixture-restore-managed', 'member', adminCookie);
    const assigned = await call('PUT', projectsPath(member), adminCookie, { projectIds: [projectA] });
    expect(assigned).toMatchObject({ status: 200, body: { projects: [{ id: projectA, authorized: true }] } });
    expect(await call('GET', projectsPath(member), adminCookie))
      .toMatchObject({ status: 200, body: { projects: [{ id: projectA, authorized: true }] } });
    expect((await call('PUT', projectsPath(member), adminCookie, { projectIds: [projectA, projectB] })).status).toBe(403);
    expect((await call('PUT', projectsPath(peer), adminCookie, { projectIds: [] })).status).toBe(404);
    expect((await call('PUT', projectsPath(outside), adminCookie, { projectIds: [projectA] })).status).toBe(404);

    for (const [target, projectId] of [[member, projectA], [peer, projectA], [outside, projectB]] as const) {
      const grants = await call<{ projects: { id: string; authorized: boolean }[] }>('GET', projectsPath(target), ownerCookie);
      expect(grants.status).toBe(200);
      expect(grants.body.projects.filter(item => item.authorized).map(item => item.id)).toEqual([projectId]);
    }
    expect(await submit('disable-user', member, adminCookie)).toMatchObject({ status: 'completed', affectedSessions: 0 });
    expect(await submit('disable-user', outside)).toMatchObject({ status: 'completed', affectedSessions: 0 });

    expect(await call('PATCH', `/api/auth/users/${member.id}`, adminCookie, { status: 'active' }))
      .toMatchObject({ status: 200, body: { user: { id: member.id, status: 'active' } } });
    expect((await login(member.username)).status).toBe(200);
    for (const target of [outside, peer]) {
      expect((await call('PATCH', `/api/auth/users/${target.id}`, adminCookie, { status: 'active' })).status).toBe(403);
    }
    expect((await login(outside.username)).status).toBe(401);
  });
});
