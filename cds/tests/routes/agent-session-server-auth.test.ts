import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { CdsPairingService } from '../../src/services/connection/pairing-service.js';
import { AgentWorkspaceSessionRuntime, AgentWorkspaceRuntimeError } from '../../src/services/agent-workspace-session-runtime.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig, Project } from '../../src/types.js';

// Real createServer authentication + router, with only Docker execution mocked.
// All credentials, projects and source URLs below belong to this local synthetic fixture.
describe('Agent sessions through the real basic-auth server', () => {
  let root: string;
  let state: StateService;
  let projectId: string;
  let otherProjectId: string;
  let pairing: CdsPairingService;
  let connection: ReturnType<CdsPairingService['accept']>;
  const servers: http.Server[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-session-auth-'));
    projectId = `session-a-${crypto.randomUUID()}`;
    otherProjectId = `session-b-${crypto.randomUUID()}`;
    for (const key of ['CDS_GITHUB_CLIENT_ID', 'CDS_GITHUB_CLIENT_SECRET', 'CDS_SSO_ENABLED',
      'CDS_SSO_AUTHORIZATION_URL', 'CDS_SSO_TOKEN_URL', 'CDS_SSO_CLIENT_ID', 'CDS_SSO_CLIENT_SECRET',
      'CDS_AI_EXPLANATION_GATEWAY_URL', 'CDS_AI_EXPLANATION_MODEL']) vi.stubEnv(key, '');
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'fixture-admin');
    vi.stubEnv('CDS_PASSWORD', 'fixture-password');
    vi.stubEnv('CDS_AI_ACCESS_KEY', 'fixture-global-key');
    vi.stubEnv('AI_ACCESS_KEY', 'fixture-global-key');
    vi.stubEnv('CDS_REPO_ROOT', root);
    vi.stubEnv('CDS_AGENT_WORKSPACE_ROOT', path.join(root, 'workspaces'));
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'https://cds.example.test');
    state = new StateService(path.join(root, 'state.json'), root);
    state.load();
    for (const id of [projectId, otherProjectId]) state.addProject(project(id));
    pairing = new CdsPairingService(state, () => 'https://cds.example.test', () => 'fixture-cds', () => 'Fixture');
    connection = authorize('owner');
    vi.spyOn(AgentWorkspaceSessionRuntime.prototype, 'bootstrapAndVerify').mockResolvedValue();
    vi.spyOn(AgentWorkspaceSessionRuntime.prototype, 'create').mockRejectedValue(new Error('must not allocate Docker'));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await flushAllJsonStateStores();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function project(id: string): Project {
    const now = new Date().toISOString();
    return { id, slug: id, name: id, kind: 'shared-service', createdAt: now, updatedAt: now };
  }

  function authorize(name: string, scopes?: string[]) {
    const issued = pairing.issue({ name, scopes });
    return pairing.accept({ pairingToken: issued.pairingToken, partnerKind: 'map', partnerId: name,
      partnerName: name, partnerBaseUrl: 'https://map.example.test',
      projectIntent: { kind: 'shared-service', name: projectId } }, () => project(projectId));
  }

  async function start(currentState = state) {
    const shell = new MockShellExecutor();
    const config: CdsConfig = {
      repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'fixture-network', portStart: 10001, sharedEnv: {},
      jwt: { secret: 'fixture-secret', issuer: 'fixture' }, mode: 'standalone', executorPort: 9901,
      rootDomains: ['example.test'],
    };
    const app = createServer({ stateService: currentState, shell, config,
      worktreeService: new WorktreeService(shell, root), containerService: {} as any,
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as any,
      bridgeService: {} as any });
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
    return server;
  }

  function headers(kind: string, token = connection.cdsLongToken): Record<string, string> {
    return kind === 'bearer' ? { Authorization: `Bearer ${token}` } : { [kind]: token };
  }

  async function request(server: http.Server, method: string, url: string, auth: Record<string, string>, body?: unknown) {
    return await new Promise<{ status: number; text: string; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
        path: url, method, headers: { Accept: 'application/json', ...auth,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk.toString(); });
        res.on('end', () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(text); } catch { /* SSE is checked as text. */ }
          resolve({ status: res.statusCode!, text, body: parsed, headers: res.headers });
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('local fixture request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  it.each(['bearer', 'X-AI-Access-Key', 'ai-access-key'])('preserves connection project and principal through %s', async (kind) => {
    const server = await start();
    const foreignCatalog = await request(server, 'GET', `/api/projects/${otherProjectId}/agent-runtime-providers`, headers(kind));
    expect(foreignCatalog.status).toBe(403);
    expect(foreignCatalog.body.error.code).toBe('project_mismatch');
    const foreignCreate = await request(server, 'POST', `/api/projects/${otherProjectId}/agent-sessions`, headers(kind), { runtime: 'fake' });
    expect(foreignCreate.status).toBe(403);
    expect(foreignCreate.body.error.code).toBe('project_mismatch');
    const own = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, headers(kind), { runtime: 'fake', clientRequestId: 'own-session' });
    expect(own.status).toBe(201);
    expect(state.listAgentSessionReservations().find((x) => x.id === own.body.item.id)?.principalKey)
      .toBe(`connection:${connection.connectionId}`);
    expect(state.listAgentSessionReservations().every((x) => x.projectId === projectId)).toBe(true);
  });

  it.each(['bearer', 'X-AI-Access-Key', 'ai-access-key'])('keeps scope and authenticated MAP origin through %s', async (kind) => {
    const reader = authorize('reader', ['instance:read']);
    const server = await start();
    const denied = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, headers(kind, reader.cdsLongToken), { runtime: 'fake' });
    // The outer server may reject a header before the router when its scope is absent.
    expect([401, 403]).toContain(denied.status);
    expect(state.listAgentSessionReservations()).toHaveLength(0);
    const foreignSource = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, headers(kind), {
      runtime: 'open-design', workloadKind: 'design-artifact', clientRequestId: 'foreign-source',
      workspaceTransfer: { schemaVersion: 'map-design-workspace-v1',
        inputPackageUrl: 'https://other-map.example.test/input', resultCommitUrl: 'https://other-map.example.test/commit',
        transferToken: 'fixture-transfer', inputSha256: 'a'.repeat(64), baseRevision: 'fixture-revision',
        maxInputBytes: 1024, maxOutputBytes: 2048, allowedOutputPaths: ['index.html', 'manifest.json'] },
    });
    expect(foreignSource.status).toBe(422);
    expect(foreignSource.body.error.code).toBe('workspace_transfer_origin_mismatch');
    expect(AgentWorkspaceSessionRuntime.prototype.create).not.toHaveBeenCalled();
  });

  it('allows administrators to observe a machine session, not mutate it or grant other connections access', async () => {
    const other = authorize('another-owner');
    const server = await start();
    const created = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, headers('bearer'), { runtime: 'fake' });
    expect(created.status).toBe(201);
    const base = `/api/projects/${projectId}/agent-sessions/${created.body.item.id}`;
    expect((await request(server, 'POST', `${base}/messages`, headers('bearer'), { content: 'synthetic observation' })).status).toBe(202);
    const login = await request(server, 'POST', '/api/login', {}, { username: 'fixture-admin', password: 'fixture-password' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']![0].split(';')[0];
    for (const auth of [{ Cookie: cookie }, { 'X-AI-Access-Key': 'fixture-global-key' }]) {
      const list = await request(server, 'GET', `/api/projects/${projectId}/agent-requests`, auth);
      expect(list.status).toBe(200);
      expect(list.body.items.some((x: { sessionId: string }) => x.sessionId === created.body.item.id)).toBe(true);
      const stream = await request(server, 'GET', `${base}/stream`, auth);
      expect(stream.status).toBe(200);
      expect(stream.text).toContain('synthetic observation');
      expect((await request(server, 'POST', `${base}/messages`, auth, { content: 'must not mutate' })).status).toBe(404);
      expect((await request(server, 'POST', `${base}/stop`, auth)).status).toBe(404);
      expect((await request(server, 'POST', `${base}/tool-approvals/missing`, auth, { approved: true })).status).toBe(404);
    }
    expect((await request(server, 'GET', `${base}/stream`, headers('bearer', other.cdsLongToken))).status).toBe(404);
    expect((await request(server, 'POST', `${base}/stop`, headers('bearer', other.cdsLongToken))).status).toBe(404);
    expect((await request(server, 'GET', `${base}/stream`, headers('bearer'))).status).toBe(200);
  });

  it.each([false, true])('reconciles cleanup on a second restart, repeated failure=%s', async (stillFails) => {
    const id = `persisted-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    state.upsertAgentSessionReservation({ id, routerInstanceId: 'previous-process', projectId,
      principalKey: `connection:${connection.connectionId}`, clientRequestId: 'persistent-attempt', createdAt: now, updatedAt: now,
      item: { id, runtime: 'open-design', status: 'creating', resourceCleanupPending: false } });
    await state.flush();
    const bootstrap = vi.mocked(AgentWorkspaceSessionRuntime.prototype.bootstrapAndVerify);
    bootstrap.mockRejectedValueOnce(new AgentWorkspaceRuntimeError('workspace_cleanup_failed', 'synthetic cleanup failure', true));
    const firstServer = await start();
    const first = await request(firstServer, 'POST', `/api/projects/${projectId}/agent-sessions/${id}/stop`, headers('bearer'));
    expect(first.status).toBe(503);
    expect(first.body.item).toMatchObject({ status: 'failed', resourceCleanupPending: true });
    await state.flush();
    const reloaded = new StateService(path.join(root, 'state.json'), root);
    reloaded.load();
    if (stillFails) bootstrap.mockRejectedValueOnce(new AgentWorkspaceRuntimeError('workspace_cleanup_failed', 'synthetic cleanup failure again', true));
    else bootstrap.mockResolvedValueOnce();
    vi.spyOn(AgentWorkspaceSessionRuntime.prototype, 'stop').mockResolvedValue();
    const secondServer = await start(reloaded);
    const second = await request(secondServer, 'POST', `/api/projects/${projectId}/agent-sessions/${id}/stop`, headers('bearer'));
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(stillFails ? 503 : 200);
    expect(second.body.item).toMatchObject({ status: stillFails ? 'failed' : 'stopped', resourceCleanupPending: stillFails });
    expect(reloaded.listAgentSessionReservations().find((x) => x.id === id)?.item.resourceCleanupPending).toBe(stillFails);
    if (stillFails) expect(AgentWorkspaceSessionRuntime.prototype.stop).not.toHaveBeenCalled();
    else expect(AgentWorkspaceSessionRuntime.prototype.stop).toHaveBeenCalledOnce();
  });
});
