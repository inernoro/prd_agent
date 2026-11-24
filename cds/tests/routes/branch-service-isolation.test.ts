import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBranchServiceIsolationRouter } from '../../src/routes/branch-service-isolation.js';
import { StateService } from '../../src/services/state.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

let state: StateService, coordinator: BranchOperationCoordinator, server: http.Server, root: string, scope: string, observe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-isolation-http-'));
  state = new StateService(path.join(root, 'state.json')); state.load(); coordinator = new BranchOperationCoordinator(); scope = 'p'; observe = vi.fn(async () => {});
  for (const id of ['legacy', 'knowledge']) state.addBuildProfile({ id, projectId: 'p', name: id,
    dockerImage: 'node:22-alpine', workDir: '.', command: 'run', containerPort: 8080,
    env: { PRIVATE_TEST_VALUE: 'synthetic-secret-do-not-return' }, ...(id === 'knowledge' ? { dependsOn: ['legacy'] } : {}) });
  state.addBranch({ id: 'target', projectId: 'p', branch: 'target', worktreePath: root, services: {}, status: 'idle', createdAt: '2026-01-01' });
  state.setBranchExtraProfiles('target', [{ id: 'synthetic', projectId: 'p', name: 'synthetic', dockerImage: 'node:22-alpine', workDir: '.', command: 'run', containerPort: 8080 }]);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).cdsProjectKey = { projectId: scope, keyId: 'fixture' }; next(); });
  app.use('/api', createBranchServiceIsolationRouter(state, coordinator, observe)); server = listenLoopbackFixture(app);
});
afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  await state.flush(); fs.rmSync(root, { recursive: true, force: true }); });
async function request(method = 'GET', body?: unknown) {
  if (!server.listening) await once(server, 'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('fixture unavailable');
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/api/branches/target/service-isolation', method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(payload);
  });
}
const input = () => ({ expectedRevision: state.getBranchServiceIsolationRevision(state.getBranch('target')!),
  excludedProjectProfileIds: ['legacy'], dependsOnOverrides: { knowledge: ['synthetic'] } });

describe('branch isolation HTTP contract', () => {
  it('reads a masked contract, writes atomically and rereads exact effective profiles', async () => {
    const before = await request(); expect(before.status).toBe(200);
    expect(JSON.stringify(before.body)).not.toContain('synthetic-secret');
    const result = await request('PUT', input()); expect(result.status).toBe(200);
    expect(result.body.effectiveProfiles).toEqual([{ id: 'knowledge', dependsOn: ['synthetic'] }, { id: 'synthetic', dependsOn: [] }]);
    expect((await request()).body).toEqual(result.body);
  });
  it('refuses another project for both reads and writes', async () => {
    scope = 'other'; expect((await request()).status).toBe(403);
    expect((await request('PUT', input())).status).toBe(403);
    expect(state.getBranch('target')!.excludedProjectProfileIds).toBeUndefined();
  });
  it('refuses an existing operation without cancelling it', async () => {
    const active = coordinator.begin({ kind: 'deploy', branchId: 'target', projectId: 'p', trigger: 'manual', source: 'test' });
    expect((await request('PUT', input())).status).toBe(409);
    expect(coordinator.getActive('target')?.cancelled).toBe(false);
    coordinator.completeAll(active.lease!, 'completed');
  });
  it('holds configuration admission through durable save and rejects deployment/stop/webhook races', async () => {
    const flush = state.flush.bind(state); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(state, 'flush').mockImplementationOnce(async () => { entered(); await gate; await flush(); });
    const saving = request('PUT', input()); await ready;
    for (const [kind, trigger] of [['deploy', 'manual'], ['stop', 'manual'], ['deploy', 'webhook']] as const) {
      expect(coordinator.begin({ kind, trigger, branchId: 'target', projectId: 'p', source: 'test' }).status).toBe('rejected');
    }
    expect(coordinator.getActive('target')?.cancelled).toBe(false);
    release(); expect((await saving).status).toBe(200); expect(coordinator.getActive('target')).toBeUndefined();
  });
  it('does not change configuration while a deployment target is being resolved', async () => {
    const read = coordinator.beginDeploymentPreparation({ kind: 'deploy', branchId: 'target', projectId: 'p', trigger: 'manual', source: 'test' });
    expect((await request('PUT', input())).status).toBe(409); read.release();
  });
  it('reports an unknown save outcome and requires readback instead of blind retry', async () => {
    vi.spyOn(state, 'flush').mockRejectedValueOnce(Error('synthetic persistence failure'));
    const result = await request('PUT', input()); expect(result.status).toBe(503); expect(result.body.error).toContain('先读取');
    expect((await request()).body.excludedProjectProfileIds).toEqual(['legacy']);
  });
  it('treats a synchronous save failure after mutation as unknown, too', async () => {
    vi.spyOn(state, 'save').mockImplementationOnce(() => { throw Error('synthetic save failure'); });
    const result = await request('PUT', input()); expect(result.status).toBe(503);
    expect(result.body.error).toContain('先读取'); expect((await request()).body.excludedProjectProfileIds).toEqual(['legacy']);
  });
  it('refuses unknown or running physical containers before any configuration change', async () => {
    observe.mockRejectedValueOnce(Error('runtime observation unknown'));
    expect((await request('PUT', input())).status).toBe(409);
    expect(state.getBranch('target')!.excludedProjectProfileIds).toBeUndefined();
    expect(coordinator.getActive('target')).toBeUndefined();
  });
  it('rejects stale config and unknown write fields', async () => {
    const old = input(); expect((await request('PUT', old)).status).toBe(200);
    expect((await request('PUT', old)).status).toBe(409);
    expect((await request('PUT', { ...input(), projectId: 'other' })).status).toBe(400);
  });
});
