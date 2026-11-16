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
async function request(n: Node, route: string, key?: string, method = 'GET', body?: unknown, cookie?: string) {
  const response = await fetch(n.url + route, { method, redirect: 'manual', headers: { Accept: 'application/json',
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
    const central = new URL(start.headers.get('location')!);
    const handoff = await request(primary, central.pathname + central.search, undefined, 'GET', undefined, signed.cookie);
    expect(handoff.status).toBe(302);
    const callback = new URL(handoff.headers.get('location')!);
    const completed = await request(member, callback.pathname + callback.search);
    expect(completed.status).toBe(302);
    const cookie = completed.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(200);
    expect((await request(member, callback.pathname + callback.search)).status).toBe(401);
    const malicious = await request(member, '/login?redirect=%2F%5Cevil.example');
    expect(new URL(malicious.headers.get('location')!).searchParams.get('returnTo')).toBe('/project-list');
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
    await auth.setUserStatus(user.id, 'disabled');
    expect((await request(member, '/api/projects/local-a', undefined, 'GET', undefined, cookie)).status).toBe(401);
  });

  it('maps the user credential discovery grant without copying identities into the member', async () => {
    primary.state.addPrincipal({ id: 'principal-fixture', name: 'fixture', kind: 'agent', status: 'active', createdAt: new Date().toISOString() });
    primary.state.addUserCredential({ id: 'credential-fixture', principalId: 'principal-fixture', hash: hash('cdsu_fixture'),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
    primary.state.addProjectGrant({ id: 'agent-grant', principalId: 'principal-fixture', projectId: 'source-a', origin: 'approved', grantedAt: new Date().toISOString() });
    const response = await request(member, '/api/projects', 'cdsu_fixture');
    expect(response.status).toBe(200);
    expect((response.json.projects || response.json).map((p: { id: string }) => p.id)).toEqual(['local-a']);
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
