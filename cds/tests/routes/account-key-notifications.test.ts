import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';
import { createHumanProjectAccessMiddleware } from '../../src/middleware/human-project-access.js';
import { createAccessRequestsRouter } from '../../src/routes/access-requests.js';
import { createAuthLocalRouter } from '../../src/routes/auth-local.js';
import { GH_SESSION_COOKIE } from '../../src/routes/auth.js';
import { createCdsEventsRouter } from '../../src/routes/cds-events.js';
import { createKeyNotificationOwnersRouter } from '../../src/routes/key-notification-owners.js';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { AuthService } from '../../src/services/auth-service.js';
import { readBrowserCookie } from '../../src/services/browser-session-cookies.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import { humanPrincipalId } from '../../src/services/human-project-access.js';
import { hashPassword } from '../../src/services/password.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import type { AgentKey } from '../../src/types.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const projectId = 'notification-fixture';
const projectAccessRequestRoute = '/api/projects/' + projectId + '/access-requests';
const ownershipRoute = '/api/auth/key-notification-owners';
const personalEventsRoute = '/api/cds-events?scope=account-notifications';
const issuerId = 'fixture-cds-account-issuer';
const peerId = 'fixture-cds-account-peer';
const sessions = {
  'issuer-local': { id: issuerId, authProvider: 'local', username: 'fixture.local', githubLogin: 'fixture.local', isSystemOwner: true },
  'issuer-github': { id: issuerId, authProvider: 'github', githubLogin: 'fixture-oauth-alias', isSystemOwner: true },
  'peer-owner': { id: peerId, authProvider: 'github', githubLogin: 'fixture-peer', isSystemOwner: true },
  'ordinary-member': { id: 'fixture-cds-member', authProvider: 'local', username: 'fixture.member', isSystemOwner: false },
} as const;

type Session = keyof typeof sessions;
type FixtureIdentity = { session?: Session; cookie?: string };

function identityHeaders(identity: FixtureIdentity) {
  return {
    ...(identity.session ? { 'X-Fixture-Session': identity.session } : {}),
    ...(identity.cookie ? { Cookie: identity.cookie } : {}),
  };
}

