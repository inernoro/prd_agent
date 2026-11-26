import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdsUser } from '../../src/domain/auth.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createServer } from '../../src/server.js';
import { humanPrincipalId } from '../../src/services/human-project-access.js';
import { hashPassword } from '../../src/services/password.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { UserCredential } from '../../src/types.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const proposalPath = '/api/auth/account-proposals';
const accountActionsPath = '/api/auth/account-actions';
const passphrase = 'independent-loopback-fixture-59+';
const projectA = 'proposal-fixture-a';
const projectB = 'proposal-fixture-b';
const repositoryA = 'https://git.example.invalid/fixture/account-proposal-a.git';
const repositoryB = 'https://git.example.invalid/fixture/account-proposal-b.git';
const proposalActions = ['reset-password', 'disable-user', 'revoke-sessions'] as const;
type ProposalAction = typeof proposalActions[number];
type Auth = { cookie: string } | { key: string };

interface ProposalReceipt {
  request: {
    id: string;
    action: ProposalAction;
    targetId: string;
    status: string;
  };
}

interface ProposalCredential extends UserCredential {
  accountProposals?: boolean;
}

describe('CDS machine account proposals through the real server', () => {
  let server: Server;
  let root: string;
  let origin: string;
  let store: MemoryAuthStore;
  let state: StateService;
  let owner: CdsUser;
  let admin: CdsUser;
  let member: CdsUser;
  let outsider: CdsUser;
  let ownerSession: Auth;
  let adminGrant: string;
  let memberGrant: string;

  async function call<T = unknown>(
    method: string, route: string, auth?: Auth, body?: unknown, extraHeaders: Record<string, string> = {},
  ) {
    const response = await fetch(origin + route, {
      method,
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        ...(auth && 'cookie' in auth ? { Cookie: auth.cookie } : {}),
        ...(auth && 'key' in auth ? { 'X-AI-Access-Key': auth.key } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    return {
      status: response.status,
      cache: response.headers.get('cache-control') ?? '',
      cookies: response.headers.getSetCookie(),
      body: () => JSON.parse(raw) as T,
    };
  }

  async function login(user: CdsUser): Promise<Auth> {
    const response = await call('POST', '/api/auth/login', undefined, { username: user.username, password: passphrase });
    expect(response.status).toBe(200);
    const cookie = response.cookies.find(value => /^(?:__Host-)?cds_gh_session=/.test(value))?.split(';')[0];
    expect(Boolean(cookie)).toBe(true);
    return { cookie: cookie! };
  }

  function addPrincipal(user: CdsUser): string {
    const id = humanPrincipalId(user.id);
    if (!state.getPrincipal(id)) {
      state.addPrincipal({ id, name: user.username!, kind: 'human', status: 'active', createdAt: new Date().toISOString() });
    }
    return id;
  }

  function grant(user: CdsUser, projectId: string) {
    const principalId = addPrincipal(user);
    const id = `pg_${randomBytes(6).toString('hex')}`;
    state.addProjectGrant({ id, principalId, projectId, origin: 'approved', grantedAt: new Date().toISOString() });
    return id;
  }

  function credential(principalId: string, settings: Partial<ProposalCredential> = {}): Auth {
    const key = `cdsu_${randomBytes(24).toString('base64url')}`;
    const record: ProposalCredential = {
      id: `uc_${randomBytes(6).toString('hex')}`,
      principalId,
      hash: createHash('sha256').update(key).digest('hex'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
      issuedByAccountId: owner.id,
      accountProposals: true,
      projectIds: [projectA],
      ...settings,
    };
    state.addUserCredential(record);
    return { key };
  }

  function submit(auth: Auth, targetId: string, action: ProposalAction = 'revoke-sessions') {
    return call<ProposalReceipt>('POST', proposalPath, auth, {
      action,
      targetId,
      reason: 'Review session access in the isolated account fixture.',
    });
  }

  async function openConnection() {
    const created = await call<{ requestId: string; pollToken: string }>(
      'POST', '/api/identity-connections', undefined,
      { repository: repositoryA, projectId: projectA, agentName: 'Loopback proposal fixture', allowAccountProposals: true },
    );
    expect(created.status).toBe(201);
    return created.body();
  }

  async function deliverConnection(ticket: { requestId: string; pollToken: string }) {
    const received = await call<{ status: string; userCredential: string; authorizationKey: string; projectId: string }>(
      'GET', `/api/identity-connections/${ticket.requestId}`, undefined, undefined, { 'X-Poll-Token': ticket.pollToken },
    );
    expect(received.status).toBe(200);
    const delivery = received.body();
    expect(delivery.status).toBe('approved');
    expect(delivery.projectId).toBe(projectA);
    expect(delivery.userCredential.startsWith('cdsu_')).toBe(true);
    expect(delivery.authorizationKey.startsWith('cdsp_')).toBe(true);
    return { user: { key: delivery.userCredential }, project: { key: delivery.authorizationKey } };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cds-account-proposals-'));
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'proposal-fixture-bootstrap');
    vi.stubEnv('CDS_PASSWORD', 'proposal-bootstrap-isolated-73+');
    vi.stubEnv('CDS_ENV_FILE', path.join(root, 'test.env'));
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://127.0.0.1');
    vi.stubEnv('CDS_SSO_ENABLED', 'false');
    vi.stubEnv('CDS_PASSKEYS_ENABLED', 'false');
    vi.stubEnv('CDS_UPSTREAM', '');
    vi.stubEnv('AI_ACCESS_KEY', '');
    vi.stubEnv('CDS_AI_ACCESS_KEY', '');
    const localFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
        throw new Error('Account proposal fixtures only use loopback HTTP');
      }
      return localFetch(input, init);
    });

    store = new MemoryAuthStore();
    state = new StateService(path.join(root, 'state.json'), root);
    state.load();
    for (const [id, gitRepoUrl] of [[projectA, repositoryA], [projectB, repositoryB]]) {
      const now = new Date().toISOString();
      state.addProject({ id, slug: id, name: id, kind: 'git', dockerNetwork: id, repoPath: root,
        gitRepoUrl, createdAt: now, updatedAt: now });
    }
    const { hash, salt } = hashPassword(passphrase);
    const seed = (username: string, privileges: { isSystemOwner?: boolean; isAdministrator?: boolean } = {}) =>
      store.createLocalUser({ username, passwordHash: hash, passwordSalt: salt, ...privileges });
    owner = await seed('proposal-fixture-owner', { isSystemOwner: true });
    admin = await seed('proposal-fixture-admin', { isAdministrator: true });
    member = await seed('proposal-fixture-member');
    outsider = await seed('proposal-fixture-outside-member');
    adminGrant = grant(admin, projectA);
    grant(admin, projectB);
    memberGrant = grant(member, projectA);
    grant(outsider, projectB);

    const shell = new MockShellExecutor();
    const app = createServer({
      stateService: state,
      authStore: store,
      worktreeService: new WorktreeService(shell, root),
      containerService: {} as Parameters<typeof createServer>[0]['containerService'],
      proxyService: {
        getProxyLog: () => [],
        setOnProxyLog: () => {},
        handleSwitchFromExpress: () => {},
      } as unknown as Parameters<typeof createServer>[0]['proxyService'],
      bridgeService: {} as Parameters<typeof createServer>[0]['bridgeService'],
      shell,
      config: {
        repoRoot: root,
        worktreeBase: path.join(root, 'worktrees'),
        masterPort: 9900,
        workerPort: 5500,
        dockerNetwork: 'cds-proposal-fixture',
        portStart: 10001,
        sharedEnv: {},
        jwt: { secret: 'proposal-fixture-only', issuer: 'fixture' },
        mode: 'standalone',
        executorPort: 9901,
        rootDomains: ['test.example.invalid'],
      },
    });
    server = listenLoopbackFixture(app);
    if (!server.address()) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture');
    origin = `http://127.0.0.1:${address.port}`;
    ownerSession = await login(owner);
  });

  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await flushAllJsonStateStores();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('creates a pending proposal through a scoped, opted-in credential of a live administrator', async () => {
    const machine = credential(addPrincipal(admin));
    const whoami = await call('GET', '/api/identity/whoami', machine);
    expect(whoami.status, 'the seeded key passes genuine user credential authentication').toBe(200);

    const response = await submit(machine, member.id);
    expect(response.status, 'the dedicated route accepts an eligible machine proposal').toBe(201);
    const { request } = response.body();
    expect(request).toMatchObject({ id: expect.any(String), action: 'revoke-sessions', targetId: member.id, status: 'pending' });
    const read = await call<ProposalReceipt>('GET', `${proposalPath}/${request.id}`, machine);
    expect(read.status).toBe(200);
    expect(read.body().request).toMatchObject({ id: request.id, status: 'pending' });
  });

  it('uses one narrow intake for the three ordinary-member actions while leaving accounts and sessions untouched', async () => {
    const machine = credential(addPrincipal(admin));
    const memberSession = await login(member);
    const initial = await store.findUserById(member.id);
    for (const action of proposalActions) {
      const response = await submit(machine, member.id, action);
      expect(response.status, action).toBe(201);
      expect(response.cache).toContain('no-store');
      expect(response.body().request).toMatchObject({
        action, targetId: member.id, status: 'pending', requestedVia: 'agent', requestedByAccountId: admin.id,
      });
      expect(response.body().request).not.toHaveProperty('proposalCredentialId');
      expect(response.body().request).not.toHaveProperty('targetRevision');
    }
    const forbiddenAction = await call('POST', proposalPath, machine, {
      action: 'revoke-admin', targetId: member.id, reason: 'Approval-only action is outside machine intake.',
    });
    expect(forbiddenAction.status).toBe(400);
    const unexpectedPassword = await call('POST', proposalPath, machine, {
      action: 'reset-password', targetId: member.id, reason: 'Credentials can only be supplied by the confirming owner.',
      newPassword: 'synthetic-vetoed-replacement-83+',
    });
    expect(unexpectedPassword.status).toBe(400);
    expect((await call('GET', '/api/me', memberSession)).status).toBe(200);
    const latest = await store.findUserById(member.id);
    expect(latest?.status).toBe('active');
    expect(latest?.passwordHash === initial?.passwordHash).toBe(true);
    expect(latest?.sessionRevision === initial?.sessionRevision).toBe(true);
  });

  it('binds receipts to the originating credential and requires a verified owner to confirm', async () => {
    const principalId = addPrincipal(admin);
    const machine = credential(principalId);
    const otherDevice = credential(principalId);
    const memberSession = await login(member);
    const adminSession = await login(admin);
    const started = await submit(machine, member.id);
    expect(started.status).toBe(201);
    const id = started.body().request.id;
    expect((await submit(machine, member.id)).body().request.id).toBe(id);
    const readRoute = `${proposalPath}/${id}`;
    expect([401, 403, 404]).toContain((await call('GET', readRoute, otherDevice)).status);
    expect((await call<ProposalReceipt>('GET', readRoute, machine)).body().request.status).toBe('pending');
    const input = { targetName: member.username };
    const confirm = `${accountActionsPath}/${id}/confirm`;
    expect([401, 403]).toContain((await call('POST', accountActionsPath, machine, {
      action: 'revoke-sessions', targetId: member.id, reason: 'Machine keys must use proposal intake.',
    })).status);
    expect([401, 403]).toContain((await call('POST', confirm, machine, input)).status);
    expect((await call('POST', confirm, adminSession, input)).status).toBe(403);
    expect((await call('POST', confirm, ownerSession, { targetName: outsider.username })).status).toBe(400);
    expect((await call('GET', '/api/me', memberSession)).status).toBe(200);
    const ownerQueue = await call<{ requests: Array<{ id: string }> }>('GET', accountActionsPath, ownerSession);
    expect(ownerQueue.status).toBe(200);
    expect(ownerQueue.body().requests.map(request => request.id)).toEqual([id]);
    const approved = await call<ProposalReceipt>('POST', confirm, ownerSession, input);
    expect(approved.status).toBe(200);
    expect(approved.body().request).toMatchObject({ id, status: 'completed', approvedByAccountId: owner.id });
    expect((await call('GET', '/api/me', memberSession)).status).toBe(401);
    expect((await call('GET', '/api/me', ownerSession)).status).toBe(200);
    const completed = await call<ProposalReceipt>('GET', readRoute, machine);
    expect(completed.status).toBe(200);
    expect(completed.body().request).toMatchObject({ id, status: 'completed' });
  });

  it('refuses keys without explicit opt-in, project scope, or a currently active linked administrator', async () => {
    const principalId = addPrincipal(admin);
    grant(owner, projectA);
    const agentPrincipal = `pr_${randomBytes(6).toString('hex')}`;
    state.addPrincipal({ id: agentPrincipal, name: 'Fixture agent', kind: 'agent', status: 'active', createdAt: new Date().toISOString() });
    const candidates: Record<string, Auth> = {
      'missing flag': credential(principalId, { accountProposals: undefined }),
      'false flag': credential(principalId, { accountProposals: false }),
      'unbounded key': credential(principalId, { projectIds: undefined }),
      'empty project list': credential(principalId, { projectIds: [] }),
      'ordinary member principal': credential(addPrincipal(member)),
      'system owner principal': credential(addPrincipal(owner)),
      'unlinked agent principal': credential(agentPrincipal),
      'expired key': credential(principalId, { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    };
    for (const [name, auth] of Object.entries(candidates)) {
      const denied = await submit(auth, member.id);
      expect([401, 403], name).toContain(denied.status);
    }
    const key = credential(principalId);
    expect((await submit(key, member.id)).status).toBe(201);
    await store.setUserAdministrator(admin.id, false);
    expect((await submit(key, member.id)).status).toBe(403);
    await store.setUserAdministrator(admin.id, true);
    await store.setUserStatus(admin.id, 'disabled');
    expect((await submit(key, member.id)).status).toBe(403);
  });

  it('checks the live intersection and refuses privileged targets even when grants overlap', async () => {
    const machine = credential(addPrincipal(admin));
    grant(owner, projectA);
    expect((await submit(machine, admin.id)).status).toBe(403);
    expect((await submit(machine, owner.id)).status).toBe(403);
    expect((await submit(machine, outsider.id)).status).toBe(403);
    await store.setUserAdministrator(member.id, true);
    expect((await submit(machine, member.id)).status).toBe(403);
    await store.setUserAdministrator(member.id, false);

    const otherScope = credential(addPrincipal(admin), { projectIds: [projectB] });
    expect((await submit(otherScope, outsider.id)).status).toBe(201);
    state.revokeProjectGrant(memberGrant, owner.id);
    expect((await submit(machine, member.id)).status).toBe(403);
    grant(member, projectA);
    state.revokeProjectGrant(adminGrant, owner.id);
    expect((await submit(machine, member.id)).status).toBe(403);
    expect((await submit(otherScope, outsider.id)).status).toBe(201);
  });

  it('requires a genuine owner opt-in during device approval before a delivered scoped key can propose', async () => {
    const approval = { projectId: projectA, userId: admin.id, allowAccountProposals: true };
    const adminSession = await login(admin);
    const defaultTicket = await openConnection();
    const defaultPath = `/api/identity/connections/${defaultTicket.requestId}/approve`;
    expect((await call('POST', defaultPath, adminSession, approval)).status).toBe(403);
    expect((await call('POST', defaultPath, ownerSession, { projectId: projectA, userId: admin.id })).status).toBe(200);
    const defaultCredentials = await deliverConnection(defaultTicket);
    expect((await call('GET', '/api/identity/whoami', defaultCredentials.user)).status).toBe(200);
    expect((await submit(defaultCredentials.user, member.id)).status).toBe(403);

    const memberTicket = await openConnection();
    const memberPath = `/api/identity/connections/${memberTicket.requestId}/approve`;
    expect((await call('POST', memberPath, ownerSession, { ...approval, userId: member.id })).status).toBe(400);

    const approvedTicket = await openConnection();
    const approvedPath = `/api/identity/connections/${approvedTicket.requestId}/approve`;
    expect((await call('POST', approvedPath, ownerSession, approval)).status).toBe(200);
    const credentials = await deliverConnection(approvedTicket);
    const entry = state.findUserCredentialByPlaintext(credentials.user.key);
    expect(entry).toMatchObject({ principalId: humanPrincipalId(admin.id), projectIds: [projectA],
      accountProposals: true, issuedByAccountId: owner.id });
    expect((await submit(credentials.user, member.id)).status).toBe(201);
    expect((await submit(credentials.user, outsider.id)).status).toBe(403);
    expect([401, 403]).toContain((await submit(credentials.project, member.id)).status);
  });
});
