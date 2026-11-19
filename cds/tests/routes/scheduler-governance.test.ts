import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

describe('真实HTTP固定授权与期限', () => {
  let root: string, base: string, state: StateService, server: http.Server;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pin-http-'));
    const config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'fixture',
      portStart: 10001, rootDomains: ['example.test'], previewDomain: 'example.test', sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' } } as CdsConfig;
    state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'branch', projectId: 'default', branch: 'feature', services: {}, status: 'idle', worktreePath: root, createdAt: new Date().toISOString() });
    const shell = new MockShellExecutor();
    const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 25, idleTTLSeconds: 900, tickIntervalSeconds: 60, pinnedBranches: ['branch'] });
    const app = express(); app.use(express.json());
    // Trusted authentication middleware stamps, never request body attributes.
    app.use((req, _res, next) => {
      if (req.headers['x-fixture-role'] === 'owner') Object.assign(req, { _cdsBasicHumanAuth: true, cdsUser: { username: 'owner', isSystemOwner: true } });
      if (req.headers['x-fixture-role'] === 'other-project') Object.assign(req, { cdsProjectKey: { projectId: 'other' } });
      const role = req.headers['x-fixture-role'];
      if (role === 'project-first' || role === 'project-second') {
        Object.assign(req, { cdsProjectKey: { projectId: 'default', keyId: role } });
      }
      if (role === 'global-first' || role === 'global-second') {
        Object.assign(req, { cdsAccess: { keyId: role, access: { projects: 'all' } } });
      }
      if (role === 'session-first' || role === 'session-second') Object.assign(req, { _aiSession: { id: role } });
      next();
    });
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell, root),
      containerService: new ContainerService(shell, config), shell, config, schedulerService: scheduler }));
    server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
  const permanent = { permanent: true, reason: '用户要求长期预览', authorizationRef: '工单 fixture-1' };
  function request(route: string, body: unknown = {}, role = 'agent', method = 'POST', headers = {}) {
    return fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'x-fixture-role': role, ...headers }, body: JSON.stringify(body) });
  }

  it('AI空body默认24小时；AI伪造永久授权被拒绝；旧保护不能被AI覆盖/解除', async () => {
    const created = await request('/scheduler/pin/branch', {}, 'project-first'); expect(created.status).toBe(200);
    const payload = await created.json(); expect(payload.pin.kind).toBe('temporary');
    expect(Date.parse(payload.pin.expiresAt) - Date.parse(payload.pin.createdAt)).toBe(86400000);
    expect((await request('/scheduler/pin/branch', { ...permanent, cdsUser: { isSystemOwner: true } }, 'project-first')).status).toBe(400);
    state.getBranch('branch')!.userPin = undefined;
    expect((await request('/scheduler/unpin/branch', {}, 'project-first')).status).toBe(403);
    expect((await request('/scheduler/pin/branch', {}, 'project-first')).status).toBe(403);
    expect(state.getBranch('branch')!.pinnedByUser).toBe(true);
  });

  it('真实所有者明确永久请求留据，可查看授权与撤销；跨项目和非法期限被拒绝', async () => {
    expect((await request('/scheduler/pin/branch', { ttlSeconds: 604801 })).status).toBe(400);
    expect((await request('/scheduler/pin/branch', {}, 'other-project')).status).toBe(403);
    expect((await request('/scheduler/pin/branch', { permanent: true }, 'owner')).status).toBe(400);
    const authorized = await request('/scheduler/pin/branch', permanent, 'owner', 'POST', { 'x-cds-trigger': 'forged-system', 'x-ai-impersonate': 'forged-person' });
    expect(authorized.status).toBe(200); expect((await authorized.json()).pin.actor).toBe('human:owner');
    const snapshot = await (await fetch(base + '/scheduler/state')).json();
    expect(snapshot.protections).toContainEqual(expect.objectContaining({ source: 'user', active: true,
      pin: expect.objectContaining({ kind: 'permanent', authorizationRef: permanent.authorizationRef }) }));
    expect(state.getActivityLogs('default').some(log => log.type === 'scheduler-pin' && log.pin?.authorizationRef === permanent.authorizationRef)).toBe(true);
    expect((await request('/scheduler/unpin/branch')).status).toBe(403);
    expect((await request('/scheduler/unpin/branch', {}, 'owner')).status).toBe(200);
  });

  it.each([
    ['project-first', 'project-second', 'project-automation:default:project-first'],
    ['global-first', 'global-second', 'global-automation:global-first'],
    ['session-first', 'session-second', 'automation-session:session-first'],
  ])('按认证层的凭据身份维护临时固定（%s）', async (first, second, actor) => {
    const created = await request('/scheduler/pin/branch', { ttlSeconds: 60 }, first);
    expect(created.status).toBe(200);
    expect((await created.json()).pin.actor).toBe(actor);
    expect((await request('/scheduler/pin/branch', { ttlSeconds: 120 }, second)).status).toBe(403);
    expect((await request('/scheduler/unpin/branch', {}, second)).status).toBe(403);
    expect((await request('/scheduler/pin/branch', { ttlSeconds: 120 }, first)).status).toBe(200);
    expect((await request('/scheduler/unpin/branch', {}, first)).status).toBe(200);
  });

  it('未确认身份的临时固定仍有期限，通用身份无权接管已有固定', async () => {
    const created = await request('/scheduler/pin/branch', { ttlSeconds: 60 });
    expect(created.status).toBe(200);
    const { pin } = await created.json();
    expect(Date.parse(pin.expiresAt) - Date.parse(pin.createdAt)).toBe(60000);
    expect((await request('/scheduler/unpin/branch')).status).toBe(403);
    expect((await request('/scheduler/unpin/branch', {}, 'owner')).status).toBe(200);
  });

  it('调试标记也只有临时租约，AI不能借灯泡制造永久固定，不能改旧保护', async () => {
    expect((await request('/branches/branch', { isColorMarked: true, permanent: true }, 'agent', 'PATCH')).status).toBe(200);
    expect(state.getBranch('branch')!.colorMarkPin?.kind).toBe('temporary');
    state.getBranch('branch')!.colorMarkPin = undefined;
    expect((await request('/branches/branch', { isColorMarked: false }, 'agent', 'PATCH')).status).toBe(403);
    expect(state.getBranch('branch')!.isColorMarked).toBe(true);
    expect((await request('/scheduler/config', { maxHotBranches: 26 }, 'owner', 'PUT')).status).toBe(400);
    expect((await request('/scheduler/config', { maxHotBranches: 0 }, 'owner', 'PUT')).status).toBe(400);
    expect((await request('/scheduler/config', { maxHotBranches: 25 }, 'owner', 'PUT')).status).toBe(200);
  });

  it('AI不能复核配置保护；所有者提供明确期限和授权依据后可退役临时固定', async () => {
    const review = { source: 'config', ttlSeconds: 60, reason: '验收结束退役', authorizationRef: 'fixture-owner-approval' };
    expect((await request('/scheduler/pin/branch', review)).status).toBe(403);
    expect((await request('/scheduler/pin/branch', { source: 'config', ttlSeconds: 60 }, 'owner')).status).toBe(400);
    expect((await request('/scheduler/pin/branch', review, 'owner')).status).toBe(200);
    expect(state.getBranch('branch')!.configPinReview).toMatchObject({ kind: 'temporary', configuredBranches: ['branch'], authorizationRef: review.authorizationRef });
    expect(state.getActivityLogs('default').some(log => log.pinSource === 'config' && log.pin?.authorizationRef === review.authorizationRef)).toBe(true);
  });
});
