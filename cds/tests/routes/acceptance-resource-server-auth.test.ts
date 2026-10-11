import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

describe('Acceptance resource routes through actual server authentication and parsers', () => {
  let dir: string, state: StateService, server: http.Server;
  const input = { projectId: 'p1', branchId: 'b1', profileId: 'owned-init', targetSha: 'a'.repeat(40), isolationRunId: 'owned_run' };
  const keys = { p1: 'cdsp_p1_ownedfixture', p2: 'cdsp_p2_foreignfixture', global: 'cdsg_ownedfixture', create: 'cdsg_createfixture' };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acceptance-auth-'));
    for (const key of ['CDS_GITHUB_CLIENT_ID', 'CDS_GITHUB_CLIENT_SECRET', 'CDS_SSO_ENABLED', 'CDS_SSO_AUTHORIZATION_URL',
      'CDS_SSO_TOKEN_URL', 'CDS_SSO_CLIENT_ID', 'CDS_SSO_CLIENT_SECRET', 'CDS_AI_ACCESS_KEY', 'AI_ACCESS_KEY',
      'CDS_AI_EXPLANATION_GATEWAY_URL', 'CDS_AI_EXPLANATION_MODEL']) vi.stubEnv(key, '');
    vi.stubEnv('CDS_AUTH_MODE', 'basic'); vi.stubEnv('CDS_USERNAME', 'owned-fixture'); vi.stubEnv('CDS_PASSWORD', 'owned-fixture-password');
    vi.stubEnv('CDS_REPO_ROOT', dir); vi.stubEnv('CDS_PUBLIC_BASE_URL', 'https://fixture.example.test');
    state = new StateService(path.join(dir, 'state.json'), dir); state.load();
    for (const id of ['p1', 'p2'] as const) {
      state.addProject({ id, slug: id, name: id } as any);
      state.addAgentKey(id, { id: 'owned-key', label: 'owned fixture', hash: hash(keys[id]), scope: 'rw', createdAt: new Date().toISOString() });
    }
    state.addGlobalAgentKey({ id: 'global', label: 'owned fixture', hash: hash(keys.global), scope: 'rw', createdAt: new Date().toISOString(), access: { canCreateProjects: false, projects: ['p2'] } });
    state.addGlobalAgentKey({ id: 'create', label: 'owned fixture', hash: hash(keys.create), scope: 'rw', createdAt: new Date().toISOString(), access: { canCreateProjects: true, projects: [] } });
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'owned/receipt', worktreePath: dir, createdAt: '2026-10-10T00:00:00.000Z', status: 'idle', services: {} });
    const shell = new MockShellExecutor();
    const config: CdsConfig = { repoRoot: dir, worktreeBase: path.join(dir, 'worktrees'), masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'owned-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'owned-jwt', issuer: 'fixture' }, mode: 'standalone', executorPort: 9901, rootDomains: ['example.test'] };
    const app = createServer({ stateService: state, shell, config, worktreeService: new WorktreeService(shell, dir),
      containerService: {} as any, proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as any, bridgeService: {} as any });
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true });
  });
  function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
  function request(method: string, route: string, token?: string, body?: unknown) {
    return new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: route, method, agent: false,
        headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
        let raw = ''; res.on('data', chunk => { raw += chunk.toString(); });
        res.on('end', () => { let body: any; try { body = JSON.parse(raw); } catch { body = null; } resolve({ status: res.statusCode!, body, raw }); });
      });
      req.setTimeout(5000, () => req.destroy(new Error('owned server request deadline'))); req.on('error', reject); req.end(data);
    });
  }
  it('requires authentication, stamps real key scope, and does not let owner capability cross project', async () => {
    expect((await request('POST', '/api/acceptance-resource-runs', undefined, input)).status).toBe(401);
    const begun = await request('POST', '/api/acceptance-resource-runs', keys.p1, input);
    expect(begun.status).toBe(201); const owner = begun.body;
    for (const key of [keys.p2, keys.global, keys.create]) {
      expect((await request('GET', '/api/acceptance-resource-runs/' + owner.run.id, key)).status).toBe(403);
      const rejected = await request('POST', '/api/acceptance-resource-runs/' + owner.run.id + '/register', key, { ownerToken: owner.ownerToken });
      expect(rejected.status).toBe(403); expect(rejected.raw).not.toContain(owner.ownerToken);
    }
    expect((await request('GET', '/api/acceptance-resource-runs/' + owner.run.id, keys.p1)).body.run.stage).toBe('active');
    expect(JSON.stringify(state.getState())).not.toContain(owner.ownerToken);
  });
  it('uses small bounded parser after auth instead of global rawBody parser', async () => {
    const oversized = await request('POST', '/api/acceptance-resource-runs', keys.p1, { ...input, ownerToken: 'sensitive-capability'.repeat(200) });
    expect(oversized.status).toBe(413); expect(oversized.body).toEqual({ error: 'acceptance_payload_too_large' });
    const malformed = await request('POST', '/api/acceptance-resource-runs', keys.p1, '{"ownerToken":"sensitive-capability"');
    expect(malformed.status).toBe(400); expect(malformed.body).toEqual({ error: 'acceptance_payload_invalid' });
    expect(oversized.raw + malformed.raw).not.toMatch(/sensitive-capability|SyntaxError/);
  });
  it('preserves the small authenticated parser on Express case-insensitive route aliases', async () => {
    const oversized = await request('POST', '/api/Acceptance-Resource-Runs', keys.p1,
      { ...input, ownerToken: 'sensitive-capability'.repeat(200) });
    expect(oversized.status).toBe(413); expect(oversized.body).toEqual({ error: 'acceptance_payload_too_large' });
    const unauthenticated = await request('POST', '/api/Acceptance-Resource-Runs', undefined, '{"ownerToken":"sensitive-capability"');
    expect(unauthenticated.status).toBe(401);
    expect(state.getState().acceptanceResourceRuns).toBeUndefined();
  });
});
