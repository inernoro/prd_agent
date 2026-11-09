import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBranchLifecycleRouter } from '../../src/routes/branch-lifecycle.js';
import { BranchLifecycleService } from '../../src/services/branch-lifecycle.js';
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
