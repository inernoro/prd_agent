import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { ReleaseBatchService } from '../../src/services/release-batch-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseService } from '../../src/services/release-service.js';
import { beginSelfUpdateDrain, endSelfUpdateDrain, isDrainBlockedPath, selfUpdateDrainBlockReason } from '../../src/services/deploy-drain.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { ReleaseBatch } from '../../src/domain/release-batch.js';
import type { BranchEntry } from '../../src/types.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-11-12T08:00:00.000Z';
const MUTATIONS = ['', '/preflight', '/start', '/cancel', '/refresh', '/targets/p1-a/retry', '/targets/p1-a/rollback'];

describe('批次发布路由的项目边界与排空门禁', () => {
  let root: string;
  let state: StateService;
  let server: http.Server;
  let origin: string;
  let ownBatch: ReleaseBatch;
  let otherBatch: ReleaseBatch;
  let service: { onRunStarted: ReturnType<typeof vi.fn>; preflight: ReturnType<typeof vi.fn>; startRelease: ReturnType<typeof vi.fn>;
    startRollback: ReturnType<typeof vi.fn>; cancelRelease: ReturnType<typeof vi.fn>; isTargetBusy: ReturnType<typeof vi.fn>; readRemoteReleaseState: ReturnType<typeof vi.fn> };

  async function call(method: string, pathname: string, identity = 'p1', body?: unknown) {
    const headers = { 'Content-Type': 'application/json',
      ...(identity === 'global-ai' ? { 'X-AI-Access-Key': 'fixture-global-key' } : { 'X-Test-Project': identity }) };
    const response = await fetch(origin + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { error?: string; batch?: ReleaseBatch; batches?: ReleaseBatch[]; versions?: unknown[] }, retryAfter: response.headers.get('retry-after') };
  }

  beforeEach(async () => {
    endSelfUpdateDrain();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-batch-scope-'));
    state = new StateService(path.join(root, 'state.json'), root);
    state.load();
    service = {
      onRunStarted: vi.fn(), preflight: vi.fn(async () => ({ ok: true, checks: [], preflightId: 'scope-preflight' })),
      startRelease: vi.fn(), startRollback: vi.fn(), cancelRelease: vi.fn(), isTargetBusy: vi.fn(() => ({ busy: false })),
      readRemoteReleaseState: vi.fn(async () => ({ inventory: { currentCommitSha: SHA }, readAt: NOW })),
    };
    const coordinator = new ReleaseBatchService(state, service as unknown as ReleaseService);
    const created: ReleaseBatch[] = [];
    for (const projectId of ['p1', 'p2']) {
      const branchId = `branch-${projectId}`;
      state.addProject({ id: projectId, name: projectId, slug: projectId, kind: 'git', createdAt: NOW, updatedAt: NOW });
      state.addBranch({ id: branchId, projectId, branch: 'main', worktreePath: root, services: {}, status: 'running', githubCommitSha: SHA, createdAt: NOW } as BranchEntry);
      state.addDeploymentVersion({ id: `version-${projectId}`, projectId, branchId, commitSha: SHA, configHash: projectId, profiles: [], migrations: [], capabilities: [], createdByRunId: 'scope-build', createdAt: NOW });
      const report = state.createAcceptanceReport({ projectId, branchId, commitSha: SHA, verdict: 'pass', reportType: 'acceptance', title: '发布验收 · 权限隔离 · 2026-11-12', content: '通过', format: 'md' });
      for (const suffix of ['a', 'b']) state.upsertReleaseTarget({ id: `${projectId}-${suffix}`, projectId, name: `${projectId}-${suffix}`, type: 'ssh', isEnabled: true, createdAt: NOW,
        strategy: { mode: 'project-script', scriptFile: 'cds-release.sh' }, ssh: { host: '127.0.0.1', port: 2222, user: 'deploy', privateKeyRef: 'scope-host',
          appPath: `${root}/${projectId}-${suffix}`, deployCommand: '', healthcheckUrl: 'https://isolated.example.test/health' } });
      created.push(await coordinator.create({ projectId, versionId: `version-${projectId}`, reportId: report.id,
        targetIds: [`${projectId}-a`, `${projectId}-b`], idempotencyKey: `create-${projectId}`, operator: 'user' }));
    }
    [ownBatch, otherBatch] = created;
    const app = express();
    app.use(express.json());
    // Authentication is intentionally represented by the already-verified request
    // context, as in releases-scope.test.ts. No real credentials are used here.
    app.use((req, _res, next) => {
      const projectId = req.header('X-Test-Project');
      if (projectId && projectId !== 'cookie') (req as unknown as { cdsProjectKey: { projectId: string; keyId: string } }).cdsProjectKey = { projectId, keyId: `key-${projectId}` };
      next();
    });
    // Same app-level predicate used by server.ts, ahead of all release routes.
    app.use('/api', (req, res, next) => {
      const blocked = isDrainBlockedPath(req.method, req.path) && selfUpdateDrainBlockReason(Date.now());
      if (!blocked) { next(); return; }
      res.setHeader('Retry-After', '60');
      res.status(503).json({ error: blocked });
    });
    app.use('/api', createReleasesRouter({ stateService: state, releaseService: service as unknown as ReleaseService, config: { worktreeBase: root } }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    endSelfUpdateDrain();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('项目 key 的无 query 列表默认只返回本项目，显式跨项目列表与候选被拒绝', async () => {
    const list = await call('GET', '/api/releases/batches');
    expect(list.status).toBe(200);
    expect(list.body.batches?.map(batch => batch.id)).toEqual([ownBatch.id]);
    expect((await call('GET', '/api/releases/batches?projectId=p2')).status).toBe(403);
    expect((await call('GET', '/api/releases/batches/accepted-versions?projectId=p2')).status).toBe(403);
    const accepted = await call('GET', '/api/releases/batches/accepted-versions');
    expect(accepted.status).toBe(200);
    expect(accepted.body.versions).toHaveLength(1);
  });

  it('项目 key 不能读取另一项目的批次详情', async () => {
    const response = await call('GET', `/api/releases/batches/${otherBatch.id}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('project_mismatch');
    expect(response.body.batch).toBeUndefined();
  });

  it.each(MUTATIONS)('项目 key 不能通过 %s 写入另一项目的批次', async suffix => {
    const pathname = suffix ? `/api/releases/batches/${otherBatch.id}${suffix}` : '/api/releases/batches';
    const response = await call('POST', pathname, 'p1', { projectId: 'p2', versionId: 'version-p2', reportId: otherBatch.reportId,
      targetIds: ['p2-a', 'p2-b'], idempotencyKey: 'scope-operation-key' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('project_mismatch');
    expect(service.preflight).not.toHaveBeenCalled();
    expect(service.startRelease).not.toHaveBeenCalled();
    expect(service.startRollback).not.toHaveBeenCalled();
    expect(state.getReleaseBatch(otherBatch.id)?.status).toBe('draft');
  });

  it.each(MUTATIONS)('全局 AI key 必须被每个批次写入口拒绝：%s', async suffix => {
    const pathname = suffix ? `/api/releases/batches/${ownBatch.id}${suffix}` : '/api/releases/batches';
    const response = await call('POST', pathname, 'global-ai', { projectId: 'p1', versionId: 'version-p1', reportId: ownBatch.reportId,
      targetIds: ['p1-a', 'p1-b'], idempotencyKey: 'scope-operation-key' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('project_key_required');
    expect(service.preflight).not.toHaveBeenCalled();
    expect(service.startRelease).not.toHaveBeenCalled();
    expect(service.startRollback).not.toHaveBeenCalled();
    expect(service.cancelRelease).not.toHaveBeenCalled();
    expect(state.getReleaseBatch(ownBatch.id)?.cancelRequested).toBeUndefined();
  });

  it('本项目能创建与预检自己的批次，且 HTTP 不能覆盖服务端固定来源', async () => {
    const created = await call('POST', '/api/releases/batches', 'p1', { projectId: 'p1', versionId: 'version-p1', reportId: ownBatch.reportId,
      targetIds: ['p1-b', 'p1-a'], idempotencyKey: 'http-create-key', commitSha: 'b'.repeat(40),
      source: { projectId: 'p2', artifact: { commitSha: 'b'.repeat(40) } } });
    expect(created.status).toBe(201);
    expect(created.body.batch?.commitSha).toBe(SHA);
    expect(created.body.batch?.source.projectId).toBe('p1');
    expect(created.body.batch?.targets.map(target => target.targetId)).toEqual(['p1-b', 'p1-a']);
    const preflight = await call('POST', `/api/releases/batches/${created.body.batch!.id}/preflight`, 'p1', {});
    expect(preflight.status).toBe(200);
    expect(preflight.body.batch?.status).toBe('ready');
    expect(service.preflight).toHaveBeenCalledTimes(2);
    expect(service.preflight.mock.calls.every(([input]) => input.expectedCommitSha === SHA && input.batchSource.artifact.commitSha === SHA)).toBe(true);
  });

  it.each(['/start', '/targets/p1-a/retry', '/targets/p1-a/rollback'])('排空期间在路由派发前拒绝 %s，附重试时间', async suffix => {
    beginSelfUpdateDrain(Date.now());
    const response = await call('POST', `/api/releases/batches/${ownBatch.id}${suffix}`, 'p1', { idempotencyKey: 'drain-operation-key' });
    expect(response.status).toBe(503);
    expect(response.retryAfter).toBe('60');
    expect(service.startRelease).not.toHaveBeenCalled();
    expect(service.startRollback).not.toHaveBeenCalled();
    expect(state.getReleaseBatch(ownBatch.id)?.requests).toEqual({});
  });

  it('排空期间读取与取消仍可使用，取消不会产生新的发布', async () => {
    beginSelfUpdateDrain(Date.now());
    expect((await call('GET', '/api/releases/batches?projectId=p1')).status).toBe(200);
    expect((await call('GET', `/api/releases/batches/${ownBatch.id}`)).status).toBe(200);
    expect((await call('GET', '/api/releases/batches/accepted-versions?projectId=p1')).status).toBe(200);
    const cancelled = await call('POST', `/api/releases/batches/${ownBatch.id}/cancel`, 'p1', {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.batch?.status).toBe('cancelled');
    expect(service.startRelease).not.toHaveBeenCalled();
    expect(service.startRollback).not.toHaveBeenCalled();
  });
});
