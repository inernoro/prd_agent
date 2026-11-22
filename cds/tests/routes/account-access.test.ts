import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createServer } from '../../src/server.js';
import type { HttpLogSink } from '../../src/services/http-log-store.js';
import { hashPassword } from '../../src/services/password.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const usersPath = '/api/auth/users';
const actionsPath = '/api/auth/account-actions';
const noticePath = '/api/auth/sign-in-notice';
const memberPassword = 'fixture-member-29+';
const adminPassword = 'fixture-admin-47+';
const replacementPassword = 'fixture-replacement-91+';

interface Account {
  id: string;
  username: string;
  role: 'owner' | 'admin' | 'member';
}

interface AccountResponse {
  user: Account;
  users: Account[];
  code?: string;
}

type AccountAction = 'reset-password' | 'disable-user' | 'revoke-sessions' | 'revoke-admin';

interface ActionRequest {
  id: string;
  status: string;
  affectedSessions: number;
}

interface ActionResponse {
  request: ActionRequest;
  requests: ActionRequest[];
}

interface NoticeResponse {
  notice: { action: AccountAction; at: string; receiptId?: string } | null;
}

describe('account access via the CDS server', () => {
  let server: Server;
  let root: string;
  let store: MemoryAuthStore;
  let httpLogs: Parameters<HttpLogSink['record']>[0][];
  let oldOwner: Account;
  let member: Account;
  let ownerCookie: string;
  let memberCookie: string;

  async function call<T = AccountResponse>(method: string, endpoint: string, cookie?: string, body?: unknown) {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Missing loopback fixture');
    const response = await fetch(`http://127.0.0.1:${addr.port}${endpoint}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return {
      status: response.status,
      cookies: response.headers.getSetCookie(),
      raw,
      json: () => JSON.parse(raw) as T,
    };
  }

  function login(username: string, password: string) {
    return call('POST', '/api/auth/login', undefined, { username, password });
  }

  async function expectNoNotice(cookie?: string, endpoint = noticePath) {
    const response = await call<NoticeResponse>('GET', endpoint, cookie);
    expect(response.status).toBe(200);
    expect(response.json().notice === null).toBe(true);
  }

  async function signIn(username: string, password: string): Promise<string> {
    const response = await login(username, password);
    expect(response.status).toBe(200);
    const cookie = response.cookies.find(value => /^(?:__Host-)?cds_gh_session=/.test(value))?.split(';')[0];
    expect(Boolean(cookie), 'authenticated browser cookie issued').toBe(true);
    return cookie!;
  }

  async function seedLegacyAccount(username: string, password: string, isSystemOwner = false): Promise<Account> {
    const { hash, salt } = hashPassword(password);
    const user = await store.createLocalUser({ username, passwordHash: hash, passwordSalt: salt, isSystemOwner });
    return { id: user.id, username, role: isSystemOwner ? 'owner' : 'member' };
  }

  async function createAdmin(username = 'fixture-admin'): Promise<Account> {
    const response = await call('POST', usersPath, ownerCookie, { username, password: adminPassword, role: 'admin' });
    expect(response.status).toBe(201);
    return response.json().user;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cds-account-access-'));
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'fixture-environment-owner');
    vi.stubEnv('CDS_PASSWORD', 'fixture-environment-83+');
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

    const ownerPassword = 'fixture-owner-61+';
    oldOwner = await seedLegacyAccount('fixture-local-owner', ownerPassword, true);
    member = await seedLegacyAccount('fixture-existing-member', memberPassword);
    ownerCookie = await signIn(oldOwner.username, ownerPassword);
    memberCookie = await signIn(member.username, memberPassword);
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await flushAllJsonStateStores();
    vi.unstubAllEnvs();
    if (root) await rm(root, { force: true, recursive: true });
  });

  describe('account roles', () => {
    it('lets an owner create an admin and maps the roles of older accounts in the user list', async () => {
      const denied = await call('POST', usersPath, memberCookie, {
        username: 'fixture-unprivileged-create',
        password: adminPassword,
        role: 'admin',
      });
      expect(denied.status).toBe(403);
      const admin = await createAdmin();
      expect(admin.role).toBe('admin');
      const list = await call('GET', usersPath, ownerCookie);
      expect(list.status).toBe(200);
      expect(Object.fromEntries(list.json().users.map(user => [user.id, user.role]))).toEqual({
        [oldOwner.id]: 'owner',
        [member.id]: 'member',
        [admin.id]: 'admin',
      });
    });

    it('lets an admin add a member, limits admin listings, and denies creating privileged peers', async () => {
      const admin = await createAdmin();
      await createAdmin('fixture-peer-admin');
      const cookie = await signIn(admin.username, adminPassword);
      const created = await call('POST', usersPath, cookie, {
        username: 'fixture-new-member',
        password: memberPassword,
        role: 'member',
      });
      expect(created.status).toBe(201);
      expect(created.json().user.role).toBe('member');
      const list = await call('GET', usersPath, cookie);
      expect(list.status).toBe(200);
      expect(list.json().users.map(user => user.id).sort()).toEqual(
        [admin.id, member.id, created.json().user.id].sort(),
      );
      for (const privilege of [{ role: 'admin' }, { role: 'owner' }, { isSystemOwner: true }]) {
        const denied = await call('POST', usersPath, cookie, {
          username: 'fixture-admin-privileged-create',
          password: adminPassword,
          ...privilege,
        });
        expect(denied.status).toBe(403);
      }
      expect((await call('GET', usersPath, memberCookie)).status).toBe(403);
    });

    it('lets only an owner grant admin and applies the new permission to the existing browser session', async () => {
      const admin = await createAdmin();
      const adminCookie = await signIn(admin.username, adminPassword);
      const accountPath = `${usersPath}/${member.id}`;
      for (const cookie of [memberCookie, adminCookie]) {
        expect((await call('PATCH', accountPath, cookie, { role: 'admin' })).status).toBe(403);
      }
      const granted = await call('PATCH', accountPath, ownerCookie, { role: 'admin' });
      expect(granted.status).toBe(200);
      expect(granted.json().user.role).toBe('admin');
      expect((await call('GET', usersPath, memberCookie)).status).toBe(200);
    });

    it.each([
      { name: 'password resets', patch: { newPassword: replacementPassword }, admin: false },
      { name: 'account disables', patch: { status: 'disabled' }, admin: false },
      { name: 'admin revocations', patch: { role: 'member' }, admin: true },
    ])('requires an account action for direct $name', async ({ patch, admin }) => {
      const target = admin ? await createAdmin() : member;
      const result = await call('PATCH', `${usersPath}/${target.id}`, ownerCookie, patch);
      expect(result.status).toBe(409);
      expect(result.json().code).toBe('account_action_required');
      const loginResult = await login(target.username, admin ? adminPassword : memberPassword);
      expect(loginResult.status).toBe(200);
      expect(loginResult.json().user.role).toBe(admin ? 'admin' : 'member');
    });
  });

  describe('account action approvals', () => {
    const reason = 'Synthetic account control requested for the fixture';

    function submit(action: AccountAction, targetId: string, cookie = ownerCookie) {
      return call<ActionResponse>('POST', actionsPath, cookie, { action, targetId, reason });
    }

    function confirm(requestId: string, targetName: string, cookie = ownerCookie, newPassword?: string) {
      return call<ActionResponse>('POST', `${actionsPath}/${requestId}/confirm`, cookie, {
        targetName,
        ...(newPassword === undefined ? {} : { newPassword }),
      });
    }

    async function submitRequest(action: AccountAction, targetId: string, cookie = ownerCookie): Promise<ActionRequest> {
      const response = await submit(action, targetId, cookie);
      expect(response.status).toBe(201);
      const request = response.json().request;
      expect(typeof request.id === 'string' && request.id.length > 0).toBe(true);
      return request;
    }

    function me(cookie: string) {
      return call('GET', '/api/me', cookie);
    }

    it('resets a password only after owner confirmation and preserves the result on replay', async () => {
      const secondSession = await signIn(member.username, memberPassword);
      const request = await submitRequest('reset-password', member.id);
      expect(request.affectedSessions).toBe(2);
      const submittedAgain = await submit('reset-password', member.id);
      expect([200, 201]).toContain(submittedAgain.status);
      expect(submittedAgain.json().request.id).toBe(request.id);
      const before = await call<ActionResponse>('GET', actionsPath, ownerCookie);
      expect(before.status).toBe(200);
      expect(before.json().requests.map(item => item.id)).toEqual([request.id]);

      expect((await confirm(request.id, member.username, memberCookie, replacementPassword)).status).toBe(403);
      const wrongAccount = await confirm(request.id, 'fixture-different-username', ownerCookie, replacementPassword);
      expect(wrongAccount.status).toBeGreaterThanOrEqual(400);
      expect(wrongAccount.status).toBeLessThan(500);
      expect((await me(memberCookie)).status).toBe(200);
      expect((await me(secondSession)).status).toBe(200);

      const completed = await confirm(request.id, member.username, ownerCookie, replacementPassword);
      expect(completed.status).toBe(200);
      expect(completed.json().request).toMatchObject({ id: request.id, status: 'completed' });
      expect((await login(member.username, memberPassword)).status).toBe(401);
      expect((await me(memberCookie)).status).toBe(401);
      expect((await me(secondSession)).status).toBe(401);

      const activeAfterReset = await signIn(member.username, replacementPassword);
      const notice = await call<NoticeResponse>('GET', noticePath, memberCookie);
      expect(notice.status).toBe(200);
      const noticeBody = notice.json();
      expect(Object.keys(noticeBody)).toEqual(['notice']);
      expect(Object.keys(noticeBody.notice ?? {}).sort()).toEqual(['action', 'at', 'receiptId']);
      expect(noticeBody.notice?.action).toBe('reset-password');
      expect(noticeBody.notice?.receiptId).toBe(request.id);
      expect(typeof noticeBody.notice?.at === 'string' && Number.isFinite(Date.parse(noticeBody.notice.at))).toBe(true);
      await expectNoNotice(activeAfterReset);
      await expectNoNotice(undefined, `${noticePath}?targetId=${member.id}`);
      const hashAfterReset = (await store.findUserById(member.id))?.passwordHash;
      const replay = await confirm(request.id, member.username, ownerCookie, replacementPassword);
      expect(replay.status).toBe(200);
      expect(replay.json().request).toMatchObject({ id: request.id, status: 'completed' });
      const changedPassword = 'fixture-different-replacement-73+';
      const changedReplay = await confirm(request.id, member.username, ownerCookie, changedPassword);
      expect([200, 409]).toContain(changedReplay.status);
      expect((await store.findUserById(member.id))?.passwordHash === hashAfterReset, 'replay leaves the password hash intact').toBe(true);
      expect((await me(activeAfterReset)).status).toBe(200);
      expect((await login(member.username, changedPassword)).status).toBe(401);

      const after = await call<ActionResponse>('GET', actionsPath, ownerCookie);
      expect(after.status).toBe(200);
      expect(after.json().requests).toMatchObject([{ id: request.id, status: 'completed' }]);

      await flushAllJsonStateStores();
      const persistedEntries = await readdir(root, { withFileTypes: true, recursive: true });
      const persistedData = await Promise.all(
        persistedEntries.filter(entry => entry.isFile()).map(entry => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
      );
      const storedReceipt = await store.accountActions?.get(request.id);
      expect({
        id: storedReceipt?.id,
        targetId: storedReceipt?.targetId,
        status: storedReceipt?.status,
        reason: storedReceipt?.reason,
        requestedBy: storedReceipt?.requestedByAccountId,
        approvedBy: storedReceipt?.approvedByAccountId,
        executedBy: storedReceipt?.executedByAccountId,
      }).toEqual({
        id: request.id,
        targetId: member.id,
        status: 'completed',
        reason,
        requestedBy: oldOwner.id,
        approvedBy: oldOwner.id,
        executedBy: oldOwner.id,
      });
      const activities = await store.listActivity();
      expect(activities.filter(entry =>
        entry.action === 'reset-password' && entry.targetId === member.id
        && entry.userId === oldOwner.id && entry.summary.includes(request.id),
      )).toHaveLength(1);
      const authData = JSON.stringify({ accounts: await store.listUsers(), activities, storedReceipt });
      const evidence = [completed.raw, replay.raw, changedReplay.raw, after.raw, authData, JSON.stringify(httpLogs), ...persistedData];
      for (const plaintext of [memberPassword, replacementPassword, changedPassword]) {
        expect(evidence.some(value => value.includes(plaintext)), 'credential absent from receipts and persisted data').toBe(false);
      }
    });

    it('lets an admin request an action against a member while reserving confirmation for the owner', async () => {
      const admin = await createAdmin();
      const peer = await createAdmin('fixture-peer-admin');
      const cookie = await signIn(admin.username, adminPassword);
      const request = await submitRequest('disable-user', member.id, cookie);
      for (const targetId of [oldOwner.id, peer.id, admin.id]) {
        expect((await submit('disable-user', targetId, cookie)).status).toBe(403);
      }
      expect((await submit('revoke-sessions', oldOwner.id, memberCookie)).status).toBe(403);
      expect((await confirm(request.id, member.username, cookie)).status).toBe(403);
      expect((await me(memberCookie)).status).toBe(200);

      const completed = await confirm(request.id, member.username);
      expect(completed.status).toBe(200);
      expect(completed.json().request).toMatchObject({ id: request.id, status: 'completed' });
      expect((await me(memberCookie)).status).toBe(401);
      expect((await login(member.username, memberPassword)).status).toBe(401);
      expect((await me(cookie)).status).toBe(200);
    });

    it('revokes all sessions of the confirmed account and keeps the owner session usable', async () => {
      const secondSession = await signIn(member.username, memberPassword);
      const request = await submitRequest('revoke-sessions', member.id);
      for (const cookie of [memberCookie, secondSession]) expect((await me(cookie)).status).toBe(200);
      const completed = await confirm(request.id, member.username);
      expect(completed.status).toBe(200);
      expect(completed.json().request).toMatchObject({ id: request.id, status: 'completed' });
      for (const cookie of [memberCookie, secondSession]) expect((await me(cookie)).status).toBe(401);
      expect((await me(ownerCookie)).status).toBe(200);
      expect((await login(member.username, memberPassword)).status).toBe(200);
    });

    it('requires another confirmation when an additional session changes the approved impact', async () => {
      const request = await submitRequest('revoke-sessions', member.id);
      expect(request.affectedSessions).toBe(1);
      const newSession = await signIn(member.username, memberPassword);
      const blocked = await confirm(request.id, member.username);
      expect(blocked.status).toBe(409);
      for (const cookie of [memberCookie, newSession]) expect((await me(cookie)).status).toBe(200);

      const updated = await submitRequest('revoke-sessions', member.id);
      expect(updated.id).not.toBe(request.id);
      expect(updated.affectedSessions).toBe(2);
      expect((await confirm(updated.id, member.username)).status).toBe(200);
      for (const cookie of [memberCookie, newSession]) expect((await me(cookie)).status).toBe(401);
    });

    it('returns one request for identical submissions that overlap at the store', async () => {
      const accountStore = store.accountActions;
      expect(Boolean(accountStore)).toBe(true);
      const insert = accountStore!.insert.bind(accountStore);
      const slowWrite = vi.spyOn(accountStore!, 'insert').mockImplementation(async request => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return insert(request);
      });
      try {
        const [first, second] = await Promise.all([
          submit('revoke-sessions', member.id),
          submit('revoke-sessions', member.id),
        ]);
        for (const response of [first, second]) expect([200, 201]).toContain(response.status);
        expect(second.json().request.id).toBe(first.json().request.id);
        const list = await call<ActionResponse>('GET', actionsPath, ownerCookie);
        expect(list.status).toBe(200);
        expect(list.json().requests.map(request => request.id)).toEqual([first.json().request.id]);
      } finally {
        slowWrite.mockRestore();
      }
    });

    it('returns no forced sign-in notice for a normal logout or a request without a cookie', async () => {
      await expectNoNotice();
      await expectNoNotice(memberCookie);
      const logout = await call('POST', '/api/auth/logout', memberCookie);
      expect(logout.status).toBe(200);
      expect((await me(memberCookie)).status).toBe(401);
      await expectNoNotice(memberCookie);
    });

    it('retains only the forced sign-in receipt for the revoked browser proof for thirty days', async () => {
      const signedIn = await login(member.username, memberPassword);
      expect(signedIn.status).toBe(200);
      const header = signedIn.cookies.find(value => /^(?:__Host-)?cds_signout_proof=/.test(value));
      expect(Boolean(header && /;\s*HttpOnly(?:;|$)/i.test(header))).toBe(true);
      const proof = header!.split(';')[0];
      await expectNoNotice(proof);

      const request = await submitRequest('revoke-sessions', member.id);
      expect(await confirm(request.id, member.username)).toMatchObject({ status: 200 });
      const revokedAt = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(revokedAt + 8 * dayMs);
      try {
        const response = await call<NoticeResponse>('GET', noticePath, proof);
        expect(response.status).toBe(200);
        expect(response.json()).toEqual({ notice: { action: 'revoke-sessions', at: expect.any(String), receiptId: request.id } });
        expect((await me(proof)).status).toBe(401);
        await expectNoNotice();

        clock.mockReturnValue(revokedAt + 31 * dayMs);
        await expectNoNotice(proof);
        expect((await me(proof)).status).toBe(401);
      } finally {
        clock.mockRestore();
      }
    });

    it('removes account management access when an admin revocation is confirmed', async () => {
      const admin = await createAdmin();
      const cookie = await signIn(admin.username, adminPassword);
      const request = await submitRequest('revoke-admin', admin.id);
      expect((await call('GET', usersPath, cookie)).status).toBe(200);
      const completed = await confirm(request.id, admin.username);
      expect(completed.status).toBe(200);
      expect(completed.json().request).toMatchObject({ id: request.id, status: 'completed' });
      const accessAttempt = await call('GET', usersPath, cookie);
      expect([401, 403]).toContain(accessAttempt.status);
      const loginResult = await login(admin.username, adminPassword);
      expect(loginResult.status).toBe(200);
      expect(loginResult.json().user.role).toBe('member');
    });
  });
});