describe('CDS account-scoped Key notifications', () => {
  let directory: string;
  let state: StateService;
  let store: MemoryAuthStore;
  let auth: AuthService;
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-key-notification-'));
    state = new StateService(path.join(directory, 'state.json'), directory);
    state.load();
    const now = new Date().toISOString();
    state.addProject({ id: projectId, slug: projectId, name: 'Synthetic project', kind: 'git',
      dockerNetwork: 'no-fixture-docker', createdAt: now, updatedAt: now });
    store = new MemoryAuthStore();
    auth = new AuthService({ store, config: { allowedOrgs: [] } });
    const authenticate = createGithubAuthMiddleware({
      authService: auth,
      isPublicRequest: req => req.method === 'POST' && req.path === projectAccessRequestRoute,
    });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      // Existing provider-alias tests use a fixture stamp. Handoff tests use the login router and verified cookies.
      const session = req.get('X-Fixture-Session') as Session | undefined;
      const user = session && sessions[session];
      if (user) {
        Object.assign(req, { cdsUser: { ...user, status: 'active' }, cdsSession: { userId: user.id } });
        next();
        return;
      }
      void authenticate(req, res, next).catch(next);
    });
    app.use('/api', createAuthLocalRouter({ authService: auth, stateService: state, cookieSecure: false, bootstrapAllowed: false }));
    app.use('/api', createKeyNotificationOwnersRouter({ state, auth }));
    app.use(createHumanProjectAccessMiddleware(state));
    app.use('/api', createAccessRequestsRouter({ stateService: state, authMode: 'github' }));
    app.use('/api', createCdsEventsRouter({
      stateService: state,
      canNotifySession: async req => {
        const fixtureSession = req.get('X-Fixture-Session') as Session | undefined;
        if (fixtureSession && sessions[fixtureSession]) return true;
        const token = readBrowserCookie(req.headers.cookie, GH_SESSION_COOKIE);
        return Boolean(await auth.validateSession(token ?? null, { renew: false }));
      },
    }));
    app.use('/api', createProjectsRouter({ stateService: state, shell: new MockShellExecutor(),
      config: { reposBase: directory } as Parameters<typeof createProjectsRouter>[0]['config'] }));
    server = listenLoopbackFixture(app);
    if (!server.address()) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address');
    origin = 'http://127.0.0.1:' + address.port;
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function call(method: string, route: string, options: FixtureIdentity & { key?: string; payload?: object } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...identityHeaders(options),
        ...(options.key ? { 'X-AI-Access-Key': options.key } : {}),
      },
      ...(options.payload ? { body: JSON.stringify(options.payload) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  async function createAccount(username: string, role: 'owner' | 'admin' | 'member' = 'member') {
    const password = 'synthetic-notification-password-1+';
    const { hash, salt } = hashPassword(password);
    const account = await store.createLocalUser({ username, passwordHash: hash, passwordSalt: salt,
      isSystemOwner: role === 'owner', isAdministrator: role === 'admin' });
    const response = await call('POST', '/api/auth/login', { payload: { username, password } });
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(account.id);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(GH_SESSION_COOKIE + '='))?.split(';')[0];
    if (!cookie) throw new Error('The fixture login did not return a browser session cookie');
    return { id: account.id, cookie };
  }

  function grantProjectAccess(accountId: string, grantedProjectId = projectId) {
    const principalId = humanPrincipalId(accountId);
    const grantedAt = new Date().toISOString();
    state.addPrincipal({ id: principalId, name: 'Synthetic human', kind: 'human', status: 'active', createdAt: grantedAt });
    state.addProjectGrant({ id: 'fixture-grant-' + accountId, projectId: grantedProjectId, principalId, origin: 'approved', grantedAt });
  }

  async function subscribe(identity: FixtureIdentity, signal: AbortSignal, route = '/api/cds-events') {
    const response = await fetch(origin + route, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      headers: identityHeaders(identity),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    return response;
  }

  async function readThroughMarker(response: Response, marker: string) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    while (!stream.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE ended before the fixture marker');
      stream += decoder.decode(value, { stream: true });
    }
    return stream;
  }

  function seedKey(id: string, plaintext: string, details: Partial<AgentKey> & { issuedByAccountId?: string | null } = {}) {
    state.addAgentKey(projectId, { id, label: id, scope: 'rw', createdAt: new Date().toISOString(),
      hash: createHash('sha256').update(plaintext).digest('hex'), ...details });
  }

  async function requestAccess(options: { key?: string; payload?: object } = {}) {
    const response = await call('POST', projectAccessRequestRoute, {
      key: options.key,
      payload: { agentName: 'Synthetic agent', purpose: 'Synthetic test request', ...options.payload },
    });
    expect(response.status).toBe(201);
    expect(typeof response.body.pollToken).toBe('string');
    return response.body.requestId as string;
  }

  it('stores the verified CDS account ID when a logged-in owner issues a scoped project Key', async () => {
    const created = await call('POST', '/api/projects/' + projectId + '/agent-keys', {
      session: 'issuer-github', payload: { label: 'Synthetic publisher', designAccess: 'publish' },
    });
    expect(created.status).toBe(201);
    const key = state.getAgentKeys(projectId).find(item => item.id === created.body.keyId);
    expect(key).toMatchObject({ designAccess: 'publish', createdBy: 'fixture-oauth-alias', issuedByAccountId: issuerId });
  });

  it('only directs requests proved by a new Key to its issuer while retaining the old and first-use audience', async () => {
    const oldKey = 'cdsp_notification-fixture_legacy_fixture';
    const newKey = 'cdsp_notification-fixture_directed_fixture';
    const principalId = 'fixture-machine-principal';
    state.addPrincipal({ id: principalId, name: 'Synthetic caller', kind: 'machine', status: 'active',
      createdAt: new Date().toISOString() });
    seedKey('fixture-legacy-key', oldKey, { createdBy: 'fixture-oauth-alias' });
    seedKey('fixture-directed-key', newKey, { issuedByAccountId: issuerId, principalId, designAccess: 'publish' });
    const legacy = await requestAccess({ key: oldKey });
    const anonymous = await requestAccess({ payload: { notificationAccountId: peerId, issuedByAccountId: peerId } });
    const directed = await requestAccess({ key: newKey, payload: {
      designAccess: 'publish', notificationAccountId: peerId, issuedByAccountId: peerId,
    } });

    const peer = await call('GET', '/api/access-requests', { session: 'peer-owner' });
    expect(peer.status).toBe(200);
    expect(peer.body.requests.map((row: { id: string }) => row.id).sort()).toEqual([legacy, anonymous].sort());
    expect(peer.body.pendingCount).toBe(2);
    for (const session of ['issuer-local', 'issuer-github'] as const) {
      const issuer = await call('GET', '/api/access-requests', { session });
      expect(issuer.status).toBe(200);
      expect(issuer.body.requests.map((row: { id: string }) => row.id).sort()).toEqual([legacy, anonymous, directed].sort());
      expect(issuer.body.pendingCount).toBe(3);
    }
    expect(state.getAccessRequest(directed)).toMatchObject({ notificationAccountId: issuerId });
    expect(state.getAccessRequest(anonymous)).not.toHaveProperty('notificationAccountId');
    const queue = await call('GET', '/api/access-requests?queue=all', { session: 'peer-owner' });
    expect(queue.status).toBe(200);
    expect(queue.body.requests.map((row: { id: string }) => row.id).sort()).toEqual([legacy, anonymous, directed].sort());
    const mine = await call('GET', '/api/access-requests?queue=mine', { session: 'issuer-github' });
    expect(mine.status).toBe(200);
    expect(mine.body.requests.map((row: { id: string }) => row.id)).toEqual([directed]);
    const member = await call('GET', '/api/access-requests?queue=mine', { session: 'ordinary-member' });
    expect(member.status).toBe(200);
    expect(member.body.requests).toEqual([]);
    expect((await call('GET', '/api/access-requests', { session: 'ordinary-member' })).status).toBe(403);
    expect((await call('GET', '/api/access-requests?queue=all', { session: 'ordinary-member' })).status).toBe(403);
    expect((await call('POST', '/api/access-requests/' + directed + '/approve', { session: 'ordinary-member' })).status).toBe(403);
    const decision = await call('POST', '/api/access-requests/' + directed + '/approve', { session: 'peer-owner' });
    expect(decision.status).toBe(200);
    const approved = state.getAccessRequest(directed);
    expect(approved).toMatchObject({ notificationAccountId: issuerId, principalId, decidedBy: 'fixture-peer' });
    expect(state.getAgentKeys(projectId).find(item => item.id === approved?.issuedKeyId))
      .toMatchObject({ issuedByAccountId: peerId, principalId, designAccess: 'publish' });
  });

  it('keeps a new Key with no verified human issuer in the review queue without legacy fan-out', async () => {
    const key = 'cdsp_notification-fixture_unassigned_fixture';
    seedKey('fixture-new-machine-key', key, { issuedByAccountId: null });
    const directed = await requestAccess({ key, payload: { notificationAccountId: issuerId } });
    for (const session of ['issuer-local', 'peer-owner'] as const) {
      const list = await call('GET', '/api/access-requests', { session });
      expect(list.status).toBe(200);
      expect(list.body.requests).toEqual([]);
      expect(list.body.pendingCount).toBe(0);
    }
    expect(state.getAccessRequest(directed)).toMatchObject({ notificationAccountId: null });
    const queue = await call('GET', '/api/access-requests?queue=all', { session: 'peer-owner' });
    expect(queue.status).toBe(200);
    expect(queue.body.requests.map((row: { id: string }) => row.id)).toEqual([directed]);
  });

  it('preserves legacy SSE delivery without exposing a directed request or its count to peer accounts', async () => {
    const directedKey = 'cdsp_notification-fixture_stream_fixture';
    seedKey('fixture-directed-stream-key', directedKey, { issuedByAccountId: issuerId });
    const requestAborted = new AbortController();
    const mark = 'fixture-after-access-events';
    const privatePurpose = 'directed notification privacy fixture';
    try {
      const [peerEvents, issuerEvents] = await Promise.all([
        subscribe({ session: 'peer-owner' }, requestAborted.signal),
        subscribe({ session: 'issuer-local' }, requestAborted.signal),
      ]);
      const first = await requestAccess();
      const directed = await requestAccess({ key: directedKey, payload: { purpose: privatePurpose } });
      const last = await requestAccess();
      // An ordered, unrelated marker makes absence checks independent of an event timeout.
      cdsEventsBus.publish('notice.created', { fixtureMarker: mark });
      const [stream, issuerStream] = await Promise.all([readThroughMarker(peerEvents, mark), readThroughMarker(issuerEvents, mark)]);
      expect(issuerStream).toContain(directed);
      expect(stream).toContain(first);
      expect(stream).toContain(last);
      expect(stream).not.toContain(directed);
      expect(stream).not.toContain(privatePurpose);
      const data = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const lastLegacy = data.find(event => event.type === 'access-request.created' && event.data?.requestId === last);
      expect(lastLegacy).toBeDefined();
      expect(lastLegacy?.data.pendingCount ?? 2).toBe(2);
    } finally {
      requestAborted.abort();
    }
  });

  it('hands a live pending request to the new recipient without changing its original Key issuer', async () => {
    const issuer = await createAccount('fixture-handoff-issuer', 'owner');
    const owner = await createAccount('fixture-handoff-owner', 'owner');
    const recipient = await createAccount('fixture-handoff-admin', 'admin');
    const stranger = await createAccount('fixture-handoff-stranger');
    grantProjectAccess(recipient.id);

    const created = await call('POST', '/api/projects/' + projectId + '/agent-keys', {
      cookie: issuer.cookie, payload: { label: 'Synthetic handoff Key', designAccess: 'publish' },
    });
    expect(created.status).toBe(201);
    const { keyId, plaintext } = created.body;
    const ref = { kind: 'project', projectId, id: keyId };
    const submission = { key: plaintext, payload: { designAccess: 'publish' } };
    const requestId = await requestAccess(submission);
    const listRoute = '/api/access-requests?queue=mine';
    const before = await call('GET', ownershipRoute, owner);
    expect(before.status).toBe(200);
    expect(before.body.keys).toMatchObject([{ ref, issuedByAccountId: issuer.id, recipientAccountId: issuer.id, state: 'assigned' }]);
    expect((await call('GET', listRoute, issuer)).body.requests).toMatchObject([{ id: requestId, status: 'pending' }]);
    const untouched = await call('GET', listRoute, recipient);
    expect(untouched.status).toBe(200);
    expect(untouched.body).toMatchObject({ requests: [], pendingCount: 0 });
    expect((await call('GET', '/api/cds-events', recipient)).status).toBe(403);
    expect((await call('GET', personalEventsRoute, { key: plaintext })).status).toBe(401);

    const abort = new AbortController();
    try {
      const [oldEvents, recipientEvents, strangerEvents] = await Promise.all([
        subscribe(issuer, abort.signal),
        subscribe(recipient, abort.signal, personalEventsRoute),
        subscribe(stranger, abort.signal, personalEventsRoute),
      ]);
      const reason = 'Synthetic on-call rotation';
      const receipt = await call('POST', ownershipRoute + '/assign', {
        ...owner, payload: { ref, recipientAccountId: recipient.id, expectedRecipientAccountId: issuer.id, reason },
      });
      expect(receipt.status).toBe(200);
      const expectedHandoff = { accountId: recipient.id, previousAccountId: issuer.id, byAccountId: owner.id, reason };
      expect(receipt.body.key).toMatchObject({ ref, issuedByAccountId: issuer.id, recipientAccountId: recipient.id,
        state: 'assigned', handoff: expectedHandoff });
      expect(await auth.listActivity({ userId: owner.id })).toContainEqual(expect.objectContaining({
        action: 'handoff-key-notification', targetType: 'key', targetId: keyId, summary: expect.stringContaining(reason),
      }));
      const reloaded = new StateService(path.join(directory, 'state.json'), directory);
      reloaded.load();
      expect(reloaded.getAgentKeys(projectId)).toMatchObject([{ id: keyId, issuedByAccountId: issuer.id, notificationHandoff: expectedHandoff }]);

      const marker = 'fixture-after-notification-handoff';
      const systemMarker = 'fixture-owner-only-system-notice';
      cdsEventsBus.publish('notice.created', { fixtureMarker: systemMarker });
      cdsEventsBus.publish('heartbeat', { fixtureMarker: marker });
      const [oldStream, recipientStream, strangerStream] = await Promise.all([
        readThroughMarker(oldEvents, marker), readThroughMarker(recipientEvents, marker), readThroughMarker(strangerEvents, marker),
      ]);
      expect(recipientStream).toContain('"stage":"notification-handoff"');
      expect(recipientStream).toContain(requestId);
      expect(oldStream).not.toContain(requestId);
      expect(strangerStream).not.toContain(requestId);
      expect(oldStream).toContain(systemMarker);
      for (const personalStream of [recipientStream, strangerStream]) {
        expect(personalStream).not.toContain(systemMarker);
        expect(personalStream).not.toContain('self.status');
        expect(personalStream).not.toContain('pendingCount');
      }

      for (const reader of [issuer, owner, stranger]) {
        const hidden = await call('GET', listRoute, reader);
        expect(hidden.status).toBe(200);
        expect(hidden.body).toMatchObject({ requests: [], pendingCount: 0 });
      }
      const transferred = await call('GET', listRoute, recipient);
      expect(transferred.status).toBe(200);
      expect(transferred.body.pendingCount).toBe(1);
      expect(transferred.body.requests).toMatchObject([{ id: requestId, status: 'pending', notificationAccountId: recipient.id }]);
      const visible = await call('GET', ownershipRoute, recipient);
      expect(visible.status).toBe(200);
      expect(visible.body).toMatchObject({ keys: [receipt.body.key], accounts: [] });
      const invisible = await call('GET', ownershipRoute, stranger);
      expect(invisible.status).toBe(200);
      expect(invisible.body).toEqual({ keys: [], accounts: [] });
      expect((await call('POST', '/api/access-requests/' + requestId + '/approve', recipient)).status).toBe(403);
      const all = await call('GET', '/api/access-requests?queue=all', owner);
      expect(all.status).toBe(200);
      expect(all.body.requests).toMatchObject([{ id: requestId, notificationAccountId: recipient.id }]);
      const hash = createHash('sha256').update(plaintext).digest('hex');
      const returnedData = JSON.stringify([before.body, receipt.body, transferred.body, visible.body, all.body, recipientStream]);
      expect(returnedData.includes(plaintext), 'The original Key plaintext stays private').toBe(false);
      expect(returnedData.includes(hash), 'The original Key hash stays private').toBe(false);
      expect(transferred.body.requests[0]).not.toHaveProperty('pollTokenHash');

      const laterRequestId = await requestAccess(submission);
      const later = await call('GET', listRoute, recipient);
      expect(later.body.requests.map((row: { id: string }) => row.id).sort()).toEqual([requestId, laterRequestId].sort());
    } finally {
      abort.abort();
    }
  });

  it('rejects stale and unauthorized handoffs and leaves legacy Key audiences in place', async () => {
    const owner = await createAccount('fixture-assignment-owner', 'owner');
    const nextOwner = await createAccount('fixture-next-owner', 'owner');
    const member = await createAccount('fixture-assignment-member');
    const otherProjectAdmin = await createAccount('fixture-other-project-admin', 'admin');
    const disabledAdmin = await createAccount('fixture-disabled-admin', 'admin');
    grantProjectAccess(member.id);
    grantProjectAccess(disabledAdmin.id);
    await store.setUserStatus(disabledAdmin.id, 'disabled');
    const otherProjectId = 'notification-other-fixture';
    const now = new Date().toISOString();
    state.addProject({ id: otherProjectId, slug: otherProjectId, name: 'Other synthetic project', kind: 'git',
      dockerNetwork: 'no-fixture-docker', createdAt: now, updatedAt: now });
    grantProjectAccess(otherProjectAdmin.id, otherProjectId);

    const id = 'fixture-owned-key';
    const legacyId = 'fixture-assignment-legacy';
    seedKey(id, 'cdsp_notification-fixture_assigned', { issuedByAccountId: owner.id });
    const legacyKey = 'cdsp_notification-fixture_assignment_legacy';
    seedKey(legacyId, legacyKey, { createdBy: 'fixture-assignment-owner' });
    const legacyRequestId = await requestAccess({ key: legacyKey });
    const valid = { ref: { kind: 'project', projectId, id }, recipientAccountId: nextOwner.id,
      expectedRecipientAccountId: owner.id, reason: 'Synthetic rotation' };
    const assign = (actor: FixtureIdentity, payload = valid) => call('POST', ownershipRoute + '/assign', { ...actor, payload });

    expect((await call('GET', ownershipRoute)).status).toBe(401);
    expect((await assign({})).status).toBe(401);
    expect((await assign(member)).status).toBe(403);
    expect((await assign(otherProjectAdmin)).status).toBe(403);
    for (const target of [member, otherProjectAdmin, disabledAdmin]) {
      expect((await assign(owner, { ...valid, recipientAccountId: target.id })).status).toBe(403);
    }
    expect((await assign(owner, { ...valid, expectedRecipientAccountId: member.id })).status).toBe(409);
    expect((await assign(owner, { ...valid, ref: { ...valid.ref, id: legacyId } })).status).toBe(409);
    expect(state.getAgentKeys(projectId).find(key => key.id === id)).not.toHaveProperty('notificationHandoff');
    const assignment = await assign(owner);
    expect(assignment.status).toBe(200);
    expect(assignment.body.key).toMatchObject({ issuedByAccountId: owner.id, recipientAccountId: nextOwner.id, state: 'assigned' });
    expect((await assign(owner)).status).toBe(409);

    const list = await call('GET', ownershipRoute, owner);
    expect(list.status).toBe(200);
    const legacy = list.body.keys.find((key: { ref: { id: string } }) => key.ref.id === legacyId);
    expect(legacy).toMatchObject({ state: 'legacy' });
    expect(legacy).not.toHaveProperty('issuedByAccountId');
    expect(legacy).not.toHaveProperty('recipientAccountId');
    expect(legacy).not.toHaveProperty('handoff');
    for (const legacyViewer of [owner, nextOwner]) {
      const requests = await call('GET', '/api/access-requests', legacyViewer);
      expect(requests.status).toBe(200);
      expect(requests.body.requests).toMatchObject([{ id: legacyRequestId }]);
    }
  });
});
