import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from '../../src/server.js';
import { ClusterIdentityService, parseClusterIdentityConfig } from '../../src/services/cluster-identity.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig, Project } from '../../src/types.js';
import type { ServerEventLogSink, ServerEventRecord } from '../../src/services/server-event-log-store.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const primaryKey = 'fixture-primary-root', oldMemberKey = 'fixture-obsolete-member-root';
const nodeToken = 'n'.repeat(48), projects = { 'source-a': 'local-a', 'source-b': 'local-b' };
type Node = Awaited<ReturnType<typeof node>>;
let root: string, servers: http.Server[], primary: Node, member: Node;

async function node(name: string, username: string, password: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  const state = new StateService(path.join(dir, 'state.json'), dir); state.load();
  const names = name === 'primary' ? ['source-a', 'source-b'] : ['local-a', 'local-b'];
  for (const id of names) state.addProject({ id, slug: id, name: id, kind: 'git',
    gitRepoUrl: `https://github.com/fixture/${id.endsWith('a') ? 'a' : 'b'}.git`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Project);
  state.setCustomEnv({ AI_ACCESS_KEY: name === 'primary' ? primaryKey : oldMemberKey });
  vi.stubEnv('CDS_USERNAME', username); vi.stubEnv('CDS_PASSWORD', password);
  const eventFile = path.join(dir, 'events.jsonl');
  const sink: ServerEventLogSink = {
    record: row => fs.appendFileSync(eventFile, JSON.stringify({ ...row, _id: randomUUID(), ts: new Date() }) + '\n'),
    recordImmediate: async row => sink.record(row),
    findRecent: async filter => fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(s => JSON.parse(s) as ServerEventRecord)
      .filter(row => !filter?.requestId || row.requestId === filter.requestId).slice(-(filter?.limit || 200)) : [],
  };
  const shell = new MockShellExecutor();
  const config: CdsConfig = { repoRoot: dir, worktreeBase: path.join(dir, 'worktrees'), masterPort: 9900, workerPort: 5500,
    dockerNetwork: 'fixture', portStart: 10001, sharedEnv: {}, jwt: { secret: 'fixture', issuer: 'fixture' }, mode: 'standalone', executorPort: 9901 };
  const app = createServer({ stateService: state, shell, config, serverEventLogStore: sink,
    worktreeService: new WorktreeService(shell, dir), containerService: {} as any,
    proxyService: { getProxyLog: () => [], setOnProxyLog() {}, handleSwitchFromExpress() {} } as any, bridgeService: {} as any });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return { state, app, server, dir, sink, eventFile, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function request(n: Node, route: string, key?: string, method = 'GET', body?: unknown, cookie?: string, accept = 'application/json') {
  const response = await fetch(n.url + route, { method, redirect: 'manual', headers: { Accept: accept,
    ...(key ? { 'X-AI-Access-Key': key } : {}), ...(cookie ? { Cookie: cookie } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json: any;
  try { json = JSON.parse(text); } catch { /* redirect/html assertions use headers */ }
  return { status: response.status, json, text, headers: response.headers };
}
async function configure() {
  expect((await request(primary, '/api/cluster/identity/config', primaryKey, 'PUT', {
    version: 1, role: 'authority', clusterId: 'fixture-cluster', nodeId: 'primary',
    members: [{ nodeId: 'standby', url: member.url, tokenHash: hash(nodeToken), projects }],
  })).status).toBe(200);
  expect((await request(member, '/api/cluster/identity/config', oldMemberKey, 'PUT', {
    version: 1, role: 'member', clusterId: 'fixture-cluster', nodeId: 'standby', authorityNodeId: 'primary', authorityUrl: primary.url, nodeToken, projects,
  })).status).toBe(200);
}
function projectKey(key = 'cdsp_fixture_project') {
  primary.state.addAgentKey('source-a', { id: 'source-key', label: 'fixture', hash: hash(key), scope: 'rw', createdAt: new Date().toISOString() });
  return key;
}
async function login(n: Node, username = 'primary-admin', password = 'primary-password') {
  const reply = await request(n, '/api/login', undefined, 'POST', { username, password });
  return { ...reply, cookie: reply.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
}

describe('cluster identity through two real HTTP control planes', () => {
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cluster-identity-')); servers = [];
    for (const key of ['CDS_AI_ACCESS_KEY', 'AI_ACCESS_KEY', 'CDS_SSO_ENABLED', 'CDS_SSO_CLIENT_ID', 'CDS_SSO_CLIENT_SECRET',
      'CDS_AI_EXPLANATION_GATEWAY_URL', 'CDS_AI_EXPLANATION_MODEL']) vi.stubEnv(key, '');
    vi.stubEnv('CDS_AUTH_MODE', 'basic'); vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://127.0.0.1');
    primary = await node('primary', 'primary-admin', 'primary-password');
    member = await node('standby', 'old-member-admin', 'old-member-password');
    await configure();
  });
  afterEach(async () => {
    for (const s of servers) if (s.listening) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
    await flushAllJsonStateStores(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('pins enrolled membership so an owner cannot restore independent authorization through reconfiguration', async () => {
    const result = await request(member, '/api/cluster/identity/config', primaryKey, 'PUT', {
      version: 1, role: 'authority', clusterId: 'fixture-cluster', nodeId: 'standby', members: [],
    });
    expect(result.status).toBe(409); expect(result.json.error).toBe('cluster_identity_pinned');
    expect(member.app.locals.clusterIdentity?.getConfig?.()?.role ?? JSON.parse(fs.readFileSync(path.join(member.dir, '.cds', 'cluster-identity.json'), 'utf8')).role).toBe('member');
    expect((await request(member, '/api/projects/local-a', oldMemberKey)).status).toBe(401);
  });

  it('pairs MAP on the authority and uses the grant only on its bound execution project', async () => {
    const route = '/api/cds-system/connections';
    const mapBaseUrl = 'https://map-preview.example.test';
    const owner = await login(member);
    expect(owner.status).toBe(200);
    const issue = await request(member, route + '/issue', undefined, 'POST', {
      projectId: 'local-a', mapBaseUrl, scopes: ['instance:read'],
    }, owner.cookie);
    expect(issue.status).toBe(201);
    const connectionId: string = issue.json.connectionId;
    expect(member.state.getCdsConnection(connectionId)).toBeUndefined();
    expect(primary.state.getCdsConnection(connectionId)).toMatchObject({
      projectId: 'source-a', status: 'pending-pairing',
    });
    const payload = JSON.parse(Buffer.from(issue.json.clipboardText.split(':')[2], 'base64url').toString('utf8'));
    expect(payload.cdsBaseUrl).toBe(member.url);
    const accept = {
      pairingToken: payload.pairingToken, mapId: 'map-preview', mapName: 'MAP preview', mapBaseUrl,
      projectIntent: { kind: 'shared-service', name: 'sidecar-pool' },
    };
    expect((await request(primary, route + '/accept', undefined, 'POST', accept)).status).toBe(403);
    const wrongOrigin = await request(member, route + '/accept', undefined, 'POST', {
      ...accept, mapBaseUrl: 'https://other.example.test',
    });
    expect(wrongOrigin.status).toBe(403);
    const results = await Promise.all([
      request(member, route + '/accept', undefined, 'POST', accept),
      request(member, route + '/accept', undefined, 'POST', accept),
    ]);
    const exchanged = results.find(reply => reply.status === 200);
    expect(exchanged?.json.projectId).toBe('local-a');
    expect(exchanged?.json.instanceDiscoveryUrl).toBe('/api/projects/local-a/instances');
    expect(results.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(results.every(reply => reply.status === 200 || reply.status === 410)).toBe(true);
    expect(member.state.getCdsConnections()).toHaveLength(0);
    expect(primary.state.getCdsConnections().filter(item => item.status === 'active')).toHaveLength(1);
    expect(primary.state.getProjects()).toHaveLength(2);
    const key: string = exchanged!.json.cdsLongToken;
    expect((await request(member, '/api/projects/local-a/agent-runtime-providers', key)).status).toBe(200);
    expect((await request(member, '/api/projects/local-b/agent-runtime-providers', key)).status).toBe(401);
    expect((await request(primary, '/api/projects/source-a/agent-runtime-providers', key)).status).toBe(401);
    expect((await request(member, '/api/projects/local-a/agent-sessions', key, 'POST', {})).status).toBe(401);
    const originalRepo = member.state.getProject('local-a')!.gitRepoUrl;
    member.state.updateProject('local-a', { gitRepoUrl: 'https://github.com/fixture/wrong.git' });
    expect((await request(member, '/api/projects/local-a/agent-runtime-providers', key)).status).toBe(503);
    member.state.updateProject('local-a', { gitRepoUrl: originalRepo });
    const revoked = await request(member, route + '/' + connectionId + '/revoke', undefined, 'POST', {}, owner.cookie);
    expect(revoked.status).toBe(200);
    expect(primary.state.getCdsConnection(connectionId)?.status).toBe('revoked');
    expect((await request(member, '/api/projects/local-a/agent-runtime-providers', key)).status).toBe(401);
  });

  it('denies an expired or consumed pairing code and can recover with a new approval', async () => {
    const route = '/api/cds-system/connections';
    const mapBaseUrl = 'https://map-preview.example.test';
    const owner = await login(member);
    const issue = async () => {
      const result = await request(member, route + '/issue', undefined, 'POST', {
        projectId: 'local-a', mapBaseUrl,
      }, owner.cookie);
      expect(result.status).toBe(201);
      const payload = JSON.parse(Buffer.from(result.json.clipboardText.split(':')[2], 'base64url').toString('utf8'));
      return { id: result.json.connectionId as string, code: payload.pairingToken as string };
    };
    const exchange = (code: string) => request(member, route + '/accept', undefined, 'POST', {
      pairingToken: code, mapId: 'recovery-map', mapName: 'MAP preview', mapBaseUrl,
      projectIntent: { kind: 'shared-service', name: 'sidecar-pool' },
    });
    const expired = await issue();
    primary.state.updateCdsConnection(expired.id, { pairingExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await exchange(expired.code)).status).toBe(410);
    const lost = await issue();
    // The authority completed the exchange, but the client has no usable response.
    expect((await exchange(lost.code)).status).toBe(200);
    expect((await exchange(lost.code)).status).toBe(410);
    const replacement = await issue();
    const accepted = await exchange(replacement.code);
    expect(accepted.status).toBe(200);
    expect(primary.state.getActiveCdsConnections().map(item => item.id)).toEqual([replacement.id]);
    expect((await request(member, '/api/projects/local-a/agent-runtime-providers', accepted.json.cdsLongToken)).status).toBe(200);
  });

  it('requires a system owner and a bound project when issuing MAP pairing through a member', async () => {
    const route = '/api/cds-system/connections/issue';
    const approval = { projectId: 'local-a', mapBaseUrl: 'https://map-preview.example.test' };
    expect((await request(member, route, primaryKey, 'POST', approval)).status).toBe(403);
    const owner = await login(member);
    expect(owner.status).toBe(200);
    expect((await request(member, route, undefined, 'POST', {
      ...approval, projectId: 'unbound-project',
    }, owner.cookie)).status).toBe(400);
    expect(member.state.getCdsConnections()).toHaveLength(0);
    expect(primary.state.getCdsConnections()).toHaveLength(0);
  });

  it('uses the browser approval and server-side token exchange without external redirect or excess scope', async () => {
    const route = '/api/cds-system/connections';
    const mapBaseUrl = 'https://map-preview.example.test';
    const approval = {
      mapBaseUrl, redirectUri: mapBaseUrl + '/settings?tab=infra-services',
      state: 'fixture-callback-state', mapId: 'browser-map', mapName: 'MAP preview',
    };
    const entry = route + '/authorize?' + new URLSearchParams({ ...approval, approve: '1' });
    const anonymous = await request(member, entry, undefined, 'GET', undefined, undefined, 'text/html');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toMatch(/^\/login\?/);
    const owner = await login(member);
    expect(owner.status).toBe(200);
    const page = await request(member, entry, undefined, 'GET', undefined, owner.cookie, 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('执行项目');
    expect(primary.state.getCdsConnections()).toHaveLength(0);
    const approve = (origin: string, redirectUri = approval.redirectUri) =>
      fetch(member.url + route + '/authorize', {
        method: 'POST', redirect: 'manual', headers: { Cookie: owner.cookie, Origin: origin },
        body: new URLSearchParams({ ...approval, redirectUri, projectId: 'local-a' }),
      });
    expect((await approve('https://other.example.test')).status).toBe(403);
    expect((await approve(member.url, 'https://other.example.test/settings?tab=infra-services')).status).toBe(400);
    expect(primary.state.getCdsConnections()).toHaveLength(0);
    const approved = await approve(member.url);
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get('location')!);
    expect(location.origin).toBe(mapBaseUrl);
    const code = location.searchParams.get('cds_code')!;
    expect(location.searchParams.get('state')).toBe(approval.state);
    expect(location.searchParams.get('cds_base_url')).toBe(member.url);
    const token = await request(member, route + '/token', undefined, 'POST', {
      code, mapId: approval.mapId, mapName: approval.mapName, mapBaseUrl,
      projectIntent: { kind: 'shared-service', name: 'sidecar-pool' },
    });
    expect(token.status).toBe(200);
    expect(token.json.workspaceOnly).toBe(true);
    expect(token.json.scopes).toEqual(['shared-service:deploy', 'instance:read', 'deployment:stream']);
    expect((await request(member, '/api/projects/local-a/agent-runtime-providers', token.json.cdsLongToken)).status).toBe(200);
    expect((await request(member, '/api/projects/local-a/agent-sessions?clientRequestId=not-created-yet', token.json.cdsLongToken)).status).toBe(200);
    expect((await request(member, '/api/reports', token.json.cdsLongToken)).status).toBe(401);
    expect([primary, member].some(instance => {
      const events = fs.readFileSync(instance.eventFile, 'utf8');
      return events.includes(code) || events.includes(token.json.cdsLongToken);
    })).toBe(false);
  });

  it('does not fall back to standalone pairing when the authority lacks the cluster protocol', async () => {
    const owner = await login(member);
    expect(owner.status).toBe(200);
    const actualFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (input === primary.url + '/api/cluster/identity/map-connections/issue') {
        return Promise.resolve(Response.json({ error: 'unknown route' }, { status: 404 }));
      }
      return actualFetch(input, init);
    });
    const result = await request(member, '/api/cds-system/connections/issue', undefined, 'POST', {
      projectId: 'local-a', mapBaseUrl: 'https://map-preview.example.test',
    }, owner.cookie);
    expect(result.status).toBe(503);
    expect(result.json.error.code).toBe('cluster_map_connection_unsupported');
    expect(primary.state.getCdsConnections()).toHaveLength(0);
    expect(member.state.getCdsConnections()).toHaveLength(0);
  });

  it('routes member DTS through the authority and rejects cross-project sync scope', async () => {
    const key = projectKey();
    const capabilities = vi.spyOn(primary.app.locals.dtsService, 'capabilities').mockImplementation(async (projectId: unknown) => ({ projectId, protocolVersion: 1, tools: [] }));
    vi.spyOn(member.app.locals.dtsService, 'capabilities').mockRejectedValue(new Error('independent member DTS must not run'));
    const result = await request(member, '/api/dts/capabilities?projectId=local-a', key);
    expect(result.status).toBe(200); expect(result.json.projectId).toBe('local-a'); expect(capabilities).toHaveBeenCalledWith('source-a');
    expect((await request(member, '/api/dts/capabilities?projectId=local-b', key)).status).toBe(403);
  });

  it('admits authorized human DTS reads on both nodes without admitting writes or other projects', async () => {
    const user = await primary.app.locals.cdsAuthService.createLocalUser({ username: 'dts-reader', password: 'long-fixture-password' });
    primary.state.addPrincipal({ id: `human:${user.id}`, name: 'reader', kind: 'human', status: 'active', createdAt: new Date().toISOString() });
    primary.state.addProjectGrant({ id: 'dts-read-grant', principalId: `human:${user.id}`, projectId: 'source-a', origin: 'approved', grantedAt: new Date().toISOString() });
    const signed = await request(member, '/api/auth/login', undefined, 'POST', { username: 'dts-reader', password: 'long-fixture-password' });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const service = primary.app.locals.dtsService;
    vi.spyOn(service, 'capabilities').mockResolvedValue({ protocolVersion: 1 });
    for (const method of ['connections', 'runs', 'policies']) vi.spyOn(service, method).mockResolvedValue([]);
    vi.spyOn(service, 'services').mockReturnValue([]);
    vi.spyOn(service, 'refresh').mockResolvedValue({ id: 'fixture-run' });
    vi.spyOn(service, 'publicRun').mockReturnValue({ id: 'fixture-run', status: 'completed' });
    for (const [n, id, other] of [[primary, 'source-a', 'source-b'], [member, 'local-a', 'local-b']] as const) {
      for (const route of ['capabilities', 'connections', 'runs', 'runs/fixture-run', 'policies']) {
        const result = await request(n, `/api/dts/${route}?projectId=${id}`, undefined, 'GET', undefined, cookie);
        expect(result.status, `${n.url}/${route}`).toBe(200);
        if (route === 'capabilities') expect(result.json).toMatchObject({ configureAllowed: false, executeAllowed: false });
        expect((await request(n, `/api/dts/${route}?projectId=${other}`, undefined, 'GET', undefined, cookie)).status).toBe(403);
      }
      expect((await request(n, '/api/dts/capabilities', undefined, 'GET', undefined, cookie)).status).toBeGreaterThanOrEqual(400);
      expect((await request(n, `/api/dts/engine?projectId=${id}`, undefined, 'GET', undefined, cookie)).status).toBe(403);
      for (const [method, route] of [['POST', 'connections'], ['PUT', 'engine'], ['POST', 'plans'], ['POST', 'runs'], ['POST', 'policies'], ['PATCH', 'policies/fixture'], ['POST', 'runs/fixture-run/pause']]) {
        expect((await request(n, `/api/dts/${route}`, undefined, method, { projectId: id }, cookie)).status).toBe(403);
      }
    }
    primary.state.revokeProjectGrant('dts-read-grant');
    for (const [n, id] of [[primary, 'source-a'], [member, 'local-a']] as const) {
      expect((await request(n, `/api/dts/capabilities?projectId=${id}`, undefined, 'GET', undefined, cookie)).status).toBe(403);
    }
  });

  it.each(['unrelated=1', 'cds_token=obsolete-member-session', undefined])('recovers a browser document with an invalid or missing session: %s', async cookie => {
    const target = '/project-list?tab=active';
    const result = await request(member, target, undefined, 'GET', undefined, cookie, 'text/html');
    expect(result.status).toBe(302);
    const localLogin = new URL(result.headers.get('location')!, member.url);
    expect(localLogin.pathname).toBe('/login'); expect(localLogin.searchParams.get('redirect')).toBe(target);
    const central = await request(member, localLogin.pathname + localLogin.search, undefined, 'GET', undefined, cookie, 'text/html');
    const loginPage = new URL(central.headers.get('location')!);
    expect(loginPage.origin).toBe(primary.url); expect(loginPage.pathname).toBe('/login');
    const handoff = new URL(loginPage.searchParams.get('redirect')!, primary.url);
    expect(handoff.searchParams.get('returnTo')).toBe(target);
    expect((await request(member, '/api/projects', undefined, 'GET', undefined, cookie, 'text/html')).status).toBe(401);
  });

  it('preserves all-project key scope through the member while still translating concrete project lists', async () => {
    const owner = await login(member);
    const all = await request(member, '/api/global-agent-keys', undefined, 'POST', { label: 'all cluster projects', access: { canCreateProjects: false, projects: 'all' } }, owner.cookie);
    expect(all.status).toBe(201); expect(all.json.access.projects).toBe('all');
    expect(member.state.getGlobalAgentKeys()).toHaveLength(0);
    expect(primary.state.getGlobalAgentKeys().find(k => k.id === all.json.keyId)?.access?.projects).toBe('all');
    for (const id of ['local-a', 'local-b']) expect((await request(member, `/api/projects/${id}`, all.json.plaintext)).status).toBe(200);
    expect((await request(member, '/api/global-agent-keys', all.json.plaintext, 'POST', { access: { projects: 'all' } })).status).toBe(403);
    const scoped = await request(member, '/api/global-agent-keys', undefined, 'POST', { access: { canCreateProjects: false, projects: ['local-a'] } }, owner.cookie);
    expect(scoped.status).toBe(201); expect(scoped.json.access.projects).toEqual(['local-a']);
    expect(primary.state.getGlobalAgentKeys().find(k => k.id === scoped.json.keyId)?.access?.projects).toEqual(['source-a']);
  });

  it('accepts the same authority credential, rejects independent local credentials, and persists membership', async () => {
    expect((await request(member, '/api/projects/local-a', primaryKey)).status).toBe(200);
    expect((await request(member, '/api/projects/local-a', oldMemberKey)).status).toBe(401);
    const status = await request(member, '/api/cluster/identity/status', primaryKey);
    expect(status.json).toMatchObject({ state: 'synchronized', clusterId: 'fixture-cluster', authorityNodeId: 'primary', independentAuthorization: false });
    expect(JSON.stringify(status.json)).not.toContain(nodeToken);
    const reloaded = new ClusterIdentityService(member.dir, member.state, member.sink);
    expect(reloaded.getConfig()?.role).toBe('member');
    expect(fs.statSync(path.join(member.dir, '.cds/cluster-identity.json')).mode & 0o777).toBe(0o600);
    expect((await request(primary, '/api/cluster/identity/status', primaryKey)).json.members[0].state).toBe('synchronized');
  });

  it('preserves the authority legacy machine header without accepting the old member header or granting human approval', async () => {
    const legacy = hash('cds:primary-admin:primary-password');
    for (const n of [primary, member]) expect((await fetch(n.url + '/api/projects', { headers: { 'X-CDS-Token': legacy } })).status).toBe(200);
    expect((await fetch(member.url + '/api/projects', { headers: { 'X-CDS-Token': hash('cds:old-member-admin:old-member-password') } })).status).toBe(401);
    const result = await fetch(member.url + '/api/auth/status', { headers: { 'X-CDS-Token': legacy } });
    expect((await result.json()).approvalCapabilities.operator).toBe(false);
  });

  it('maps project scope, refuses other projects and honors revocation without local fallback', async () => {
    const key = projectKey();
    member.state.addAgentKey('local-a', { id: 'stale-local', label: 'stale', hash: hash(key), scope: 'rw', createdAt: new Date().toISOString() });
    expect((await request(member, '/api/projects/local-a', key)).status).toBe(200);
    expect((await request(member, '/api/projects/local-b', key)).status).toBe(403);
    const list = await request(member, '/api/projects', key);
    expect((list.json.projects || list.json).map((p: { id: string }) => p.id)).toEqual(['local-a']);
    expect((await request(member, '/api/cluster/identity/config', key, 'PUT', {})).status).toBe(403);
    primary.state.revokeAgentKey('source-a', 'source-key');
    expect((await request(member, '/api/projects/local-a', key)).status).toBe(401);
  });

  it('keeps create-only restrictions and rejects unbound/expired credentials', async () => {
    primary.state.addGlobalAgentKey({ id: 'create', label: 'create only', hash: hash('cdsg_create'), scope: 'rw',
      createdAt: new Date().toISOString(), access: { canCreateProjects: true, projects: [] } });
    expect((await request(member, '/api/env', 'cdsg_create', 'PUT', { values: { test: 'value' } })).status).toBe(403);
    projectKey('cdsp_expired'); primary.state.getAgentKeys('source-a')[0].expiresAt = new Date(0).toISOString();
    expect((await request(member, '/api/projects/local-a', 'cdsp_expired')).status).toBe(401);
    expect((await request(member, '/api/projects', primaryKey, 'POST', { name: 'independent' })).status).toBe(409);
  });

  it('delegates the original account and uses a one-time cross-domain login handoff', async () => {
    const signed = await login(member); expect(signed.status).toBe(200);
    expect((await login(member, 'old-member-admin', 'old-member-password')).status).toBe(401);
    expect((await request(member, '/api/auth/status', undefined, 'GET', undefined, signed.cookie)).json.user.username).toBe('primary-admin');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, signed.cookie)).status).toBe(200);
    const start = await request(member, '/login?redirect=%2Fproject-list');
    const loginPage = new URL(start.headers.get('location')!);
    expect(loginPage.origin).toBe(primary.url); expect(loginPage.pathname).toBe('/login');
    const central = new URL(loginPage.searchParams.get('redirect')!, primary.url);
    expect(central.pathname).toBe('/api/cluster/identity/login');
    expect((await request(primary, central.pathname + central.search)).status).toBe(401);
    const handoff = await request(primary, central.pathname + central.search, undefined, 'GET', undefined, signed.cookie);
    expect(handoff.status).toBe(302);
    const callback = new URL(handoff.headers.get('location')!);
    const completed = await request(member, callback.pathname + callback.search);
    expect(completed.status).toBe(302);
    const cookie = completed.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(200);
    expect((await request(member, callback.pathname + callback.search)).status).toBe(401);
    const malicious = await request(member, '/login?redirect=%2F%5Cevil.example');
    const safeLogin = new URL(malicious.headers.get('location')!);
    expect(new URL(safeLogin.searchParams.get('redirect')!, primary.url).searchParams.get('returnTo')).toBe('/project-list');
  });

  it('issues and revokes only at the authority even through a member URL', async () => {
    const signed = await login(member);
    const minted = await request(member, '/API/PROJECTS/local-a/AGENT-KEYS/', undefined, 'POST', { label: 'cluster-issued' }, signed.cookie);
    expect(minted.status).toBe(201);
    expect(member.state.getAgentKeys('local-a')).toHaveLength(0);
    expect(primary.state.getAgentKeys('source-a')).toHaveLength(1);
    expect((await request(member, '/api/projects/local-a', minted.json.plaintext)).status).toBe(200);
    const revoked = await request(member, `/api/projects/local-a/agent-keys/${minted.json.keyId}`, undefined, 'DELETE', undefined, signed.cookie);
    expect(revoked.status).toBe(200);
    expect((await request(member, '/api/projects/local-a', minted.json.plaintext)).status).toBe(401);
  });

  it('fails closed when the authority is unavailable and reads back redacted failure evidence', async () => {
    expect((await request(member, '/api/projects/local-a', primaryKey)).status).toBe(200);
    primary.server.closeAllConnections(); await new Promise<void>(resolve => primary.server.close(() => resolve()));
    const result = await request(member, '/api/projects/local-a', oldMemberKey);
    expect(result.status).toBe(503); expect(result.json.error).toBe('cluster_identity_unavailable');
    const rows = fs.readFileSync(member.eventFile, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(rows.some(r => r.source === 'cluster-identity' && r.details.responseReceived === false)).toBe(true);
    expect(rows.some(r => r.source === 'cluster-identity' && r.details.businessRequestId === result.headers.get('x-cds-request-id'))).toBe(true);
    for (const secret of [primaryKey, oldMemberKey, nodeToken]) expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('requires registered membership and identical binding on both nodes', async () => {
    const invalid = await fetch(primary.url + '/api/cluster/identity/resolve', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-AI-Access-Key': primaryKey, 'X-CDS-Cluster-Id': 'fixture-cluster', 'X-CDS-Cluster-Node': 'standby', 'X-CDS-Cluster-Token': 'wrong',
    }, body: JSON.stringify({ method: 'GET', path: '/api/projects' }) });
    expect(invalid.status).toBe(401);
    await request(primary, '/api/cluster/identity/config', primaryKey, 'PUT', { version: 1, role: 'authority', clusterId: 'fixture-cluster', nodeId: 'primary',
      members: [{ nodeId: 'standby', url: member.url, tokenHash: hash(nodeToken), projects: { 'source-a': 'local-b' } }] });
    const rejected = await request(member, '/api/projects/local-a', primaryKey);
    expect(rejected.status).toBe(503);
    const decisions = await member.sink.findRecent!({ requestId: rejected.headers.get('x-cds-request-id')! });
    expect(decisions.some(row => row.details?.code === 'cluster_identity_mismatch')).toBe(true);
    expect(() => parseClusterIdentityConfig({ version: 1, role: 'member', clusterId: 'x', nodeId: 'standby', authorityNodeId: 'primary',
      authorityUrl: 'https://user:password@foreign.example/', nodeToken, projects })).toThrow();
  });

  it('shares human project grants, revocation and account disablement without local grant copies', async () => {
    const auth = primary.app.locals.cdsAuthService;
    const user = await auth.createLocalUser({ username: 'cluster-member', password: 'long-fixture-password' });
    primary.state.addPrincipal({ id: `human:${user.id}`, name: 'fixture', kind: 'human', status: 'active', createdAt: new Date().toISOString() });
    primary.state.addProjectGrant({ id: 'human-grant', principalId: `human:${user.id}`, projectId: 'source-a', origin: 'approved', grantedAt: new Date().toISOString() });
    const signed = await request(member, '/api/auth/login', undefined, 'POST', { username: 'cluster-member', password: 'long-fixture-password' });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(200);
    expect((await request(member, '/api/projects/local-b', undefined, 'GET', undefined, cookie)).status).toBe(403);
    expect(member.state.getProjectGrants()).toHaveLength(0);
    primary.state.revokeProjectGrant('human-grant');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(403);
    const owner = await login(member);
    const selection = await request(member, `/api/auth/users/${user.id}/projects`, undefined, 'GET', undefined, owner.cookie);
    expect(selection.json.projects.map((p: { id: string }) => p.id)).toEqual(['source-a', 'source-b']);
    expect((await request(member, `/api/auth/users/${user.id}/projects`, undefined, 'PUT', { projectIds: ['source-a'] }, owner.cookie)).status).toBe(200);
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(200);
    expect(member.state.getProjectGrants()).toHaveLength(0);
    expect((await request(member, `/api/auth/users/${user.id}/projects`, undefined, 'PUT', { projectIds: [] }, owner.cookie)).status).toBe(200);
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(403);
    await auth.setUserStatus(user.id, 'disabled');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(401);
  });

  it('creates device recovery only at the authority and preserves canonical owner selectors', async () => {
    const response = await request(member, '/api/identity-connections', undefined, 'POST', {
      repository: 'https://github.com/fixture/a.git', projectId: 'local-a', agentName: 'cluster-device-fixture',
    });
    expect(response.status).toBe(201);
    expect(member.state.getIdentityConnections()).toHaveLength(0);
    expect(primary.state.getIdentityConnections()[0].projectHint).toBe('source-a');
    const owner = await login(member);
    const review = await request(member, '/api/identity/connections', undefined, 'GET', undefined, owner.cookie);
    expect(review.json.requests[0].candidates[0].id).toBe('source-a');
    expect((await request(member, `/api/identity/connections/${response.json.requestId}/reject`, undefined, 'POST', {}, owner.cookie)).status).toBe(200);
    expect(primary.state.getIdentityConnections()[0].status).toBe('rejected');
  });

  it('maps the user credential discovery grant without copying identities into the member', async () => {
    primary.state.addPrincipal({ id: 'principal-fixture', name: 'fixture', kind: 'agent', status: 'active', createdAt: new Date().toISOString() });
    primary.state.addUserCredential({ id: 'credential-fixture', principalId: 'principal-fixture', hash: hash('cdsu_fixture'),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
    primary.state.addProjectGrant({ id: 'agent-grant', principalId: 'principal-fixture', projectId: 'source-a', origin: 'approved', grantedAt: new Date().toISOString() });
    const response = await request(member, '/api/projects', 'cdsu_fixture');
    expect(response.status).toBe(200);
    expect((response.json.projects || response.json).map((p: { id: string }) => p.id)).toEqual(['local-a']);
    const passthrough = await request(member, '/_cds/api/projects', 'cdsu_fixture');
    expect(passthrough.status).toBe(200);
    expect((passthrough.json.projects || passthrough.json).map((p: { id: string }) => p.id)).toEqual(['local-a']);
    primary.state.revokeProjectGrant('agent-grant');
    const empty = await request(member, '/api/projects', 'cdsu_fixture');
    expect(empty.json.projects || empty.json).toHaveLength(0);
  });

  it('rejects a same-name binding whose repositories differ and allows the owner to repair it', async () => {
    projectKey();
    member.state.updateProject('local-a', { gitRepoUrl: 'https://foreign.example/fixture/a.git' });
    const rejected = await request(member, '/api/projects/local-a', primaryKey);
    expect(rejected.status).toBe(503);
    const decisions = await member.sink.findRecent!({ requestId: rejected.headers.get('x-cds-request-id')! });
    expect(decisions.some(row => row.details?.code === 'cluster_project_binding_mismatch')).toBe(true);
    expect((await request(member, '/api/cluster/identity/config', primaryKey, 'PUT', {
      version: 1, role: 'member', clusterId: 'fixture-cluster', nodeId: 'standby', authorityNodeId: 'primary', authorityUrl: primary.url, nodeToken, projects,
    })).status).toBe(200);
  });
});
