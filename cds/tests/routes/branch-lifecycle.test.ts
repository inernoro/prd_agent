import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBranchLifecycleRouter } from '../../src/routes/branch-lifecycle.js';
import { BranchLifecycleService, stopBranchForLifecycle } from '../../src/services/branch-lifecycle.js';
import { createServer } from '../../src/server.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

describe('归档清理HTTP契约', () => {
  let state: StateService, server: http.Server, root: string;
  let scope: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-lifecycle-http-')); state = new StateService(path.join(root, 'state.json')); state.load();
    const date = new Date().toISOString();
    for (const id of ['a', 'b']) {
      state.addProject({ id, slug: id, name: id, kind: 'git', legacyFlag: false, dockerNetwork: id, createdAt: date, updatedAt: date });
      state.addBranch({ id, projectId: id, branch: `feature/${id}`, status: 'idle', worktreePath: path.join(root, id), services: {}, createdAt: date });
    }
    const lifecycle = new BranchLifecycleService({ state, stop: async () => {}, remove: async () => {},
      observed: () => new Set(), active: () => false, flush: () => state.flush() });
    const app = express(); app.use(express.json()); scope = undefined;
    app.use((req, _res, next) => { if (scope) (req as any).cdsProjectKey = { projectId: scope, keyId: 'fixture' }; next(); });
    app.use('/api', createBranchLifecycleRouter(state, lifecycle)); server = listenLoopbackFixture(app);
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = async (route: string, body: unknown = {}) => {
    if (!server.listening) await once(server, 'listening');
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('fixture not ready');
    const payload = JSON.stringify(body);
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/api' + route, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => { try { resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
      }); req.on('error', reject); req.end(payload);
    });
  };

  it('先读取范围不会修改状态，实际执行必须确认，之后能恢复归档', async () => {
    const preview = await request('/projects/a/branches/lifecycle-cleanup', { mode: 'incomplete', dryRun: true });
    expect(preview.status).toBe(200); expect(preview.body.candidates.map((b: any) => b.id)).toEqual(['a']);
    expect(state.getBranch('a')?.archive).toBeUndefined();
    expect((await request('/projects/a/branches/lifecycle-cleanup', { mode: 'all' })).status).toBe(400);
    const result = await request('/projects/a/branches/lifecycle-cleanup', { mode: 'incomplete', confirm: true });
    expect(result.body.archivedCount).toBe(1); expect(state.getBranch('b')?.archive).toBeUndefined();
    expect((await request('/projects/a/branches/a/restore-archive')).status).toBe(200); expect(state.getBranch('a')?.archive).toBeNull();
  });

  it('项目Key不能跨项目清理或恢复，也不能省略目标做全局清理', async () => {
    scope = 'a';
    expect((await request('/projects/b/branches/lifecycle-cleanup', { mode: 'all', confirm: true })).status).toBe(403);
    expect((await request('/projects/b/branches/b/restore-archive')).status).toBe(403);
    expect((await request('/projects/missing/branches/lifecycle-cleanup', { mode: 'all', confirm: true })).status).toBe(400);
    expect(state.getBranch('b')?.archive).toBeUndefined();
  });
});

describe('生命周期停止的真实控制面鉴权', () => {
  it.each(['basic', 'github'])('%s鉴权拒绝无来源回环请求，生产停止调用携带原项目与分支进入停止路由', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-lifecycle-auth-'));
    let server: http.Server | undefined;
    for (const key of ['CDS_USERNAME', 'CDS_PASSWORD', 'CDS_SSO_ENABLED', 'CDS_AI_ACCESS_KEY', 'AI_ACCESS_KEY']) vi.stubEnv(key, '');
    vi.stubEnv('CDS_AUTH_MODE', mode); vi.stubEnv('CDS_USERNAME', 'fixture'); vi.stubEnv('CDS_PASSWORD', 'fixture'); vi.stubEnv('CDS_GITHUB_CLIENT_ID', 'fixture');
    vi.stubEnv('CDS_GITHUB_CLIENT_SECRET', 'fixture'); vi.stubEnv('CDS_REPO_ROOT', root);
    try {
      const state = new StateService(path.join(root, 'state.json'), root); state.load();
      const date = new Date().toISOString();
      state.addProject({ id: 'own', slug: 'own', name: 'Own', kind: 'git', createdAt: date, updatedAt: date });
      state.addBranch({ id: 'owned', projectId: 'own', branch: 'feature/owned', status: 'running', worktreePath: root, createdAt: date,
        services: { api: { profileId: 'api', containerName: 'own-api', hostPort: 12001, status: 'running' } } });
      const stop = vi.fn(async () => {}), shell = new MockShellExecutor();
      const app = createServer({ stateService: state, shell,
        config: { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'fixture', portStart: 10001,
          sharedEnv: {}, jwt: { secret: 'fixture', issuer: 'fixture' }, mode: 'standalone', rootDomains: ['example.test'] },
        worktreeService: new WorktreeService(shell, root), containerService: { stopRuntimeGroup: stop, getLogs: async () => '' } as any,
        proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as any, bridgeService: {} as any });
      server = listenLoopbackFixture(app); if (!server.listening) await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const denied = await fetch(base + '/api/branches/owned/stop', { method: 'POST', headers: { 'X-CDS-Internal': '1' } });
      expect(denied.status).toBe(mode === 'basic' ? 403 : 401); await denied.arrayBuffer(); expect(stop).not.toHaveBeenCalled();
      let capturedHeaders: HeadersInit | undefined, capturedBody: RequestInit['body'];
      let mutation: string | undefined;
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
        capturedHeaders = options?.headers; capturedBody = options?.body;
        const headers = new Headers(options?.headers), target = new URL(String(url));
        let body = options?.body;
        if (mutation === 'project') headers.set('X-CDS-Source-Project-Id', 'foreign');
        if (mutation === 'path') target.pathname = '/api/branches/foreign/stop';
        if (mutation === 'query') target.search = '?force=1';
        if (mutation === 'body') body = JSON.stringify({ lifecycleReason: 'archive' });
        if (mutation === 'push') state.getBranch('owned')!.lastPushAt = '2026-11-10T00:01:00Z';
        if (mutation === 'redeploy') state.getBranch('owned')!.lastDeployStartedAt = '2026-11-10T00:01:00Z';
        if (mutation === 'recreate') state.getBranch('owned')!.createdAt = '2026-11-10T00:01:00Z';
        return originalFetch(target, { ...options, headers, body });
      });
      for (const change of ['project', 'path', 'query', 'body', 'push', 'redeploy', 'recreate']) {
        mutation = change;
        await expect(stopBranchForLifecycle(base, state.getBranch('owned')!, 'startup-timeout')).rejects.toThrow('停止未完成');
        expect(stop).not.toHaveBeenCalled(); state.getBranch('owned')!.lastPushAt = undefined;
        state.getBranch('owned')!.lastDeployStartedAt = undefined;
        state.getBranch('owned')!.createdAt = date;
      }
      mutation = undefined;
      await stopBranchForLifecycle(base, state.getBranch('owned')!, 'startup-timeout');
      fetchSpy.mockRestore();
      expect(stop).toHaveBeenCalledTimes(1); expect(state.getBranch('owned')?.services.api.status).toBe('stopped');
      expect(state.getBranch('owned')?.lastStopReason).toContain('整组未完全启动超过30分钟');
      const replay = await originalFetch(base + '/api/branches/owned/stop', { method: 'POST', headers: capturedHeaders, body: capturedBody });
      expect(replay.status).toBe(401); expect((await replay.json()).error).toBe('invalid_lifecycle_stop'); expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await flushAllJsonStateStores(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
