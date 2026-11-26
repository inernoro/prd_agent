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
import type { HttpLogSink } from '../../src/services/http-log-store.js';
import { hashPassword } from '../../src/services/password.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const recoveryPath = '/api/auth/recovery-requests';
const activatePath = '/api/auth/invitations/activate';
const reason = 'Request account access back in the isolated test';
const evidence = 'Verified the original account holder through the fixture contact';
const initialPassword = 'Fixture-Recovery-Original-69!';
const recoveredPassword = 'Fixture-Recovery-Replacement-73!';
const replayPassword = 'Fixture-Recovery-Replay-81!';

interface RecoveryResponse {
  request: { id: string; status: string };
  invitation?: { path: string; expiresAt: string };
}

type RecoveryList = { requests: RecoveryResponse['request'][] };
type UserResponse = { user: Pick<CdsUser, 'id' | 'username'> };

describe('account recovery via the CDS server', () => {
  let root: string;
  let server: Server;
  let store: MemoryAuthStore;
  let member: CdsUser;
  let admin: CdsUser;
  let owner: CdsUser;
  let memberCookie: string;
  let adminCookie: string;
  let ownerCookie: string;
  let httpLogs: Parameters<HttpLogSink['record']>[0][];

  async function call<T>(endpoint: string, options: { cookie?: string; body?: unknown } = {}) {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture');
    const headers = new Headers({ Accept: 'application/json' });
    if (options.cookie) headers.set('Cookie', options.cookie);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    const raw = await response.text();
    return {
      status: response.status,
      cookies: response.headers.getSetCookie(),
      raw,
      json: () => JSON.parse(raw) as T,
    };
  }

  function login(username: string, password = initialPassword) {
    return call<UserResponse>('/api/auth/login', { body: { username, password } });
  }

  function activeCookie(setCookie: string[]): string {
    const cookie = setCookie.find(value => /^(?:__Host-)?cds_gh_session=/.test(value))?.split(';')[0];
    expect(Boolean(cookie), 'the browser received an authenticated session').toBe(true);
    return cookie!;
  }

  async function signIn(username: string) {
    const response = await login(username);
    expect(response.status).toBe(200);
    return activeCookie(response.cookies);
  }

  async function seedAccount(username: string, role: 'owner' | 'admin' | 'member') {
    const { hash, salt } = hashPassword(initialPassword);
    return store.createLocalUser({
      username, passwordHash: hash, passwordSalt: salt,
      isSystemOwner: role === 'owner', isAdministrator: role === 'admin',
    });
  }

  function submit(username: string) {
    return call<{ accepted: boolean }>(recoveryPath, { body: { username, reason } });
  }

  function inbox(cookie?: string) {
    return call<RecoveryList>(recoveryPath, { cookie });
  }

  async function waitForInbox(cookie: string, size: number) {
    return vi.waitFor(async () => {
      const response = await inbox(cookie);
      expect(response.status).toBe(200);
      const { requests } = response.json();
      expect(requests.length).toBe(size);
      return requests;
    }, { timeout: 1500, interval: 25 });
  }

  function verify(id: string, cookie?: string) {
    return call<RecoveryResponse>(`${recoveryPath}/${id}/verify`, { cookie, body: { evidence } });
  }

  function approve(id: string, targetName: string, cookie?: string) {
    return call<RecoveryResponse>(`${recoveryPath}/${id}/approve`, { cookie, body: { targetName } });
  }

  function me(cookie: string) {
    return call<UserResponse>('/api/me', { cookie });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cds-account-recovery-'));
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'fixture-environment-owner');
    vi.stubEnv('CDS_PASSWORD', 'Fixture-Environment-Recovery-14!');
    vi.stubEnv('CDS_BASIC_SESSION_GENERATION', undefined);
    vi.stubEnv('CDS_ENV_FILE', path.join(root, 'test.env'));
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://127.0.0.1');
    vi.stubEnv('CDS_SSO_ENABLED', 'false');
    vi.stubEnv('CDS_PASSKEYS_ENABLED', 'false');
    store = new MemoryAuthStore();
    httpLogs = [];
    const stateService = new StateService(path.join(root, 'state.json'));
    stateService.load();
    const shell = new MockShellExecutor();
    const app = createServer({
      stateService,
      authStore: store,
      httpLogStore: { record: entry => { httpLogs.push(entry); } },
      worktreeService: new WorktreeService(shell, root),
      containerService: {} as Parameters<typeof createServer>[0]['containerService'],
      proxyService: {
        setOnProxyLog: () => {},
        getProxyLog: () => [],
        handleSwitchFromExpress: () => {},
      } as unknown as Parameters<typeof createServer>[0]['proxyService'],
      bridgeService: {} as Parameters<typeof createServer>[0]['bridgeService'],
      shell,
      config: {
        repoRoot: root,
        worktreeBase: path.join(root, 'worktrees'),
        masterPort: 9900,
        workerPort: 5500,
        dockerNetwork: 'cds-test',
        portStart: 10001,
        sharedEnv: {},
        jwt: { secret: 'fixture-only', issuer: 'fixture' },
        mode: 'standalone',
        executorPort: 9901,
        rootDomains: ['test.example.invalid'],
      },
    });
    server = listenLoopbackFixture(app);
    if (!server.address()) await once(server, 'listening');

    owner = await seedAccount('fixture-recovery-owner', 'owner');
    admin = await seedAccount('fixture-recovery-admin', 'admin');
    member = await seedAccount('fixture-recovery-member', 'member');
    ownerCookie = await signIn(owner.username!);
    adminCookie = await signIn(admin.username!);
    memberCookie = await signIn(member.username!);
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('acknowledges existing and unknown usernames identically without exposing the queue', async () => {
    const unknownUsername = 'fixture-recovery-unknown';
    const knownResponse = await submit(member.username!);
    const unknownResponse = await submit(unknownUsername);
    for (const response of [knownResponse, unknownResponse]) {
      expect(response.status).toBe(202);
      expect(Object.keys(response.json())).toEqual(['accepted']);
      expect(response.json().accepted).toBe(true);
    }
    expect(knownResponse.raw === unknownResponse.raw, 'anonymous acknowledgements are identical').toBe(true);
    expect(await store.findUserByUsername(unknownUsername)).toBeNull();
    expect([401, 403]).toContain((await inbox()).status);
    expect((await inbox(memberCookie)).status).toBe(403);
  });

  it('scopes administrators to ordinary accounts and separates verification from approval', async () => {
    expect((await submit(member.username!)).status).toBe(202);
    const [first] = await waitForInbox(ownerCookie, 1);
    expect((await submit(admin.username!)).status).toBe(202);
    const ownerRequests = await waitForInbox(ownerCookie, 2);
    const privileged = ownerRequests.find(request => request.id !== first.id);
    expect(Boolean(privileged)).toBe(true);
    expect((await waitForInbox(adminCookie, 1)).map(request => request.id)).toEqual([first.id]);
    expect([403, 404]).toContain((await verify(privileged!.id, adminCookie)).status);
    expect([401, 403]).toContain((await approve(first.id, member.username!)).status);
    expect([400, 409]).toContain((await approve(first.id, member.username!, ownerCookie)).status);
    const genericApproval = await call<{ code: string }>(`/api/auth/account-actions/${first.id}/confirm`, {
      cookie: ownerCookie, body: { targetName: member.username },
    });
    expect(genericApproval.status).toBe(409);
    expect(genericApproval.json().code).toBe('specific_confirmation_required');
    expect((await verify(first.id, memberCookie)).status).toBe(403);

    const verified = await verify(first.id, ownerCookie);
    expect(verified.status).toBe(200);
    expect(verified.json().request.status).toBe('verified');
    expect((await approve(first.id, member.username!, adminCookie)).status).toBe(403);
    const selfApproved = await approve(first.id, member.username!, ownerCookie);
    expect([403, 409]).toContain(selfApproved.status);
    expect(Object.keys(selfApproved.json()).includes('invitation')).toBe(false);
    expect((await me(memberCookie)).status).toBe(200);
  });

  it('issues a single-use private invitation and restores the original account with fresh credentials', async () => {
    expect((await submit(member.username!)).status).toBe(202);
    const [pending] = await waitForInbox(ownerCookie, 1);
    const verified = await verify(pending.id, adminCookie);
    expect(verified.status).toBe(200);
    expect(verified.json().request.status).toBe('verified');
    expect([400, 409]).toContain((await approve(pending.id, 'fixture-other-account', ownerCookie)).status);

    const approved = await approve(pending.id, member.username!, ownerCookie);
    expect(approved.status).toBe(200);
    const approval = approved.json();
    expect(approval.request.id).toBe(pending.id);
    expect(Boolean(approval.invitation), 'a single invitation is issued on approval').toBe(true);
    expect(Date.parse(approval.invitation!.expiresAt)).toBeGreaterThan(Date.now());
    const destination = new URL(approval.invitation!.path, 'http://127.0.0.1');
    expect(destination.origin).toBe('http://127.0.0.1');
    expect(destination.pathname).toBe('/login');
    const token = new URLSearchParams(destination.hash.slice(1)).get('invite');
    expect(Boolean(token), 'invitation is carried in the login fragment').toBe(true);

    const receipt = await store.accountActions?.get(pending.id);
    expect({
      status: receipt?.status,
      targetId: receipt?.targetId,
      verifierId: receipt?.verification?.byAccountId,
      evidence: receipt?.verification?.evidence,
      approverId: receipt?.approvedByAccountId,
    }).toEqual({
      status: 'completed', targetId: member.id, verifierId: admin.id, evidence, approverId: owner.id,
    });
    const accountBeforeActivation = await store.findUserById(member.id);
    expect(Boolean(accountBeforeActivation?.invitationHash), 'account stores an invitation hash').toBe(true);
    expect(JSON.stringify({ receipt, account: accountBeforeActivation }).includes(token!), 'the stored records contain no invitation plaintext').toBe(false);

    const repeatedApproval = await approve(pending.id, member.username!, ownerCookie);
    expect([200, 409]).toContain(repeatedApproval.status);
    expect(Object.keys(repeatedApproval.json()).includes('invitation')).toBe(false);
    const list = await inbox(ownerCookie);
    expect(list.status).toBe(200);
    expect(list.raw.includes(token!), 'the review list contains no invitation plaintext').toBe(false);

    const activated = await call<UserResponse>(activatePath, { body: { invitation: token, password: recoveredPassword } });
    expect(activated.status).toBe(200);
    expect(activated.json().user.id).toBe(member.id);
    expect((await me(activeCookie(activated.cookies))).status).toBe(200);
    expect((await me(memberCookie)).status).toBe(401);
    const signInNotice = await call<{ notice: { action: string } | null }>('/api/auth/sign-in-notice', { cookie: memberCookie });
    expect(signInNotice.status).toBe(200);
    expect(signInNotice.json().notice?.action).toBe('recover-identity');
    expect((await login(member.username!)).status).toBe(401);
    const fresh = await login(member.username!, recoveredPassword);
    expect(fresh.status).toBe(200);
    expect(fresh.json().user.id).toBe(member.id);

    const replay = await call<UserResponse>(activatePath, { body: { invitation: token, password: replayPassword } });
    expect([400, 409]).toContain(replay.status);
    expect((await login(member.username!, replayPassword)).status).toBe(401);
    const logs = JSON.stringify(httpLogs);
    expect(logs.includes(token!), 'the recovery invitation is absent from HTTP logs').toBe(false);
    for (const password of [initialPassword, recoveredPassword, replayPassword]) {
      expect(logs.includes(password), 'the local password is absent from HTTP logs').toBe(false);
    }
  });
});
