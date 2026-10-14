import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { BranchOperationCoordinator, pendingDeployBody, pendingDeployRoute } from '../../src/services/branch-operation-coordinator.js';
import { internalPendingReplayAuth } from '../../src/services/internal-pending-replay-auth.js';
import { captureDeploymentInput } from '../../src/services/deployment-input.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

// 原 server/github gate/单服务部署路由与协调器；未启动 Docker，不代替原生完整应用演练。
describe('原服务器 GitHub 模式排队重派', () => {
  let root: string, state: StateService, server: http.Server, base: string;
  let coordinator: BranchOperationCoordinator;
  let app: ReturnType<typeof createServer>, shell: MockShellExecutor;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pending-auth-'));
    for (const key of ['CDS_USERNAME', 'CDS_PASSWORD', 'CDS_SSO_ENABLED', 'CDS_AI_ACCESS_KEY', 'AI_ACCESS_KEY',
      'CDS_AI_EXPLANATION_GATEWAY_URL', 'CDS_AI_EXPLANATION_MODEL']) vi.stubEnv(key, '');
    vi.stubEnv('CDS_AUTH_MODE', 'github'); vi.stubEnv('CDS_GITHUB_CLIENT_ID', 'synthetic-unused');
    vi.stubEnv('CDS_GITHUB_CLIENT_SECRET', 'synthetic-unused'); vi.stubEnv('CDS_REPO_ROOT', root);
    state = new StateService(path.join(root, 'state.json'), root); state.load();
    const now = new Date().toISOString();
    state.addProject({ id: 'p', slug: 'p', name: 'Own', kind: 'shared-service', agentPrebuiltOnly: true, createdAt: now, updatedAt: now });
    state.addBranch({ id: 'b', projectId: 'p', branch: 'main', worktreePath: root, status: 'idle', services: {}, createdAt: now });
    coordinator = new BranchOperationCoordinator(); shell = new MockShellExecutor();
    const config: CdsConfig = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'fixture', portStart: 10001, sharedEnv: {}, jwt: { secret: 'fixture', issuer: 'fixture' }, mode: 'standalone', rootDomains: ['example.test'] };
    app = createServer({ stateService: state, shell, config, branchOperationCoordinator: coordinator,
      worktreeService: new WorktreeService(shell, root), containerService: {} as any,
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as any, bridgeService: {} as any });
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    coordinator?.clearForTest(); await flushAllJsonStateStores(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function claim(captured = false) {
    const active = coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
    const queued = coordinator.begin({ projectId: 'p', branchId: 'b', profileId: 'api', kind: 'deploy-profile',
      trigger: 'webhook', actor: 'original-agent', source: 'original-source', commitSha: 'b'.repeat(40), commitPinned: true });
    if (captured) {
      const input = captureDeploymentInput(state.getBranch('b')!, [{ id: 'api', projectId: 'p', name: 'API', dockerImage: 'fixture',
        command: 'source-build', workDir: '.', containerPort: 3000 }], {}, undefined, 'b'.repeat(40));
      input.agentRequest = true; input.agentPrebuiltGated = true;
      coordinator.rememberDeploymentInput(queued.operationId, queued.generation, input);
    }
    return coordinator.completeAll(active.lease!, 'completed')[0];
  }
  it('没有用户 cookie 的有效重派进入真实路由；普通内部标记仍 401', async () => {
    const pending = claim(); const route = pendingDeployRoute(pending), body = JSON.stringify(pendingDeployBody(pending));
    const denied = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cds-internal': '1' }, body });
    expect(denied.status).toBe(401);
    const allowed = await fetch(base + route, { method: 'POST', headers: internalPendingReplayAuth.headersFor(base + route, pending, 'p'), body });
    expect(allowed.status).toBe(404); expect((await allowed.json()).error).toContain('构建配置');
    // 这是路由接线验证；未配服务的 fixture 没有消费部署，也没有 Docker 执行。
    expect(coordinator.getClaimedPendingReplay(pendingDeployBody(pending).pendingReplay as any)).toBeDefined();
  });
  it('已捕获的机器源码门禁仍沿真实重派生效，不降级成内部真人请求', async () => {
    const pending = claim(true); const route = pendingDeployRoute(pending);
    const response = await fetch(base + route, { method: 'POST', headers: internalPendingReplayAuth.headersFor(base + route, pending, 'p'), body: JSON.stringify(pendingDeployBody(pending)) });
    expect(response.status).toBe(409); expect((await response.json()).error).toBe('agent_prebuilt_only');
  });
  it.each(['project', 'branch', 'profile', 'whole-branch', 'target', 'generation', 'operation', 'trigger', 'query', 'options', 'cancelled', 'consumed', 'superseded', 'expired', 'future', 'port', 'owner'])(
    '原HTTP/coordinator组合拒绝 %s 且不尝试Docker执行', async change => {
      const pending = claim(); const route = pendingDeployRoute(pending);
      const headers = internalPendingReplayAuth.headersFor(base + route, pending, 'p');
      const body: any = pendingDeployBody(pending); let path = route;
      if (change === 'project') headers['x-cds-source-project-id'] = 'other';
      if (change === 'branch') path = '/api/branches/other/deploy/api';
      if (change === 'profile') path = '/api/branches/b/deploy/web';
      if (change === 'whole-branch') path = '/api/branches/b/deploy';
      if (change === 'target') body.commitSha = 'c'.repeat(40);
      if (change === 'generation') body.pendingReplay.generation++;
      if (change === 'operation') body.pendingReplay.operationId = 'other';
      if (change === 'trigger') headers['x-cds-trigger'] = 'manual';
      if (change === 'query') path += '?force=1';
      if (change === 'options') body.targetExecutorId = 'other';
      if (change === 'cancelled') coordinator.cancelBranch('b', 'original cancellation');
      if (change === 'consumed') expect(coordinator.begin({ ...pending.request, pendingReplay: body.pendingReplay }).status).toBe('started');
      if (change === 'superseded') coordinator.begin({ ...pending.request, commitSha: 'c'.repeat(40) });
      if (change === 'owner') state.getBranch('b')!.projectId = 'other';
      if (change === 'port') Object.assign(headers, internalPendingReplayAuth.headersFor('http://127.0.0.1:9' + route, pending, 'p'));
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      if (change === 'expired' || change === 'future') clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (change === 'expired' ? 31_000 : -1_000));
      try {
        const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
        expect(response.status).toBe(401); expect((await response.json()).error).toBe('invalid_pending_replay');
        expect(state.getBranch('b')!.services).toEqual({});
        expect(shell.commands.some(command => /docker (run|rm)|git fetch/.test(command))).toBe(false);
      } finally { clock?.mockRestore(); }
    });

  it('真实非回环连接即使持有本进程有效签名也被拒绝', async () => {
    const address = Object.values(os.networkInterfaces()).flat().find(value => value && !value.internal && value.family === 'IPv4')?.address;
    expect(address, '该负面路径需要实际自有非回环接口，不跳过').toBeDefined();
    const auxiliary = http.createServer(app);
    await new Promise<void>((resolve, reject) => { auxiliary.once('error', reject); auxiliary.listen(0, address!, resolve); });
    try {
      const pending = claim(), route = pendingDeployRoute(pending); const port = (auxiliary.address() as { port: number }).port;
      const headers = internalPendingReplayAuth.headersFor(`http://127.0.0.1:${port}${route}`, pending, 'p');
      const body = JSON.stringify(pendingDeployBody(pending));
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request({ hostname: address, port, path: route, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode!));
        });
        request.setTimeout(5000, () => request.destroy(new Error('自有非回环连接到期'))); request.on('error', reject); request.end(body);
      });
      expect(status).toBe(401); expect(shell.commands.some(command => /docker (run|rm)/.test(command))).toBe(false);
    } finally { auxiliary.closeAllConnections(); await new Promise<void>(resolve => auxiliary.close(() => resolve())); }
  });

  it('原cookie与已有机器Key继续有效，匿名读取仍拒绝', async () => {
    await app.locals.cdsAuthService.bootstrapFirstLocalUser({ username: 'fixture-owner', password: 'fixture-private-password' });
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fixture-owner', password: 'fixture-private-password' }) });
    expect(login.status).toBe(200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(base + '/api/projects', { headers: { cookie } })).status).toBe(200);
    vi.stubEnv('CDS_AI_ACCESS_KEY', 'fixture-private-agent-key');
    expect((await fetch(base + '/api/projects', { headers: { 'x-ai-access-key': 'fixture-private-agent-key' } })).status).toBe(200);
    expect((await fetch(base + '/api/projects')).status).toBe(401);
    const pending = claim(), route = pendingDeployRoute(pending);
    const headers = internalPendingReplayAuth.headersFor(base + route, pending, 'p'); headers.authorization += 'bad'; headers.cookie = cookie;
    expect((await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(pendingDeployBody(pending)) })).status).toBe(401);
  });

  it('坏签名即使附内部标记也被前置门禁拒绝', async () => {
    const pending = claim(); const route = pendingDeployRoute(pending);
    const headers = internalPendingReplayAuth.headersFor(base + route, pending, 'p'); headers.authorization += 'bad';
    const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(pendingDeployBody(pending)) });
    expect(response.status).toBe(401); expect((await response.json()).error).toBe('invalid_pending_replay');
  });
});
