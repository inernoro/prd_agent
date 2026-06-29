import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  clearRunningServiceErrorMessages,
  createBranchRouter,
  shouldSkipFencedDeployCleanupForNewerRuntime,
} from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, CdsConfig } from '../../src/types.js';

function makeConfig(tmpDir: string): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: { MONGODB_HOST: 'db:27017' },
    jwt: { secret: 'test-secret', issuer: 'prdagent' },
  };
}

describe('branch status helpers', () => {
  it('clears stale service errors once a service is running again', () => {
    const entry: BranchEntry = {
      id: 'branch-1',
      projectId: 'default',
      branch: 'main',
      worktreePath: '/tmp/branch-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      services: {
        api: {
          profileId: 'api',
          containerName: 'api-container',
          hostPort: 10001,
          status: 'running',
          errorMessage: '容器 "api-container" 已消失',
        },
        worker: {
          profileId: 'worker',
          containerName: 'worker-container',
          hostPort: 10002,
          status: 'error',
          errorMessage: '启动失败',
        },
      },
    };

    clearRunningServiceErrorMessages(entry);

    expect(entry.services.api.errorMessage).toBeUndefined();
    expect(entry.services.worker.errorMessage).toBe('启动失败');
  });

  it('skips fenced deploy cleanup when a newer runtime became ready', () => {
    expect(shouldSkipFencedDeployCleanupForNewerRuntime(
      {
        lastReadyAt: '2026-06-19T20:11:35.631Z',
        lastDeployAt: '2026-06-19T20:11:35.700Z',
      },
      '2026-06-19T19:45:39.295Z',
    )).toBe(true);
  });

  it('does not skip fenced deploy cleanup without a newer ready runtime', () => {
    expect(shouldSkipFencedDeployCleanupForNewerRuntime(
      { lastReadyAt: '2026-06-19T19:40:00.000Z' },
      '2026-06-19T19:45:39.295Z',
    )).toBe(false);
  });

  it('does not skip fenced deploy cleanup after a later stop', () => {
    expect(shouldSkipFencedDeployCleanupForNewerRuntime(
      {
        lastReadyAt: '2026-06-19T20:11:35.631Z',
        lastStoppedAt: '2026-06-19T20:12:00.000Z',
      },
      '2026-06-19T19:45:39.295Z',
    )).toBe(false);
  });
});

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown, headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw), headers: res.headers }); }
        catch { resolve({ status: res.statusCode!, body: raw, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function seedLegacyDefaultProject(stateService: StateService): void {
  const now = new Date().toISOString();
  stateService.addProject({
    id: 'default',
    slug: 'default',
    name: 'Legacy Default',
    kind: 'git',
    legacyFlag: true,
    createdAt: now,
    updatedAt: now,
  });
}

describe('Branch Routes', () => {
  let tmpDir: string;
  let server: http.Server;
  let mock: MockShellExecutor;
  let stateService: StateService;
  let containerService: ContainerService;
  let serverEventLogStore: ServerEventLogSink;
  let registryNodes: any[];
  let operationEvents: Array<{
    category?: string;
    source?: string;
    severity?: string;
    action: string;
    branchId?: string | null;
    requestId?: string | null;
    operationId?: string | null;
    operationKind?: string | null;
    operationTrigger?: string | null;
    operationActor?: string | null;
    operationSource?: string | null;
    commitSha?: string | null;
    details?: Record<string, unknown>;
  }>;

  beforeEach(async () => {
    // 2026-05-28: 重置 selfStatusCache 单例,避免上个测试残留的 remoteBranches/
    // lastKnownGood 串到本测试。createBranchRouter 会重新 init cache。
    const cacheMod = await import('../../src/services/self-status-cache.js');
    cacheMod.selfStatusCache._resetForTests();
    // 这些是部署/操作-fencing 测试，与分支网络隔离正交：它们用 `docker run -d --name X` 当协调闸门。
    // 隔离开启时 runService 改走 create→connect→start，闸门匹配不到 `docker run -d` 会挂死。故本组
    // 显式关隔离（与 container.test.ts / container-network-isolation.test.ts 同款），隔离 create/start
    // 路径由 container-branch-network-isolation.test.ts 专门覆盖。
    process.env.CDS_BRANCH_NETWORK_ISOLATION = '0';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-routes-'));
    const config = makeConfig(tmpDir);
    mock = new MockShellExecutor();

    // Default mocks
    mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree add/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree remove/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    // 分支级网络隔离（默认开）：runService 会 ensure 分支网 + 跑后 network connect 共享网。
    mock.addResponsePattern(/docker network create/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'true', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: 'log output', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'abc1234 some commit', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc1234', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0 }));

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    // Fresh installs intentionally do not auto-create a default project.
    // This route suite exercises legacy branch APIs, so it seeds the
    // compatibility project explicitly instead of relying on StateService
    // to manufacture one.
    seedLegacyDefaultProject(stateService);

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    containerService = new ContainerService(mock, config);
    (containerService as any).waitForContainerAlive = async () => undefined;
    (containerService as any).waitForReadiness = async () => true;
    registryNodes = [];
    const registry = {
      getAll: () => registryNodes,
      getOnline: () => registryNodes.filter((node) => node.status === 'online'),
      selectExecutor: () => registryNodes.find((node) => node.status === 'online') || null,
    } as any;
    operationEvents = [];
    serverEventLogStore = {
      record(record) {
        operationEvents.push({
          category: record.category,
          source: record.source,
          severity: record.severity,
          action: record.action,
          branchId: record.branchId,
          requestId: record.requestId,
          operationId: record.operationId,
          operationKind: record.operationKind,
          operationTrigger: record.operationTrigger,
          operationActor: record.operationActor,
          operationSource: record.operationSource,
          commitSha: record.commitSha,
          details: record.details,
        });
      },
    };
    const branchOperationCoordinator = new BranchOperationCoordinator(serverEventLogStore);

    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell: mock, config, registry, branchOperationCoordinator, serverEventLogStore,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    delete process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS;
    delete process.env.CDS_BRANCHES_SLOW_MS;
    delete process.env.CDS_BRANCH_NETWORK_ISOLATION;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  // ── Remote branches ──

  describe('GET /api/remote-branches', () => {
    it('should return list of remote branches', async () => {
      const SEP = '<SEP>';
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [`main${SEP}2026-02-12${SEP}Dev${SEP}msg`, `feature/ui${SEP}2026-02-12${SEP}Dev${SEP}msg`].join('\n'),
        stderr: '', exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { branches: Array<{ name: string }> };
      expect(body.branches.map(b => b.name)).toEqual(['main', 'feature/ui']);
    });

    it('first call runs git fetch and reports fetched=true', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { fetched: boolean; cachedAt: number | null };
      expect(body.fetched).toBe(true);
      expect(body.cachedAt).toBeGreaterThan(0);
      expect(mock.commands.some(c => c.includes('git fetch origin --prune'))).toBe(true);
    });

    it('second call within cache window skips git fetch', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await request(server, 'GET', '/api/remote-branches');
      const fetchCallsBefore = mock.commands.filter(c => c.includes('git fetch origin --prune')).length;

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { fetched: boolean; cachedAt: number | null };
      expect(body.fetched).toBe(false);
      expect(body.cachedAt).toBeGreaterThan(0);

      const fetchCallsAfter = mock.commands.filter(c => c.includes('git fetch origin --prune')).length;
      expect(fetchCallsAfter).toBe(fetchCallsBefore);
    });

    it('?nofetch=true skips git fetch on first call', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const res = await request(server, 'GET', '/api/remote-branches?nofetch=true');
      expect(res.status).toBe(200);
      const body = res.body as { fetched: boolean; cachedAt: number | null };
      expect(body.fetched).toBe(false);
      expect(body.cachedAt).toBeNull();
      expect(mock.commands.some(c => c.includes('git fetch origin --prune'))).toBe(false);
    });

    it('persists the remote default branch onto the project', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'repo-proj',
        slug: 'repo-proj',
        name: 'Repo Project',
        kind: 'git',
        repoPath: tmpDir,
        createdAt: now,
        updatedAt: now,
      });
      const SEP = '<SEP>';
      mock.addResponsePattern(/git symbolic-ref --short refs\/remotes\/origin\/HEAD/, () => ({
        stdout: 'origin/master\n',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [`master${SEP}2026-02-12${SEP}Dev${SEP}msg`, `main${SEP}2026-02-11${SEP}Dev${SEP}old`].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/remote-branches?project=repo-proj&nofetch=true');

      expect(res.status).toBe(200);
      expect((res.body as any).defaultBranch).toBe('master');
      expect((res.body as any).branches.find((b: any) => b.name === 'master')?.isDefault).toBe(true);
      expect(stateService.getProject('repo-proj')?.gitDefaultBranch).toBe('master');
    });
  });

  // ── Branch CRUD ──

  describe('POST /api/branches', () => {
    it('should add a new branch', async () => {
      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      expect(res.status).toBe(201);
      expect((res.body as any).branch.id).toBe('feature-test');
    });

    it('should return 400 if branch name missing', async () => {
      const res = await request(server, 'POST', '/api/branches', {});
      expect(res.status).toBe(400);
    });

    it('rejects URL-like branch names before creating a worktree', async () => {
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'https/github.com/inernoro/prd_agent/pull/611',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toBe('invalid_branch_name');
    });

    it('should return 409 if branch already exists', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      expect(res.status).toBe(409);
    });

    it('returns 409 when a branch with the same git name exists under the legacy id after legacyFlag flipped', async () => {
      // Regression for the "two main branches" phantom duplicate bug:
      // simulate a project whose `legacyFlag` was flipped from true to
      // false while an existing entry was still stored under the bare
      // slug id. A subsequent POST must refuse to spawn a phantom
      // twin — not succeed with a different id.
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'flipped',
        slug: 'flipped',
        name: 'Flipped',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
        legacyFlag: false,
      });
      // Seed a pre-existing branch under the *legacy* id shape.
      stateService.addBranch({
        id: 'main',
        projectId: 'flipped',
        branch: 'main',
        worktreePath: '/tmp/wt/flipped/main',
        services: {},
        status: 'idle',
        createdAt: now,
      });
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'main',
        projectId: 'flipped',
      });
      expect(res.status).toBe(409);
      // Error must reference the *existing* id, not the new-formula one.
      expect((res.body as any).error).toContain('"main"');
    });

    it('refuses to deploy a branch that was already stored with an invalid URL-like name', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'bad-url-branch',
        projectId: 'default',
        branch: 'https/github.com/inernoro/prd_agent/pull/611',
        worktreePath: '/tmp/wt/bad-url-branch',
        services: {},
        status: 'idle',
        createdAt: now,
      });

      const res = await request(server, 'POST', '/api/branches/bad-url-branch/deploy');

      expect(res.status).toBe(400);
      expect((res.body as any).error).toBe('invalid_branch_name');
    });

    // 极速版部署不再硬闸门(用户 2026-06-23 决策:没有镜像逐组件回退固定主分支,不硬失败)。
    // 镜像可用性由 container.ts runService 处理(本 commit 镜像拉不到→回退主分支镜像),
    // 单测见 tests/services/ci-prebuilt-express.test.ts 的 fallbackImage 用例。
  });

  describe('分支级额外服务 /api/branches/:id/extra-services', () => {
    const extraSvc = (id: string) => ({ id, name: id, dockerImage: 'nginx:alpine', containerPort: 80, prebuiltImage: true });
    function seedBranch(id: string, projectId = 'default') {
      stateService.addBranch({ id, projectId, branch: id, worktreePath: `/tmp/wt/${id}`, services: {}, status: 'idle', createdAt: new Date().toISOString() });
    }

    it('GET returns [] for a branch with no extras', async () => {
      seedBranch('b1');
      const res = await request(server, 'GET', '/api/branches/b1/extra-services');
      expect(res.status).toBe(200);
      expect((res.body as any).extraProfiles).toEqual([]);
    });

    it('PUT declares an extra service; GET reflects it; a sibling stays empty (zero cross-impact)', async () => {
      seedBranch('b1'); seedBranch('b2');
      const put = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('demo-extra')] });
      expect(put.status).toBe(200);
      expect((put.body as any).count).toBe(1);
      expect((put.body as any).redeployTriggered).toBe(false);

      const g1 = await request(server, 'GET', '/api/branches/b1/extra-services');
      expect((g1.body as any).extraProfiles.map((p: any) => p.id)).toEqual(['demo-extra']);
      const g2 = await request(server, 'GET', '/api/branches/b2/extra-services');
      expect((g2.body as any).extraProfiles).toEqual([]); // sibling untouched
    });

    it('preserves branch-local routing/ordering/readiness metadata (pathPrefixes/dependsOn/readinessProbe/startupSignal)', async () => {
      seedBranch('b1');
      const put = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{
          id: 'extra-api', name: 'extra-api', dockerImage: 'nginx:alpine', containerPort: 8080,
          pathPrefixes: ['/api/', '/graphql'],
          dependsOn: ['mysql', 'redis'],
          readinessProbe: { path: '/health', intervalSeconds: 3, timeoutSeconds: 120, noHttp: false },
          startupSignal: 'Network:',
        }],
      });
      expect(put.status).toBe(200);
      const saved = stateService.getBranch('b1')!.extraProfiles!.find((p) => p.id === 'extra-api')!;
      expect(saved.pathPrefixes).toEqual(['/api/', '/graphql']);
      expect(saved.dependsOn).toEqual(['mysql', 'redis']);
      expect(saved.readinessProbe).toEqual({ path: '/health', intervalSeconds: 3, timeoutSeconds: 120 });
      expect(saved.startupSignal).toBe('Network:');
    });

    it('preserves containerWorkDir and rejects an illegal one (Codex P2)', async () => {
      seedBranch('b1');
      // valid container-absolute path is kept
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'svc', name: 'svc', dockerImage: 'nginx:alpine', containerPort: 80, containerWorkDir: '/srv/app' }],
      });
      expect(ok.status).toBe(200);
      expect(stateService.getBranch('b1')!.extraProfiles!.find((p) => p.id === 'svc')!.containerWorkDir).toBe('/srv/app');
      // shell-metachar / relative / traversal rejected
      for (const bad of ['app', '/srv/"; id', '/srv/../etc', '/a$(x)']) {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services', {
          extraProfiles: [{ id: 'svc', name: 'svc', dockerImage: 'nginx:alpine', containerPort: 80, containerWorkDir: bad }],
        });
        expect(res.status).toBe(400);
        expect(String((res.body as any).error)).toContain('containerWorkDir');
      }
    });

    it('rejects an extra id that collides with a project profile', async () => {
      stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default' });
      seedBranch('b1');
      const res = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('api')] });
      expect(res.status).toBe(400);
      expect(String((res.body as any).error)).toContain('撞名');
    });

    it('rejects invalid id / missing image / bad port', async () => {
      seedBranch('b1');
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: '-bad', dockerImage: 'x', containerPort: 80 }] })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', containerPort: 80 }] })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'x', containerPort: 0 }] })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: 'notarray' })).status).toBe(400);
    });

    it('rejects a dockerImage containing host-shell metacharacters (Codex P1 boundary defense)', async () => {
      seedBranch('b1');
      for (const bad of ['evil:latest; rm -rf /', 'img$(whoami)', 'img`id`', 'a b', 'img|cat', 'img&background']) {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: bad, containerPort: 80 }] });
        expect(res.status).toBe(400);
        expect(String((res.body as any).error)).toContain('dockerImage');
      }
      // A normal registry/namespace/repo:tag@digest reference is accepted.
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'ghcr.io/acme/api:1.2.3', containerPort: 80 }] });
      expect(ok.status).toBe(200);
    });

    it('rejects a workDir containing host-shell metacharacters or .. traversal (Codex P1 boundary defense)', async () => {
      seedBranch('b1');
      for (const bad of ['svc";id;"', 'a$(whoami)', 'p`id`', 'has space', 'a|b', 'x&y', '../../etc', 'a/../../b']) {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'img', containerPort: 80, workDir: bad }] });
        expect(res.status).toBe(400);
        expect(String((res.body as any).error)).toContain('workDir');
      }
      // A normal relative subdir is accepted (empty workDir也合法，下方一并验证)。
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'img', containerPort: 80, workDir: 'services/api' }] });
      expect(ok.status).toBe(200);
      const okEmpty = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'img', containerPort: 80 }] });
      expect(okEmpty.status).toBe(200);
    });

    it('PUT [] clears extras', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('demo-extra')] });
      const clr = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [] });
      expect((clr.body as any).count).toBe(0);
      expect(stateService.getBranch('b1')!.extraProfiles).toBeUndefined();
    });

    it('?redeploy=1 reports redeployTriggered only after the self-deploy is accepted (200)', async () => {
      seedBranch('b1');
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        // deploy endpoint accepts → streams SSE 200
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;
      try {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services?redeploy=1', { extraProfiles: [extraSvc('demo-extra')] });
        expect(res.status).toBe(200);
        expect((res.body as any).redeployTriggered).toBe(true);
        expect(calls.some((u) => u.includes('/api/branches/b1/deploy'))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('?redeploy=1 does NOT claim triggered when the self-deploy is rejected (423 paused) — surfaces the rejection', async () => {
      seedBranch('b1');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: '分支已暂停' }), { status: 423 })) as typeof fetch;
      try {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services?redeploy=1', { extraProfiles: [extraSvc('demo-extra')] });
        expect(res.status).toBe(200);
        // The extra service is still persisted...
        expect((res.body as any).count).toBe(1);
        // ...but redeploy must NOT be reported as triggered, and the rejection is surfaced.
        expect((res.body as any).redeployTriggered).toBe(false);
        expect((res.body as any).redeployRejected?.status).toBe(423);
        expect(String((res.body as any).redeployRejected?.message)).toContain('暂停');
        expect(String((res.body as any).hint)).toContain('未成功');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('strips env mask sentinels on PUT: reuses the prior real value, drops sentinels with no prior (Bugbot Medium)', async () => {
      seedBranch('b1');
      // First PUT establishes a real secret value for SECRET_KEY.
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { SECRET_KEY: 'real-secret', PUBLIC: 'v1' } }],
      });
      // Second PUT comes back with the masked sentinel for SECRET_KEY (GET→edit→PUT round trip) plus a
      // brand-new key that is itself a sentinel (no prior value).
      const res = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { SECRET_KEY: '***[masked]***', PUBLIC: 'v2', BRAND_NEW: '***' } }],
      });
      expect(res.status).toBe(200);
      const env = (stateService.getBranch('b1')!.extraProfiles![0].env)!;
      expect(env.SECRET_KEY).toBe('real-secret'); // masked → reused real prior value, NOT the literal sentinel
      expect(env.PUBLIC).toBe('v2');              // normal edit persists
      expect('BRAND_NEW' in env).toBe(false);     // sentinel with no prior → dropped, never persisted literally
    });

    it('merges env on PUT: omitted env keeps prior secrets, partial env preserves unmentioned keys (Bugbot High)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { SECRET_KEY: 'real-secret', OTHER: 'keep-me' } }],
      });
      // Re-declare the profile WITHOUT env at all → prior env must be preserved (not dropped).
      const r1 = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      expect(r1.status).toBe(200);
      let env = stateService.getBranch('b1')!.extraProfiles![0].env!;
      expect(env.SECRET_KEY).toBe('real-secret');
      expect(env.OTHER).toBe('keep-me');
      // Partial env (only one key) → the unmentioned prior key must still survive (merge, not replace).
      const r2 = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { OTHER: 'updated' } }],
      });
      expect(r2.status).toBe(200);
      env = stateService.getBranch('b1')!.extraProfiles![0].env!;
      expect(env.SECRET_KEY).toBe('real-secret'); // preserved despite being omitted this time
      expect(env.OTHER).toBe('updated');          // updated value applied
    });

    it('redacts sensitive env in GET/PUT responses but keeps state raw (Codex P1)', async () => {
      seedBranch('b1');
      const put = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { API_TOKEN: 'tok_secretvalue', PUBLIC_URL: 'https://example.com' } }],
      });
      expect(put.status).toBe(200);
      // PUT response masks the sensitive value, leaves non-sensitive intact.
      const putEnv = (put.body as any).extraProfiles[0].env;
      expect(putEnv.API_TOKEN).toBe('***');
      expect(putEnv.PUBLIC_URL).toBe('https://example.com');
      // GET response is masked too.
      const get = await request(server, 'GET', '/api/branches/b1/extra-services');
      expect((get.body as any).extraProfiles[0].env.API_TOKEN).toBe('***');
      // But the persisted state keeps the real value (deploy reads raw env from state).
      expect(stateService.getBranch('b1')!.extraProfiles![0].env!.API_TOKEN).toBe('tok_secretvalue');
    });

    it('masks extra-service env in the profile-overrides payload (Codex P1)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { API_TOKEN: 'tok_secretvalue', PUBLIC_URL: 'https://example.com' } }],
      });
      const res = await request(server, 'GET', '/api/branches/b1/profile-overrides');
      expect(res.status).toBe(200);
      const row = (res.body as any).profiles.find((p: any) => p.profileId === 'demo-extra');
      expect(row).toBeTruthy();
      // baseline + effective env both masked for the branch-local extra profile.
      expect(row.baseline.env.API_TOKEN).toBe('***');
      expect(row.baseline.env.PUBLIC_URL).toBe('https://example.com');
      expect(row.effective.env.API_TOKEN).toBe('***');
      // State still holds the real value (deploy reads raw).
      expect(stateService.getBranch('b1')!.extraProfiles![0].env!.API_TOKEN).toBe('tok_secretvalue');
    });

    it('404 for unknown branch', async () => {
      expect((await request(server, 'GET', '/api/branches/nope/extra-services')).status).toBe(404);
      expect((await request(server, 'PUT', '/api/branches/nope/extra-services', { extraProfiles: [] })).status).toBe(404);
    });
  });

  describe('GET /api/branches', () => {
    it('should return empty branches initially', async () => {
      const res = await request(server, 'GET', '/api/branches');
      expect(res.status).toBe(200);
      expect((res.body as any).branches).toEqual([]);
      expect((res.body as any).defaultBranch).toBeNull();
    });

    it('should return added branches', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'main' });
      const res = await request(server, 'GET', '/api/branches');
      expect((res.body as any).branches).toHaveLength(1);
      expect((res.body as any).branches[0].id).toBe('main');
    });

    it('returns cached branch state by default without probing Docker', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'cached-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'cached-main'),
        status: 'running',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-cached-main-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        createdAt: now,
      });

      const res = await request(server, 'GET', '/api/branches?project=default');

      expect(res.status).toBe(200);
      expect((res.body as any).branches[0].services.api.status).toBe('running');
      expect(mock.commands.some((cmd) => cmd.includes('docker ps'))).toBe(false);
      expect(mock.commands.some((cmd) => cmd.includes('git log -1'))).toBe(false);
    });

    it('records timing headers and slow diagnostics for default branch snapshots without live probing', async () => {
      process.env.CDS_BRANCHES_SLOW_MS = '0';
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'timed-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'timed-main'),
        status: 'running',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-timed-main-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        createdAt: now,
      });

      const res = await request(server, 'GET', '/api/branches?project=default', undefined, {
        'X-CDS-Request-Id': 'req-branches-timing',
      });

      expect(res.status).toBe(200);
      expect(String(res.headers['server-timing'])).toContain('getState;dur=');
      expect(String(res.headers['server-timing'])).toContain('liveSkipped;dur=');
      expect(mock.commands.some((cmd) => cmd.includes('docker ps'))).toBe(false);
      expect(mock.commands.some((cmd) => cmd.includes('git log -1'))).toBe(false);
      const slowEvent = operationEvents.find((event) => event.action === 'branches.list.slow');
      expect(slowEvent?.source).toBe('api.branches');
      expect(slowEvent?.requestId).toBe('req-branches-timing');
      expect(slowEvent?.details?.live).toBe(false);
      expect(slowEvent?.details?.branchCount).toBeGreaterThanOrEqual(1);
      expect((slowEvent?.details?.timings as Record<string, number>)?.total).toBeGreaterThanOrEqual(0);
    });

    it('live=true explicitly reconciles branch state with Docker', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'live-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'live-main'),
        status: 'running',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-live-main-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        createdAt: now,
      });
      mock.addResponsePattern(/docker ps --format/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const res = await request(server, 'GET', '/api/branches?project=default&live=true');

      expect(res.status).toBe(200);
      expect((res.body as any).branches[0].services.api.status).toBe('stopped');
      expect(mock.commands.some((cmd) => cmd.includes('docker ps'))).toBe(true);
    });

    it('P4 Part 3b: filters by ?project= query param', async () => {
      // The migration creates a legacy 'default' project automatically,
      // but we need an 'alt' project to exist before POST /branches
      // will accept a branch stamped with projectId='alt'.
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt',
        slug: 'alt',
        name: 'Alt Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      // Seed: one branch on the legacy default project, one on 'alt'
      await request(server, 'POST', '/api/branches', {
        branch: 'legacy-branch',
      });
      await request(server, 'POST', '/api/branches', {
        branch: 'alt-branch',
        projectId: 'alt',
      });

      // Default filter → only legacy
      const legacyRes = await request(server, 'GET', '/api/branches?project=default');
      const legacyBranches = (legacyRes.body as any).branches;
      expect(legacyBranches.map((b: any) => b.id)).toEqual(['legacy-branch']);

      // Alt filter → only alt. Non-legacy projects auto-prefix branch
      // IDs with the project slug so two projects can share a branch
      // name (e.g. both having "main"); the legacy project keeps the
      // bare slug for back-compat.
      const altRes = await request(server, 'GET', '/api/branches?project=alt');
      const altBranches = (altRes.body as any).branches;
      expect(altBranches.map((b: any) => b.id)).toEqual(['alt-alt-branch']);

      stateService.addProject({
        id: 'p-alt-slug',
        slug: 'alt-slug',
        name: 'Alt Slug Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      await request(server, 'POST', '/api/branches', {
        branch: 'slug-branch',
        projectId: 'p-alt-slug',
      });
      const altSlugRes = await request(server, 'GET', '/api/branches?project=alt-slug');
      const altSlugBranches = (altSlugRes.body as any).branches;
      expect(altSlugBranches.map((b: any) => b.id)).toEqual(['alt-slug-slug-branch']);

      // No filter → both
      const allRes = await request(server, 'GET', '/api/branches');
      expect((allRes.body as any).branches).toHaveLength(3);
    });

    it('P4 Part 3b: POST rejects an unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'x',
        projectId: 'no-such-project',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });

    it('P4 Part 3b: POST stamps the projectId onto the created branch', async () => {
      // 'alt' project will exist because addBranch pre-validates it.
      // We use the default project id to exercise the happy path since
      // that's guaranteed to exist after StateService.migrateProjects().
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'stamped',
        projectId: 'default',
      });
      expect(res.status).toBe(201);
      expect((res.body as any).branch.projectId).toBe('default');
    });

    // P4 Part 18 (G1.5): a branch cannot be created under a project
    // whose clone hasn't finished. The guard triggers on any
    // non-'ready' cloneStatus and preserves legacy projects (whose
    // cloneStatus is simply absent) unchanged.
    describe('P4 Part 18 (G1.5): project not-ready guard', () => {
      const NOW = new Date().toISOString();

      function addProject(id: string, cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error', cloneError?: string) {
        stateService.addProject({
          id,
          slug: id,
          name: id,
          kind: 'git',
          createdAt: NOW,
          updatedAt: NOW,
          ...(cloneStatus ? { cloneStatus } : {}),
          ...(cloneError ? { cloneError } : {}),
          ...(cloneStatus ? { repoPath: `/test-repos/${id}` } : {}),
        });
      }

      it('refuses with 409 when cloneStatus is pending', async () => {
        addProject('p-pending', 'pending');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-pending',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).error).toBe('project_not_ready');
        expect((res.body as any).cloneStatus).toBe('pending');
      });

      it('refuses with 409 when cloneStatus is cloning', async () => {
        addProject('p-cloning', 'cloning');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-cloning',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).cloneStatus).toBe('cloning');
      });

      it('refuses with 409 when cloneStatus is error and surfaces cloneError', async () => {
        addProject('p-error', 'error', 'fatal: repository not found');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-error',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).cloneStatus).toBe('error');
        expect((res.body as any).message).toContain('fatal: repository not found');
      });

      it('allows when cloneStatus is ready', async () => {
        addProject('p-ready', 'ready');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'ready-branch',
          projectId: 'p-ready',
        });
        expect(res.status).toBe(201);
      });

      it('legacy project (no cloneStatus) is unaffected by the guard', async () => {
        // The migration creates 'default' without cloneStatus — legacy
        // single-repo behaviour. POST /branches should still work.
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'legacy-flow',
          projectId: 'default',
        });
        expect(res.status).toBe(201);
      });
    });
  });

  describe('POST /api/branches/:id/pull', () => {
    it('should pull latest code', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/pull');
      expect(res.status).toBe(200);
      expect((res.body as any).head).toBeDefined();
      expect(stateService.getBranch('feature-test')?.lastPullAt).toBeDefined();
      expect(stateService.getProject('default')?.lastPullAt).toBeDefined();
    });

    it('pulls a real git project branch named cds-managed-runtime', async () => {
      stateService.addBranch({
        id: 'regular-runtime',
        projectId: 'default',
        branch: 'cds-managed-runtime',
        worktreePath: path.join(tmpDir, 'worktrees', 'regular-runtime'),
        status: 'running',
        services: {},
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        githubCommitSha: 'abc1234',
      });
      mock.commands.length = 0;

      const res = await request(server, 'POST', '/api/branches/regular-runtime/pull');

      expect(res.status).toBe(200);
      expect((res.body as any).skipped).toBeUndefined();
      expect(mock.commands.some(command => command.includes('git fetch'))).toBe(true);
    });

    it('skips pull only for the shared-service synthetic cds-managed-runtime branch', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'shared-sidecar-pool',
        slug: 'shared-sidecar-pool',
        name: 'Shared Sidecar Pool',
        kind: 'shared-service',
        createdAt: now,
        updatedAt: now,
      });
      stateService.addBranch({
        id: 'shared-runtime',
        projectId: 'shared-sidecar-pool',
        branch: 'cds-managed-runtime',
        worktreePath: path.join(tmpDir, 'worktrees', 'shared-runtime'),
        status: 'running',
        services: {},
        createdAt: now,
        lastAccessedAt: now,
        githubCommitSha: 'cds-managed-runtime',
      });
      mock.commands.length = 0;

      const res = await request(server, 'POST', '/api/branches/shared-runtime/pull');

      expect(res.status).toBe(200);
      expect((res.body as any).skipped).toBe(true);
      expect((res.body as any).reason).toBe('synthetic-cds-managed-runtime');
      expect(mock.commands.some(command => command.includes('git fetch'))).toBe(false);
    });

    it('does not skip pull when only the synthetic SHA sentinel matches', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'shared-sidecar-pool',
        slug: 'shared-sidecar-pool',
        name: 'Shared Sidecar Pool',
        kind: 'shared-service',
        createdAt: now,
        updatedAt: now,
      });
      stateService.addBranch({
        id: 'shared-runtime-stale-sha',
        projectId: 'shared-sidecar-pool',
        branch: 'feature/runtime',
        worktreePath: path.join(tmpDir, 'worktrees', 'shared-runtime-stale-sha'),
        status: 'running',
        services: {},
        createdAt: now,
        lastAccessedAt: now,
        githubCommitSha: 'cds-managed-runtime',
      });
      mock.commands.length = 0;

      const res = await request(server, 'POST', '/api/branches/shared-runtime-stale-sha/pull');

      expect(res.status).toBe(200);
      expect((res.body as any).skipped).toBeUndefined();
      expect(mock.commands.some(command => command.includes('git fetch'))).toBe(true);
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/pull');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/branches/:id/stop', () => {
    it('should stop all services', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/stop');
      expect(res.status).toBe(200);
      expect(stateService.getBranch('feature-test')?.lastStopSource).toBe('user');
      expect(stateService.getBranch('feature-test')?.lastStopReason).toBe('用户手动停止');
      const operationActions = operationEvents
        .filter((event) => event.branchId === 'feature-test')
        .map((event) => event.action);
      expect(operationActions).toContain('branch.operation.started');
      expect(operationActions).toContain('branch.operation.completed');
    });

    it('attributes webhook-triggered stops to webhook instead of user', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/webhook-stop' });
      const res = await request(
        server,
        'POST',
        '/api/branches/feature-webhook-stop/stop',
        undefined,
        { 'X-CDS-Trigger': 'webhook' },
      );
      expect(res.status).toBe(200);
      expect(stateService.getBranch('feature-webhook-stop')?.lastStopSource).toBe('webhook');
      expect(stateService.getBranch('feature-webhook-stop')?.lastStopReason).toBe('GitHub webhook 触发停止');
    });

    it('preserves webhook attribution when stopping a remote executor branch', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'remote-webhook-stop',
        projectId: 'default',
        branch: 'feature/remote-webhook-stop',
        worktreePath: path.join(tmpDir, 'worktrees', 'remote-webhook-stop'),
        status: 'running',
        createdAt: now,
        executorId: 'exec-1',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-remote-webhook-stop-api',
            hostPort: 10001,
            status: 'running',
          },
        },
      });
      registryNodes.push({
        id: 'exec-1',
        host: '127.0.0.1',
        port: 9101,
        status: 'online',
        role: 'remote',
        labels: [],
        branches: ['remote-webhook-stop'],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 },
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        registeredAt: now,
        lastHeartbeat: now,
      });
      const fetchCalls: Array<{ url: string; body: any }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      try {
        const res = await request(
          server,
          'POST',
          '/api/branches/remote-webhook-stop/stop',
          undefined,
          { 'X-CDS-Trigger': 'webhook' },
        );

        expect(res.status).toBe(200);
        expect(fetchCalls[0]?.body?.trigger).toBe('webhook');
        expect(stateService.getBranch('remote-webhook-stop')?.lastStopSource).toBe('webhook');
        expect(stateService.getBranch('remote-webhook-stop')?.lastStopReason).toContain('GitHub webhook 触发停止');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('POST /api/branches/cleanup-damaged-containers', () => {
    it('removes only non-running damaged services and records branch operations', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'damaged-branch',
        projectId: 'default',
        branch: 'feature/damaged',
        worktreePath: path.join(tmpDir, 'worktrees', 'damaged-branch'),
        status: 'error',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'missing-api',
            hostPort: 10001,
            status: 'error',
          },
          web: {
            profileId: 'web',
            containerName: 'running-web',
            hostPort: 10002,
            status: 'running',
          },
        },
      });
      mock.addResponse('docker ps --format "{{.Names}}"', {
        stdout: 'running-web\n',
        stderr: '',
        exitCode: 0,
      });

      const res = await request(server, 'POST', '/api/branches/cleanup-damaged-containers');

      expect(res.status).toBe(200);
      expect((res.body as any).removedCount).toBe(1);
      expect((res.body as any).skippedRunningCount).toBe(1);
      const branch = stateService.getBranch('damaged-branch')!;
      expect(branch.services.api).toBeUndefined();
      expect(branch.services.web).toBeDefined();
      const cleanupEvent = operationEvents.find((event) => event.source === 'bulk-damaged-container-cleanup');
      expect(cleanupEvent?.action).toBe('app.damaged-containers.cleanup');
      expect(cleanupEvent?.details?.removed).toEqual([
        expect.objectContaining({ branchId: 'damaged-branch', profileId: 'api', containerName: 'missing-api' }),
      ]);
      expect(cleanupEvent?.details?.skippedRunning).toEqual([
        expect.objectContaining({ branchId: 'damaged-branch', profileId: 'web', containerName: 'running-web' }),
      ]);
      const operationActions = operationEvents
        .filter((event) => event.branchId === 'damaged-branch')
        .map((event) => event.action);
      expect(operationActions).toContain('branch.operation.started');
      expect(operationActions).toContain('branch.operation.completed');
    });

    it('keeps building, starting, restarting, and actually running services during damaged cleanup', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'mixed-damaged',
        projectId: 'default',
        branch: 'feature/mixed-damaged',
        worktreePath: path.join(tmpDir, 'worktrees', 'mixed-damaged'),
        status: 'error',
        createdAt: now,
        services: {
          missing: {
            profileId: 'missing',
            containerName: 'missing-container',
            hostPort: 10001,
            status: 'error',
          },
          building: {
            profileId: 'building',
            containerName: 'building-container',
            hostPort: 10002,
            status: 'building',
          },
          starting: {
            profileId: 'starting',
            containerName: 'starting-container',
            hostPort: 10003,
            status: 'starting',
          },
          restarting: {
            profileId: 'restarting',
            containerName: 'restarting-container',
            hostPort: 10004,
            status: 'restarting',
          },
          staleButRunning: {
            profileId: 'staleButRunning',
            containerName: 'stale-running-container',
            hostPort: 10005,
            status: 'error',
          },
        },
      });
      mock.addResponse('docker ps --format "{{.Names}}"', {
        stdout: 'stale-running-container\n',
        stderr: '',
        exitCode: 0,
      });

      const res = await request(server, 'POST', '/api/branches/cleanup-damaged-containers');

      expect(res.status).toBe(200);
      expect((res.body as any).removedCount).toBe(1);
      expect((res.body as any).skippedRunningCount).toBe(4);
      const branch = stateService.getBranch('mixed-damaged')!;
      expect(Object.keys(branch.services).sort()).toEqual([
        'building',
        'restarting',
        'staleButRunning',
        'starting',
      ]);
      expect(mock.commands.some((command) => command.includes('docker rm missing-container'))).toBe(true);
      expect(mock.commands.some((command) => command.includes('docker rm building-container'))).toBe(false);
      expect(mock.commands.some((command) => command.includes('docker rm starting-container'))).toBe(false);
      expect(mock.commands.some((command) => command.includes('docker rm restarting-container'))).toBe(false);
      expect(mock.commands.some((command) => command.includes('docker rm stale-running-container'))).toBe(false);
      const cleanupEvent = operationEvents.find((event) => event.source === 'bulk-damaged-container-cleanup');
      expect(cleanupEvent?.details?.removed).toEqual([
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'missing', containerName: 'missing-container' }),
      ]);
      expect(cleanupEvent?.details?.skippedRunning).toEqual(expect.arrayContaining([
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'building', containerName: 'building-container' }),
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'starting', containerName: 'starting-container' }),
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'restarting', containerName: 'restarting-container' }),
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'staleButRunning', containerName: 'stale-running-container' }),
      ]));
    });
  });

  describe('POST /api/branches/cleanup-orphan-containers', () => {
    it('runs orphan removals through branch operation fencing and container diagnostics', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'orphan-host',
        projectId: 'default',
        branch: 'feature/orphan-host',
        worktreePath: path.join(tmpDir, 'worktrees', 'orphan-host'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      mock.addResponsePattern(/docker ps -a --filter "label=cds\.managed=true"/, () => ({
        stdout: [
          'orphan-api|exited|cds.managed=true,cds.type=app,cds.branch.id=orphan-host,cds.profile.id=api,cds.network=cds-network',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const res = await request(server, 'POST', '/api/branches/cleanup-orphan-containers?includeStopped=true');

      expect(res.status).toBe(200);
      expect((res.body as any).removed).toEqual([
        expect.objectContaining({ branchId: 'orphan-host', profileId: 'api', containerName: 'orphan-api' }),
      ]);
      const opEvents = operationEvents.filter((event) => event.branchId === 'orphan-host');
      const started = opEvents.find((event) => event.action === 'branch.operation.started');
      const completed = opEvents.find((event) => event.action === 'branch.operation.completed');
      expect(started?.details).toMatchObject({
        kind: 'cleanup-orphans',
        source: 'api.cleanup-orphan-containers',
      });
      expect(completed?.operationId).toBe(started?.operationId);
      expect(mock.commands.some((command) => command.includes('docker stop orphan-api'))).toBe(true);
      expect(mock.commands.some((command) => command.includes('docker rm orphan-api'))).toBe(true);
    });
  });

  describe('POST /api/cleanup-cross-project-services', () => {
    it('skips polluted service cleanup while the branch has an active lifecycle operation', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'cross-cleanup-busy',
        projectId: 'default',
        branch: 'feature/cross-cleanup-busy',
        worktreePath: path.join(tmpDir, 'worktrees', 'cross-cleanup-busy'),
        status: 'idle',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-cross-cleanup-busy-api',
            hostPort: 10001,
            status: 'idle',
          },
          foreign: {
            profileId: 'foreign',
            containerName: 'cds-cross-cleanup-busy-foreign',
            hostPort: 10002,
            status: 'running',
          },
        },
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-cross-cleanup-busy-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-cross-cleanup-busy', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(server, 'POST', '/api/branches/cross-cleanup-busy/deploy');
      try {
        await runStarted;

        const cleanup = await request(
          server,
          'POST',
          '/api/cleanup-cross-project-services',
          undefined,
          { 'X-CDS-Request-Id': 'req-cross-cleanup' },
        );

        expect(cleanup.status).toBe(200);
        expect((cleanup.body as any).trimmedCount).toBe(0);
        expect((cleanup.body as any).skippedBusyCount).toBe(1);
        expect(stateService.getBranch('cross-cleanup-busy')?.services.foreign).toBeTruthy();
        expect(mock.commands.some((command) => command.includes('docker rm -f cds-cross-cleanup-busy-foreign'))).toBe(false);
        const skipped = operationEvents.find((event) => event.action === 'app.cross-project-service.cleanup-skipped');
        expect(skipped?.requestId).toBe('req-cross-cleanup');
        expect(skipped?.branchId).toBe('cross-cleanup-busy');
        expect(skipped?.operationKind).toBe('deploy');
      } finally {
        releaseRun();
      }
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
    });
  });

  describe('POST /api/branches/:id/force-rebuild/:profileId', () => {
    it('can reserve the next deploy as the same operation chain', async () => {
      const now = new Date().toISOString();
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      stateService.addBranch({
        id: 'force-branch',
        projectId: 'default',
        branch: 'feature/force',
        worktreePath: path.join(tmpDir, 'worktrees', 'force-branch'),
        status: 'running',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'force-api',
            hostPort: 10001,
            status: 'running',
          },
        },
      });
      mock.addResponsePattern(/find .* -type d .* echo done/, () => ({ stdout: 'done\n', stderr: '', exitCode: 0 }));

      const res = await request(server, 'POST', '/api/branches/force-branch/force-rebuild/api?reserveDeploy=1');

      expect(res.status).toBe(200);
      expect((res.body as any).reserveDeploy).toBe(true);
      expect((res.body as any).operationId).toMatch(/^op_/);
      const actions = operationEvents
        .filter((event) => event.branchId === 'force-branch')
        .map((event) => event.action);
      expect(actions).toContain('branch.operation.started');
      expect(actions).toContain('branch.operation.completed');
      expect(actions).toContain('branch.operation.queued');
    });

    it('keeps force-rebuild deploy continuation on the same operation while merging webhook deploys behind it', async () => {
      const now = new Date().toISOString();
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      stateService.addBranch({
        id: 'force-webhook',
        projectId: 'default',
        branch: 'feature/force-webhook',
        worktreePath: path.join(tmpDir, 'worktrees', 'force-webhook'),
        status: 'running',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-force-webhook-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();
      mock.addResponsePattern(/find .* -type d .* echo done/, () => ({ stdout: 'done\n', stderr: '', exitCode: 0 }));

      const fetchCalls: Array<{ url: string; body: unknown; requestId?: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          requestId: init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>)['X-CDS-Request-Id']
            : undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const force = await request(
          server,
          'POST',
          '/api/branches/force-webhook/force-rebuild/api?reserveDeploy=1',
          undefined,
          { 'X-CDS-Request-Id': 'req-force' },
        );
        expect(force.status).toBe(200);
        const forceOperationId = (force.body as any).operationId;
        expect(forceOperationId).toMatch(/^op_/);

        const webhook = await request(
          server,
          'POST',
          '/api/branches/force-webhook/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-force-webhook' },
        );
        expect(String(webhook.body)).toContain('merged');
        expect(fetchCalls).toEqual([]);

        const deploy = await request(
          server,
          'POST',
          '/api/branches/force-webhook/deploy/api',
          undefined,
          { 'X-CDS-Request-Id': 'req-force-deploy' },
        );
        expect(deploy.status).toBe(200);
        expect(String(deploy.body)).toContain('complete');
        expect(stateService.getBranch('force-webhook')?.status).toBe('running');
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toContain('/api/branches/force-webhook/deploy');
        expect(fetchCalls[0].body).toEqual({ commitSha: '2222222222222222222222222222222222222222' });
        expect(fetchCalls[0].requestId).toBe('req-force-webhook');

        const events = operationEvents.filter((event) => event.branchId === 'force-webhook');
        expect(events.find((event) => event.action === 'branch.operation.queued')?.operationId).toBe(forceOperationId);
        expect(events.find((event) => event.action === 'branch.operation.continued')?.operationId).toBe(forceOperationId);
        const deployStarted = events.find((event) => event.action === 'branch.operation.started' && event.details?.kind === 'deploy-profile');
        expect(deployStarted?.operationId).toBe(forceOperationId);
        const pendingDispatch = events.find((event) => event.action === 'branch.operation.pending-dispatch.started');
        expect(pendingDispatch?.details).toMatchObject({
          commitSha: '2222222222222222222222222222222222222222',
          trigger: 'webhook',
          actor: 'system:webhook',
          kind: 'deploy',
          mergedCount: 1,
        });
        expect(pendingDispatch).toMatchObject({
          operationKind: 'deploy',
          operationTrigger: 'webhook',
          operationActor: 'system:webhook',
          operationSource: 'api.deploy-branch',
          commitSha: '2222222222222222222222222222222222222222',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('branch operation fencing', () => {
    it('dispatches only the latest merged webhook commit after the active deploy completes', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'pending-latest',
        projectId: 'default',
        branch: 'feature/pending-latest',
        worktreePath: path.join(tmpDir, 'worktrees', 'pending-latest'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-pending-latest-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-pending-latest', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: Array<{ url: string; body: unknown; requestId?: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          requestId: init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>)['X-CDS-Request-Id']
            : undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/pending-latest/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-a' },
        );
        await runStarted;

        const mergedB = await request(
          server,
          'POST',
          '/api/branches/pending-latest/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-b' },
        );
        const mergedC = await request(
          server,
          'POST',
          '/api/branches/pending-latest/deploy',
          { commitSha: '3333333333333333333333333333333333333333' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-c' },
        );

        expect(String(mergedB.body)).toContain('operationStatus');
        expect(String(mergedB.body)).toContain('merged');
        expect(String(mergedC.body)).toContain('3333333333333333333333333333333333333333');

        releaseRun();
        const active = await activeDeploy;
        expect(active.status).toBe(200);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toContain('/api/branches/pending-latest/deploy');
        expect(fetchCalls[0].body).toEqual({ commitSha: '3333333333333333333333333333333333333333' });
        expect(fetchCalls[0].requestId).toBe('req-c');

        const pendingDispatch = operationEvents.find((event) =>
          event.branchId === 'pending-latest' && event.action === 'branch.operation.pending-dispatch.started',
        );
        expect(pendingDispatch?.operationId).toMatch(/^op_/);
        expect(pendingDispatch?.details).toMatchObject({
          commitSha: '3333333333333333333333333333333333333333',
          trigger: 'webhook',
          actor: 'system:webhook',
          kind: 'deploy',
          mergedCount: 2,
        });
        expect(pendingDispatch).toMatchObject({
          operationKind: 'deploy',
          operationTrigger: 'webhook',
          operationActor: 'system:webhook',
          operationSource: 'api.deploy-branch',
          commitSha: '3333333333333333333333333333333333333333',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('records pending webhook drops with queryable operation metadata when the branch is gone', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'pending-gone',
        projectId: 'default',
        branch: 'feature/pending-gone',
        worktreePath: path.join(tmpDir, 'worktrees', 'pending-gone'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-pending-gone-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-pending-gone', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/pending-gone/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-gone-a' },
        );
        await runStarted;

        const merged = await request(
          server,
          'POST',
          '/api/branches/pending-gone/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-gone-b' },
        );
        expect(String(merged.body)).toContain('merged');

        stateService.removeBranch('pending-gone');
        stateService.save();
        releaseRun();

        const active = await activeDeploy;
        expect(active.status).toBe(200);
        expect(fetchCalls).toHaveLength(0);

        const pendingDrop = operationEvents.find((event) =>
          event.branchId === 'pending-gone' && event.action === 'branch.operation.pending-drop',
        );
        expect(pendingDrop).toMatchObject({
          requestId: 'req-gone-b',
          operationId: expect.stringMatching(/^op_/),
          operationKind: 'deploy',
          operationTrigger: 'webhook',
          operationActor: 'system:webhook',
          operationSource: 'api.deploy-branch',
          commitSha: '2222222222222222222222222222222222222222',
        });
        expect(pendingDrop?.details).toMatchObject({
          operationId: pendingDrop?.operationId,
          commitSha: '2222222222222222222222222222222222222222',
          trigger: 'webhook',
          actor: 'system:webhook',
          source: 'api.deploy-branch',
          kind: 'deploy',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('manual stop cancels queued webhook deploy dispatch after an active deploy is fenced', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'stop-pending',
        projectId: 'default',
        branch: 'feature/stop-pending',
        worktreePath: path.join(tmpDir, 'worktrees', 'stop-pending'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-stop-pending-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-stop-pending', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: Array<{ url: string; body: unknown; requestId?: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          requestId: init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>)['X-CDS-Request-Id']
            : undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/stop-pending/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-a' },
        );
        await runStarted;

        const mergedB = await request(
          server,
          'POST',
          '/api/branches/stop-pending/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-b' },
        );
        expect(String(mergedB.body)).toContain('merged');

        const stop = await request(
          server,
          'POST',
          '/api/branches/stop-pending/stop',
          undefined,
          { 'X-CDS-Request-Id': 'req-stop-manual' },
        );
        expect(stop.status).toBe(200);

        releaseRun();
        const active = await activeDeploy;
        expect(active.status).toBe(200);
        expect(String(active.body)).toContain('error');
        expect(fetchCalls).toHaveLength(0);
        expect(stateService.getBranch('stop-pending')?.status).toBe('idle');

        const events = operationEvents.filter((event) => event.branchId === 'stop-pending');
        expect(events.some((event) =>
          event.action === 'branch.operation.cancelled'
          && event.operationKind === 'deploy'
          && event.details?.reason === 'superseded by stop',
        )).toBe(true);
        expect(events.some((event) =>
          event.action === 'branch.operation.cancelled'
          && event.operationKind === 'deploy'
          && event.details?.pending === true
          && event.details?.reason === 'superseded by stop',
        )).toBe(true);
        expect(events.find((event) => event.action === 'branch.operation.pending-dispatch.started')).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('orphan-service removal does not delete entry.services when the deploy lease is superseded mid-loop', async () => {
      // Bugbot Medium (learned rule: BranchOperationCoordinator lease safety): the deploy-finalize
      // loop that tears down services removed from the desired set awaits containerService.remove.
      // If a higher-priority op (manual stop) supersedes the deploy lease during that await, the loop
      // must assertCurrent and abort BEFORE deleting entry.services + save() — not mutate state under
      // a cancelled deploy.
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'orphan-fence',
        projectId: 'default',
        branch: 'feature/orphan-fence',
        worktreePath: path.join(tmpDir, 'worktrees', 'orphan-fence'),
        status: 'idle',
        createdAt: now,
        services: {
          api: { profileId: 'api', containerName: 'cds-orphan-fence-api', hostPort: 10001, status: 'idle' },
          // zombie: no matching build profile → the deploy's orphan-removal loop will try to remove it.
          zombie: { profileId: 'zombie', containerName: 'cds-orphan-fence-zombie', hostPort: 10002, status: 'idle' },
        },
      });
      stateService.save();

      // Gate the deploy inside the orphan-removal loop: pause when it issues `docker rm` for the
      // zombie container, then supersede the lease via a manual stop, then release.
      let releaseRm!: () => void;
      const rmRelease = new Promise<void>((resolve) => { releaseRm = resolve; });
      let markRmStarted!: () => void;
      const rmStarted = new Promise<void>((resolve) => { markRmStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker rm') && command.includes('cds-orphan-fence-zombie')) {
          markRmStarted();
          await rmRelease;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(server, 'POST', '/api/branches/orphan-fence/deploy');
      try {
        await rmStarted;
        // Manual stop supersedes the in-flight deploy lease.
        const stop = await request(
          server,
          'POST',
          '/api/branches/orphan-fence/stop',
          undefined,
          { 'X-CDS-Request-Id': 'req-orphan-stop' },
        );
        expect(stop.status).toBe(200);
      } finally {
        releaseRm();
      }
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      // The superseded deploy must NOT have deleted the zombie service entry under a cancelled lease.
      expect(stateService.getBranch('orphan-fence')?.services.zombie).toBeTruthy();
    });

    it('deploy with an empty effective profile list tears down lingering services instead of 400 (Codex P2)', async () => {
      // A branch whose only running service was a branch-local extra. After the extra is cleared the
      // effective profile list is empty. The deploy must NOT just 400 and leave the old container +
      // entry.services row behind — it should reconcile (tear down) the now-orphaned services.
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'empty-cleanup',
        projectId: 'default',
        branch: 'feature/empty-cleanup',
        worktreePath: path.join(tmpDir, 'worktrees', 'empty-cleanup'),
        status: 'running',
        createdAt: now,
        // No build profiles configured for the project AND no extraProfiles → effective list empty,
        // but a leftover service is still tracked (the just-cleared extra).
        services: {
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-empty-cleanup-demo-extra', hostPort: 10005, status: 'running' },
        },
      });
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/empty-cleanup/deploy');
      expect(res.status).toBe(200);
      // deploy 端点契约是 SSE：清空路径以 event: complete 收尾（不再是 200 JSON，Bugbot Medium）。
      expect(res.headers['content-type']).toContain('text/event-stream');
      const sse = String(res.body);
      expect(sse).toContain('event: complete');
      expect(sse).toContain('demo-extra'); // cleared 列表在 complete data 里
      // The lingering service row is gone (container was torn down + entry removed).
      expect(stateService.getBranch('empty-cleanup')?.services['demo-extra']).toBeUndefined();
      expect(Object.keys(stateService.getBranch('empty-cleanup')?.services || {})).toHaveLength(0);
    });

    it('deploy with empty profiles refuses (503) when the owning executor is offline — no state mutation (Bugbot High)', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'empty-offline-exec',
        projectId: 'default',
        branch: 'feature/empty-offline-exec',
        worktreePath: path.join(tmpDir, 'worktrees', 'empty-offline-exec'),
        status: 'running',
        createdAt: now,
        executorId: 'exec-off',
        services: {
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-empty-offline-exec-demo-extra', hostPort: 10006, status: 'running' },
        },
      });
      registryNodes.push({
        id: 'exec-off', host: '127.0.0.1', port: 9109, status: 'offline', role: 'remote',
        labels: [], branches: ['empty-offline-exec'],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 }, load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now,
      });
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/empty-offline-exec/deploy');
      expect(res.status).toBe(503);
      expect((res.body as any).error).toBe('owning_executor_offline');
      // state untouched — the worker container must not be orphaned/ghosted.
      expect(stateService.getBranch('empty-offline-exec')?.services['demo-extra']).toBeTruthy();
      expect(stateService.getBranch('empty-offline-exec')?.status).toBe('running');
    });

    it('deploy with no profiles AND no services still returns the original 400', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'empty-nosvc',
        projectId: 'default',
        branch: 'feature/empty-nosvc',
        worktreePath: path.join(tmpDir, 'worktrees', 'empty-nosvc'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();
      const res = await request(server, 'POST', '/api/branches/empty-nosvc/deploy');
      expect(res.status).toBe(400);
      expect(String((res.body as any).error)).toContain('构建配置');
    });

    it('records branch delete completion only after state flush succeeds', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'flush-delete',
        projectId: 'default',
        branch: 'feature/flush-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'flush-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      stateService.flush = async () => {
        operationEvents.push({ action: 'test.state-flushed', branchId: 'flush-delete' });
      };

      const del = await request(server, 'DELETE', '/api/branches/flush-delete');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('flush-delete')).toBeUndefined();

      const actions = operationEvents
        .filter((event) => event.branchId === 'flush-delete')
        .map((event) => event.action);
      expect(actions.indexOf('test.state-flushed')).toBeGreaterThanOrEqual(0);
      expect(actions.indexOf('branch.delete.completed')).toBeGreaterThan(actions.indexOf('test.state-flushed'));
    });

    it('does not keep delete SSE open when immediate delete completion audit hangs', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'hung-audit-delete',
        projectId: 'default',
        branch: 'feature/hung-audit-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'hung-audit-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      serverEventLogStore.recordImmediate = async () => {
        await new Promise<void>(() => { /* simulate a stuck Mongo write */ });
      };

      const startedAt = Date.now();
      const del = await request(server, 'DELETE', '/api/branches/hung-audit-delete');
      const elapsedMs = Date.now() - startedAt;

      expect(del.status).toBe(200);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(String(del.body)).toContain('complete');
      expect(stateService.getBranch('hung-audit-delete')).toBeUndefined();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-audit-delete' && event.action === 'branch.delete.completed',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-audit-delete' && event.action === 'branch.delete.audit-timeout',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-audit-delete' && event.action === 'branch.operation.completed',
      )).toBeTruthy();
    });

    it('does not fail branch delete when immediate delete completion audit throws', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'failed-audit-delete',
        projectId: 'default',
        branch: 'feature/failed-audit-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'failed-audit-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      serverEventLogStore.recordImmediate = async () => {
        throw new Error('mongo temporarily unavailable');
      };

      const del = await request(server, 'DELETE', '/api/branches/failed-audit-delete');

      expect(del.status).toBe(200);
      expect(String(del.body)).toContain('complete');
      expect(stateService.getBranch('failed-audit-delete')).toBeUndefined();
      expect(operationEvents.find((event) =>
        event.branchId === 'failed-audit-delete' && event.action === 'branch.delete.completed',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'failed-audit-delete' && event.action === 'branch.operation.completed',
      )).toBeTruthy();
    });

    it('does not report delete success when state flush hangs after removing branch state', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'hung-flush-delete',
        projectId: 'default',
        branch: 'feature/hung-flush-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'hung-flush-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      stateService.flush = async () => {
        await new Promise<void>(() => { /* simulate stuck write-behind persistence */ });
      };

      process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS = '500';
      const startedAt = Date.now();
      const del = await request(server, 'DELETE', '/api/branches/hung-flush-delete');
      delete process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS;
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(2_000);
      expect(String(del.body)).toContain('error');
      expect(String(del.body)).toContain('持久化超时');
      expect(stateService.getBranch('hung-flush-delete')).toBeUndefined();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-flush-delete' && event.action === 'branch.delete.state-flush-timeout',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-flush-delete' && event.action === 'branch.delete.completed',
      )).toBeFalsy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-flush-delete' && event.action === 'branch.operation.failed',
      )).toBeTruthy();
    });

    it('does not keep delete SSE open for slow best-effort volume cleanup', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'slow-volume-delete',
        projectId: 'default',
        branch: 'feature/slow-volume-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'slow-volume-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      const originalExec = mock.exec.bind(mock);
      let volumeCleanupStarted = false;
      mock.exec = async (command, options) => {
        if (command.includes('docker volume ls') && command.includes('--filter name=cds-nm-')) {
          volumeCleanupStarted = true;
          await new Promise<void>(() => { /* simulate a hung Docker volume command */ });
        }
        return originalExec(command, options);
      };

      const del = await request(server, 'DELETE', '/api/branches/slow-volume-delete');
      expect(del.status).toBe(200);
      expect(String(del.body)).toContain('complete');
      expect(stateService.getBranch('slow-volume-delete')).toBeUndefined();
      expect(volumeCleanupStarted).toBe(true);
      expect(operationEvents.find((event) =>
        event.branchId === 'slow-volume-delete' && event.action === 'branch.delete.completed',
      )).toBeTruthy();
    });

    it('manual delete fences an in-flight webhook deploy and the old deploy cannot recreate branch state', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-delete',
        projectId: 'default',
        branch: 'feature/race-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-race-delete-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-race-delete', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(
        server,
        'POST',
        '/api/branches/race-delete/deploy',
        { commitSha: '2222222222222222222222222222222222222222' },
        { 'X-CDS-Trigger': 'webhook' },
      );
      await runStarted;

      const del = await request(server, 'DELETE', '/api/branches/race-delete');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('race-delete')).toBeUndefined();

      releaseRun();
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('no longer current');
      expect(stateService.getBranch('race-delete')).toBeUndefined();

      const events = operationEvents.filter((event) => event.branchId === 'race-delete');
      expect(events.map((event) => event.action)).toContain('branch.operation.cancelled');
      expect(events.map((event) => event.action)).toContain('branch.operation.completed');
      const deleteStarted = events.find((event) => event.action === 'branch.operation.started' && event.details?.kind === 'delete');
      const deleteOperationId = deleteStarted?.operationId;
      expect(deleteOperationId).toMatch(/^op_/);
      expect(events.find((event) => event.action === 'branch.delete.requested')?.operationId).toBe(deleteOperationId);
      expect(events.find((event) => event.action === 'branch.delete.completed')?.operationId).toBe(deleteOperationId);
      expect(events.find((event) =>
        event.action === 'container.logs.archived' && event.details?.archiveSource === 'branch-delete',
      )?.operationId).toBe(deleteOperationId);
      expect(events.map((event) => event.action)).toContain('container.remove.after-fenced-deploy');
      expect(events.map((event) => event.action)).not.toContain('container.remove.after-fenced-deploy.skipped');
    });

    it('manual delete before docker run prevents a fenced webhook deploy from creating containers', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-delete-before-run',
        projectId: 'default',
        branch: 'feature/race-delete-before-run',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-delete-before-run'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseReset!: () => void;
      const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
      let markResetStarted!: () => void;
      const resetStarted = new Promise<void>((resolve) => { markResetStarted = resolve; });
      let dockerRunCount = 0;
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('git reset --hard')) {
          markResetStarted();
          await resetRelease;
          return { stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0 };
        }
        if (command.includes('docker run -d') && command.includes('--name cds-race-delete-before-run-api')) {
          dockerRunCount += 1;
        }
        return originalExec(command, options);
      };

      const deployPromise = request(
        server,
        'POST',
        '/api/branches/race-delete-before-run/deploy',
        { commitSha: '2222222222222222222222222222222222222222' },
        { 'X-CDS-Trigger': 'webhook' },
      );
      await resetStarted;

      const del = await request(server, 'DELETE', '/api/branches/race-delete-before-run');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('race-delete-before-run')).toBeUndefined();

      releaseReset();
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('no longer current');
      expect(stateService.getBranch('race-delete-before-run')).toBeUndefined();
      expect(dockerRunCount).toBe(0);

      const events = operationEvents.filter((event) => event.branchId === 'race-delete-before-run');
      expect(events.map((event) => event.action)).toContain('branch.operation.cancelled');
    });

    it('manual delete after pre-run cleanup still fences before docker run', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-delete-during-runservice',
        projectId: 'default',
        branch: 'feature/race-delete-during-runservice',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-delete-during-runservice'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releasePreRun!: () => void;
      const preRunRelease = new Promise<void>((resolve) => { releasePreRun = resolve; });
      let markPreRunStarted!: () => void;
      const preRunStarted = new Promise<void>((resolve) => { markPreRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command === 'docker rm -f cds-race-delete-during-runservice-api') {
          markPreRunStarted();
          await preRunRelease;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(
        server,
        'POST',
        '/api/branches/race-delete-during-runservice/deploy',
        { commitSha: '2222222222222222222222222222222222222222' },
        { 'X-CDS-Trigger': 'webhook' },
      );
      await preRunStarted;

      const del = await request(server, 'DELETE', '/api/branches/race-delete-during-runservice');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('race-delete-during-runservice')).toBeUndefined();

      releasePreRun();
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('no longer current');
      expect(mock.commands.some((command) =>
        command.includes('docker run -d') && command.includes('--name cds-race-delete-during-runservice-api'),
      )).toBe(false);
    });

    it('manual stop clears an active and queued webhook deploy without dispatching the queued commit', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-stop',
        projectId: 'default',
        branch: 'feature/race-stop',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-stop'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-race-stop-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-race-stop', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: Array<{ url: string; body: unknown }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/race-stop/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-a' },
        );
        await runStarted;

        const merged = await request(
          server,
          'POST',
          '/api/branches/race-stop/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-b' },
        );
        expect(String(merged.body)).toContain('merged');

        const stop = await request(
          server,
          'POST',
          '/api/branches/race-stop/stop',
          undefined,
          { 'X-CDS-Request-Id': 'req-stop-user' },
        );
        expect(stop.status).toBe(200);
        expect((stop.body as any).message).toContain('已停止');
        expect(stateService.getBranch('race-stop')?.status).toBe('idle');
        expect(Object.values(stateService.getBranch('race-stop')?.services || {}).every((svc) => svc.status === 'stopped')).toBe(true);

        releaseRun();
        const deploy = await activeDeploy;
        expect(deploy.status).toBe(200);
        expect(String(deploy.body)).toContain('no longer current');
        expect(fetchCalls).toEqual([]);
        expect(stateService.getBranch('race-stop')?.status).toBe('idle');

        const events = operationEvents.filter((event) => event.branchId === 'race-stop');
        const cancelled = events.filter((event) => event.action === 'branch.operation.cancelled');
        expect(cancelled.some((event) => event.details?.kind === 'deploy' && event.details?.pending !== true)).toBe(true);
        expect(cancelled.some((event) => event.details?.pending === true && event.details?.reason === 'superseded by stop')).toBe(true);
        const stopStarted = events.find((event) => event.action === 'branch.operation.started' && event.details?.kind === 'stop');
        expect(stopStarted?.operationId).toMatch(/^op_/);
        expect(events.find((event) => event.action === 'container.logs.archived' && event.details?.archiveSource === 'manual-stop')?.operationId)
          .toBe(stopStarted?.operationId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('remote executor deploy completes the branch operation lease so later webhook deploys are not merged into a stale active op', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'remote-lease',
        projectId: 'default',
        branch: 'feature/remote-lease',
        worktreePath: path.join(tmpDir, 'worktrees', 'remote-lease'),
        status: 'idle',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-remote-lease-api',
            hostPort: 10001,
            status: 'idle',
          },
        },
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();
      registryNodes.push({
        id: 'exec-1',
        host: '127.0.0.1',
        port: 9101,
        status: 'online',
        role: 'remote',
        labels: [],
        branches: [],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 },
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        registeredAt: now,
        lastHeartbeat: now,
      });

      const fetchCalls: Array<{ url: string; body: any }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response([
          'event: step',
          'data: {"step":"remote","status":"running","title":"remote deploy"}',
          '',
          'event: complete',
          'data: {"ok":true,"services":{"api":{"status":"running"}}}',
          '',
          '',
        ].join('\n'), { status: 200 });
      }) as typeof fetch;

      try {
        const first = await request(
          server,
          'POST',
          '/api/branches/remote-lease/deploy',
          { commitSha: '1111111111111111111111111111111111111111', targetExecutorId: 'exec-1' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-remote-a' },
        );
        expect(first.status).toBe(200);

        const second = await request(
          server,
          'POST',
          '/api/branches/remote-lease/deploy',
          { commitSha: '2222222222222222222222222222222222222222', targetExecutorId: 'exec-1' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-remote-b' },
        );
        expect(second.status).toBe(200);
        expect(String(second.body)).not.toContain('merged');
        expect(fetchCalls).toHaveLength(2);

        const events = operationEvents.filter((event) => event.branchId === 'remote-lease');
        const started = events.filter((event) => event.action === 'branch.operation.started' && event.details?.kind === 'deploy');
        const completed = events.filter((event) => event.action === 'branch.operation.completed' && event.details?.kind === 'deploy');
        expect(started).toHaveLength(2);
        expect(completed).toHaveLength(2);
        expect(events.some((event) => event.action === 'branch.operation.merged')).toBe(false);
        expect(fetchCalls[0].body.operationId).toBe(started[0].operationId);
        expect(fetchCalls[1].body.operationId).toBe(started[1].operationId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('POST /api/branches/:id/set-default', () => {
    it('should set default branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'main' });
      const res = await request(server, 'POST', '/api/branches/main/set-default');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).defaultBranch).toBe('main');
    });
  });

  describe('POST /api/branches/:id/reset', () => {
    it('should reset error status to idle', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const branch = stateService.getBranch('feature-test')!;
      branch.status = 'error';
      branch.errorMessage = 'build failed';
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/reset');
      expect(res.status).toBe(200);
      expect((res.body as any).operationId).toMatch(/^op_/);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).branches[0].status).toBe('idle');
      expect(operationEvents.some((event) => event.action === 'branch.operation.completed'
        && event.operationKind === 'reset'
        && event.operationTrigger === 'manual'
        && event.branchId === 'feature-test')).toBe(true);
    });
  });

  // ── Routing rules ──

  describe('routing rules CRUD', () => {
    it('should create and list rules', async () => {
      const rule = { id: 'r1', name: 'Test', type: 'domain', match: '*.dev.com', branch: 'main', priority: 0, enabled: true };
      const createRes = await request(server, 'POST', '/api/routing-rules', rule);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/routing-rules');
      expect((listRes.body as any).rules).toHaveLength(1);
    });

    it('should update and delete rules', async () => {
      await request(server, 'POST', '/api/routing-rules', { id: 'r1', name: 'T', type: 'domain', match: 'a', branch: 'b' });
      await request(server, 'PUT', '/api/routing-rules/r1', { enabled: false });

      let list = await request(server, 'GET', '/api/routing-rules');
      expect((list.body as any).rules[0].enabled).toBe(false);

      await request(server, 'DELETE', '/api/routing-rules/r1');
      list = await request(server, 'GET', '/api/routing-rules');
      expect((list.body as any).rules).toHaveLength(0);
    });

    // P4 Part 17 (G14): routing rules created from a non-default project
    // page must land in that project, not silently in 'default'. This
    // mirrors the B1 fix on POST /build-profiles and POST /infra. Three
    // tests cover body.projectId, fallback to 'default', and rejection
    // of unknown projectId.
    it('P4 Part 17 (G14): POST /routing-rules honors body.projectId', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'rules-alt',
        slug: 'rules-alt',
        name: 'Rules Alt',
        kind: 'git',
        dockerNetwork: 'cds-proj-rules-alt',
        legacyFlag: false,
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-alt',
        name: 'Alt rule',
        type: 'domain',
        match: '*.alt.dev',
        branch: 'main',
        projectId: 'rules-alt',
      });
      expect(res.status).toBe(201);

      const altList = await request(server, 'GET', '/api/routing-rules?project=rules-alt');
      expect((altList.body as any).rules).toHaveLength(1);
      expect((altList.body as any).rules[0].projectId).toBe('rules-alt');
    });

    it('P4 Part 17 (G14): POST /routing-rules defaults to "default" when no projectId', async () => {
      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-def',
        name: 'Default rule',
        type: 'domain',
        match: '*.dev',
        branch: 'main',
      });
      expect(res.status).toBe(201);

      const list = await request(server, 'GET', '/api/routing-rules?project=default');
      expect((list.body as any).rules).toHaveLength(1);
      expect((list.body as any).rules[0].projectId).toBe('default');
    });

    it('P4 Part 17 (G14): POST /routing-rules rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-bad',
        name: 'Bad rule',
        type: 'domain',
        match: '*.dev',
        branch: 'main',
        projectId: 'no-such-project',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });
  });

  // ── Build profiles ──

  describe('build profiles CRUD', () => {
    it('should create and list profiles', async () => {
      const profile = { id: 'api', name: 'API', dockerImage: 'dotnet:8', command: 'dotnet run', workDir: '.', containerPort: 8080 };
      const createRes = await request(server, 'POST', '/api/build-profiles', profile);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/build-profiles');
      expect((listRes.body as any).profiles).toHaveLength(1);
    });

    it('should delete profiles', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'x', command: 'x' });
      await request(server, 'DELETE', '/api/build-profiles/api');

      const list = await request(server, 'GET', '/api/build-profiles');
      expect((list.body as any).profiles).toHaveLength(0);
    });

    it('skips build profile service cleanup while the branch has an active lifecycle operation', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'profile-delete-busy',
        projectId: 'default',
        branch: 'feature/profile-delete-busy',
        worktreePath: path.join(tmpDir, 'worktrees', 'profile-delete-busy'),
        status: 'idle',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-profile-delete-busy-api',
            hostPort: 10001,
            status: 'idle',
          },
        },
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker run -d') && command.includes('--name cds-profile-delete-busy-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-profile-delete-busy', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(server, 'POST', '/api/branches/profile-delete-busy/deploy');
      try {
        await runStarted;

        const deletion = await request(
          server,
          'DELETE',
          '/api/build-profiles/api',
          undefined,
          { 'X-CDS-Request-Id': 'req-profile-delete' },
        );

        expect(deletion.status).toBe(200);
        expect((deletion.body as any).skippedBusyCount).toBe(1);
        expect(stateService.getBranch('profile-delete-busy')?.services.api).toBeTruthy();
        const skipped = operationEvents.find((event) => event.action === 'app.build-profile-service.cleanup-skipped');
        expect(skipped?.requestId).toBe('req-profile-delete');
        expect(skipped?.branchId).toBe('profile-delete-busy');
        expect(skipped?.operationKind).toBe('deploy');
      } finally {
        releaseRun();
      }
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
    });

    it('P4 Part 16 (B1): POST /build-profiles honors body.projectId', async () => {
      // Pre-create the target project
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt-proj',
        slug: 'alt-proj',
        name: 'Alt Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'web',
        name: 'Web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        projectId: 'alt-proj',
      });
      expect(res.status).toBe(201);

      // Profile lands in alt-proj, not default
      const altList = await request(server, 'GET', '/api/build-profiles?project=alt-proj');
      expect((altList.body as any).profiles).toHaveLength(1);
      expect((altList.body as any).profiles[0].projectId).toBe('alt-proj');

      const defaultList = await request(server, 'GET', '/api/build-profiles?project=default');
      expect((defaultList.body as any).profiles).toHaveLength(0);
    });

    it('P4 Part 16 (B1): POST /build-profiles defaults to "default" when no projectId', async () => {
      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
      });
      expect(res.status).toBe(201);

      const list = await request(server, 'GET', '/api/build-profiles?project=default');
      expect((list.body as any).profiles).toHaveLength(1);
      expect((list.body as any).profiles[0].projectId).toBe('default');
    });

    it('P4 Part 16 (B1): POST /build-profiles rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        projectId: 'nonexistent',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });

    // P4 Part 17 (G2 fix): the deploy hot path was reading the global
    // getBuildProfiles() instead of getBuildProfilesForProject(). That
    // meant deploying a branch in project A would silently pull in
    // every profile from project B as well — total cross-project bleed.
    //
    // This test proves the fix: a branch in project 'default' with an
    // 'alt'-scoped profile must hit the "no profiles configured" 400
    // because the deploy reader now respects the branch's projectId.
    it('P4 Part 17 (G2): POST /branches/:id/deploy is project-scoped', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt-deploy',
        slug: 'alt-deploy',
        name: 'Alt Deploy',
        kind: 'git',
        dockerNetwork: 'cds-proj-alt-deploy',
        legacyFlag: false,
        createdAt: now,
        updatedAt: now,
      });

      // Profile lives in 'alt-deploy', NOT in default
      const profileRes = await request(server, 'POST', '/api/build-profiles', {
        id: 'web',
        name: 'Web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        projectId: 'alt-deploy',
      });
      expect(profileRes.status).toBe(201);

      // Branch lives in default
      const branchRes = await request(server, 'POST', '/api/branches', { branch: 'main' });
      expect(branchRes.status).toBe(201);

      // Deploying the default branch must NOT see the alt-deploy profile.
      // Pre-G2 fix this returned 200 + started deploying with the leaked
      // profile. After the fix we expect 400 "尚未配置构建配置".
      const deployRes = await request(server, 'POST', '/api/branches/main/deploy');
      expect(deployRes.status).toBe(400);
      expect((deployRes.body as any).error).toContain('尚未配置构建配置');
    });
  });

  // ── Config ──

  describe('GET /api/config', () => {
    it('should return masked config', async () => {
      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).jwt.secret).toBe('***');
    });

    it('should use GITHUB_REPO_URL from customEnv when set', async () => {
      // Set GITHUB_REPO_URL in custom env
      await request(server, 'PUT', '/api/env/GITHUB_REPO_URL', { value: 'https://github.com/my-org/my-repo' });

      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).githubRepoUrl).toBe('https://github.com/my-org/my-repo');
    });

    it('should fallback to git remote when GITHUB_REPO_URL not set', async () => {
      mock.addResponsePattern(/git remote get-url origin/, () => ({
        stdout: 'git@github.com:test-org/test-repo.git\n', stderr: '', exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).githubRepoUrl).toBe('https://github.com/test-org/test-repo');
    });
  });

  // ── Config sync via env vars ──

  describe('CDS config sync via env vars', () => {
    it('should sync CDS_REPO_ROOT into config when setting env var', async () => {
      await request(server, 'PUT', '/api/env/CDS_REPO_ROOT', { value: '/custom/repo' });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).repoRoot).toBe('/custom/repo');
    });

    it('should sync CDS_WORKTREE_BASE into config when setting env var', async () => {
      await request(server, 'PUT', '/api/env/CDS_WORKTREE_BASE', { value: '/custom/worktrees' });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).worktreeBase).toBe('/custom/worktrees');
    });

    it('should sync CDS_REPO_ROOT via bulk env update', async () => {
      await request(server, 'PUT', '/api/env', {
        CDS_REPO_ROOT: '/bulk/repo',
        CDS_WORKTREE_BASE: '/bulk/worktrees',
        GITHUB_REPO_URL: 'https://github.com/bulk-org/bulk-repo',
      });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).repoRoot).toBe('/bulk/repo');
      expect((configRes.body as any).worktreeBase).toBe('/bulk/worktrees');
      expect((configRes.body as any).githubRepoUrl).toBe('https://github.com/bulk-org/bulk-repo');
    });
  });

  // ── Infra services (P4 Part 16: B1 fix) ──

  describe('POST /api/infra (project scoping)', () => {
    it('honors body.projectId on creation', async () => {
      // Pre-create the target project
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'redis-proj',
        slug: 'redis-proj',
        name: 'Redis Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/infra', {
        id: 'redis',
        name: 'Redis',
        dockerImage: 'redis:7-alpine',
        containerPort: 6379,
        projectId: 'redis-proj',
      });
      expect(res.status).toBe(201);
      expect((res.body as any).service.projectId).toBe('redis-proj');

      // Verify scope: appears in redis-proj filter, NOT in default
      const altList = await request(server, 'GET', '/api/infra?project=redis-proj');
      expect((altList.body as any).services).toHaveLength(1);

      const defaultList = await request(server, 'GET', '/api/infra?project=default');
      expect((defaultList.body as any).services).toHaveLength(0);
    });

    it('defaults to "default" projectId when none supplied', async () => {
      const res = await request(server, 'POST', '/api/infra', {
        id: 'mongo',
        name: 'MongoDB',
        dockerImage: 'mongo:8.0',
        containerPort: 27017,
      });
      expect(res.status).toBe(201);
      expect((res.body as any).service.projectId).toBe('default');
    });

    it('rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/infra', {
        id: 'pg',
        name: 'Postgres',
        dockerImage: 'postgres:16',
        containerPort: 5432,
        projectId: 'nonexistent',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });
  });

  describe('GET /api/branches/state-audit', () => {
    it('counts only warning-severity findings as issues while preserving info totals', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'info-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'info-main'),
        status: 'idle',
        services: {},
        createdAt: now,
        lastDeployAt: '2026-05-26T22:00:00.000Z',
        lastPushAt: '2026-05-26T23:00:00.000Z',
        githubCommitSha: 'abc1234',
      });

      const res = await request(server, 'GET', '/api/branches/state-audit?project=default');

      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect((res.body as any).issueCount).toBe(0);
      expect((res.body as any).warnCount).toBe(0);
      expect((res.body as any).infoCount).toBe(1);
      expect((res.body as any).totalCount).toBe(1);
      expect((res.body as any).issues[0].kind).toBe('push-newer-than-successful-deploy');
    });
  });

  // ── Logs ──

  describe('GET /api/branches/:id/logs', () => {
    it('should return empty logs for new branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      expect(res.status).toBe(200);
      expect((res.body as any).logs).toEqual([]);
    });

    // F10 (2026-05-02 onboarding UAT): the historical logs are flushed only
    // when a deploy finalizes, so an in-progress build returns empty. The
    // response must include a `liveStreamHint` pointing at the SSE stream
    // so smart consumers can subscribe instead of polling.
    it('exposes a liveStreamHint for in-progress visibility', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      expect(res.status).toBe(200);
      const body = res.body as { liveStreamHint?: { url?: string; eventTypes?: string[]; note?: string } };
      expect(body.liveStreamHint).toBeDefined();
      expect(body.liveStreamHint?.url).toContain('/api/branches/stream');
      expect(body.liveStreamHint?.url).toContain('project=default');
      expect(body.liveStreamHint?.eventTypes).toContain('branch.status');
      expect(body.liveStreamHint?.note).toBeTruthy();
    });

    it('liveStreamHint reflects the branch projectId', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'p2', slug: 'p2', name: 'P2', kind: 'git',
        createdAt: now, updatedAt: now,
      });
      await request(server, 'POST', '/api/branches', { branch: 'fx', projectId: 'p2' });
      const res = await request(server, 'GET', '/api/branches/p2-fx/logs');
      expect(res.status).toBe(200);
      const body = res.body as { liveStreamHint?: { url?: string } };
      expect(body.liveStreamHint?.url).toContain('project=p2');
    });

    it('is a passive read path and does not touch Docker, Git, or branch operations', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      mock.commands.length = 0;
      operationEvents.length = 0;

      const res = await request(server, 'GET', '/api/branches/feature-test/logs');

      expect(res.status).toBe(200);
      expect(mock.commands.some((cmd) => /docker |git /.test(cmd))).toBe(false);
      expect(operationEvents.filter((event) => event.action.startsWith('branch.operation.'))).toEqual([]);
    });
  });

  // ── F9 (2026-05-02 onboarding UAT): Branch detail endpoint ──
  //
  // Before this fix, `GET /api/branches/<id>` fell through to the React
  // static fallback, returning HTML — the React loader saw 200 OK and
  // rendered a blank panel. These tests lock in the JSON contract.
  describe('GET /api/branches/:id (F9)', () => {
    it('returns 200 + { branch } when the id exists', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/x' });
      const res = await request(server, 'GET', '/api/branches/feature-x');
      expect(res.status).toBe(200);
      const body = res.body as { branch: { id: string; branch: string } };
      expect(body.branch).toBeDefined();
      expect(body.branch.id).toBe('feature-x');
      expect(body.branch.branch).toBe('feature/x');
    });

    it('is a passive read path and does not reconcile, deploy, or emit operation events', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/x' });
      mock.commands.length = 0;
      operationEvents.length = 0;

      const res = await request(server, 'GET', '/api/branches/feature-x');

      expect(res.status).toBe(200);
      expect(mock.commands.some((cmd) => /docker |git /.test(cmd))).toBe(false);
      expect(operationEvents.filter((event) => event.action.startsWith('branch.operation.'))).toEqual([]);
    });

    it('returns 404 when the id does not exist', async () => {
      const res = await request(server, 'GET', '/api/branches/no-such-branch');
      expect(res.status).toBe(404);
      expect((res.body as any).error).toContain('no-such-branch');
    });

    it('does not collide with /branches/stream (literal route wins)', async () => {
      // Regression: if `:id` were declared before `stream`, Express would
      // intercept the SSE endpoint and try to look up a branch named
      // "stream", returning 404. We assert the SSE endpoint sends a 200
      // status header within the keep-alive timeout (no need to read body
      // — the SSE channel never closes naturally).
      const status = await new Promise<number>((resolve, reject) => {
        const addr = server.address() as { port: number };
        const req = http.request({
          hostname: '127.0.0.1', port: addr.port,
          path: '/api/branches/stream', method: 'GET',
        }, (res) => {
          // Headers received → the route matched successfully. Tear down
          // the socket immediately, the test only cares about routing
          // ordering.
          resolve(res.statusCode!);
          req.destroy();
        });
        req.on('error', (err) => {
          // ECONNRESET after we destroy() is expected; surface anything
          // earlier as a real error.
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
          reject(err);
        });
        req.end();
      });
      expect(status).toBe(200);
    });
  });

  describe('GET /api/branches/:id/effective-env', () => {
    it('shows branch-scoped env overrides above project env', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'env-branch',
        projectId: 'default',
        branch: 'env/branch',
        worktreePath: path.join(tmpDir, 'worktrees', 'env-branch'),
        services: {},
        status: 'idle',
        createdAt: now,
      });
      stateService.setCustomEnvVar('FEATURE_FLAG', 'project-value', 'default');
      stateService.setCustomEnvVar('FEATURE_FLAG', 'branch-value', 'env-branch');
      stateService.setCustomEnvVar('PROJECT_ONLY', 'project-only', 'default');

      const res = await request(server, 'GET', '/api/branches/env-branch/effective-env');

      expect(res.status).toBe(200);
      const body = res.body as any;
      const feature = body.variables.find((v: any) => v.key === 'FEATURE_FLAG');
      const projectOnly = body.variables.find((v: any) => v.key === 'PROJECT_ONLY');
      expect(feature).toMatchObject({ value: 'branch-value', source: 'branch' });
      expect(projectOnly).toMatchObject({ value: 'project-only', source: 'project' });
      expect(body.bySource.branch).toBe(1);
    });
  });

  describe('GET /api/loading-pages/cds-waiting-room/preview', () => {
    it('renders the real CDS waiting-room loading page for settings preview', async () => {
      const res = await request(server, 'GET', '/api/loading-pages/cds-waiting-room/preview?status=building');

      expect(res.status).toBe(503);
      expect(res.body).toContain('CDS Waiting Room');
      expect(res.body).toContain('magic-rings-bg');
      expect(res.body).toContain('id="magic-rings"');
      expect(res.body).toContain('id="magic-rings-fragment"');
      expect(res.body).not.toContain('rings-orbit');
      expect(res.body).not.toContain('class="panel"');
      expect(res.body).toContain('分支环境正在构建');
    });
  });

  describe('POST /api/branches/:id/verify-runtime/:profileId', () => {
    it('returns a clear error when the recorded container no longer exists', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'runtime-missing',
        projectId: 'default',
        branch: 'runtime/missing',
        worktreePath: '/tmp/wt/runtime-missing',
        services: {
          api: {
            profileId: 'api',
            containerName: 'missing-container',
            hostPort: 12345,
            status: 'error',
          },
        },
        status: 'error',
        createdAt: now,
      });
      mock.addResponse('docker inspect --format="{{.State.Running}}" missing-container', {
        stdout: '',
        stderr: 'No such object: missing-container',
        exitCode: 1,
      });
      mock.addResponse('docker inspect --format="{{.State.Status}}" \'missing-container\'', {
        stdout: '',
        stderr: 'No such object: missing-container',
        exitCode: 1,
      });

      const res = await request(server, 'POST', '/api/branches/runtime-missing/verify-runtime/api');

      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('不存在或已被清理');
      expect(mock.commands.some((command) => command.startsWith('docker exec missing-container'))).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/self-branches — Bugbot 第八轮 HIGH fix(2026-05-04 PR #523)
  //
  // 关键回归:format 用 `%1f`(git 输出真 0x1F 字节)+ JS split 用 '\x1f'。
  // 之前写 `'\\x1f'`(4 字符 literal)git 不解析 → split 找不到分隔符 → 整个
  // branch picker 返回空数组,self-update UI 完全不可用。
  // ──────────────────────────────────────────────────────────────────
  describe('GET /api/self-branches', () => {
    // 2026-05-28 重构:/api/self-branches 不再直接同步扫 git,改读
    // selfStatusCache.remoteBranches。下面的测试直接调 cache.enqueueRefresh
    // 让 cache 跑一次 scanRemoteBranchesFromGit,等 refresh job done 后再 GET。
    // (test app 没有挂 cds-events router,所以无法走 POST /api/self-refresh)
    // mock shell 响应仍然是同一套(模拟 git for-each-ref 等)。
    const waitForRefresh = async (): Promise<void> => {
      // cache 的 refresh job 是异步的;实际跑完需要让微任务 + 后续 await 全部执行。
      for (let i = 0; i < 30; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const triggerCacheRefresh = async (): Promise<void> => {
      const mod = await import('../../src/services/self-status-cache.js');
      const job = mod.selfStatusCache.enqueueRefresh('manual');
      expect(['queued', 'running']).toContain(job.status);
      await waitForRefresh();
    };
    it('正确解析 git for-each-ref 用 0x1F 分隔的输出', async () => {
      mock.clearPatterns();
      const SEP = '\x1f'; // 真 0x1F 字节
      // git for-each-ref 输出 — 模拟 git 自己用 %1f 转义后输出真 0x1F 字节
      mock.addResponsePattern(/^git for-each-ref/, () => ({
        stdout: [
          `origin/main${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}feat: latest main commit`,
          `origin/feat-x${SEP}2026-05-03T10:00:00+00:00${SEP}bbb2222${SEP}wip: feat-x progress`,
          `origin/HEAD -> origin/main${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}should be filtered`,
          `origin/old-branch${SEP}2026-04-01T00:00:00+00:00${SEP}ccc3333${SEP}old: legacy`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({
        stdout: 'aaa1111', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git log -1 --format=%cI HEAD/, () => ({
        stdout: '2026-05-04T12:00:00+00:00', stderr: '', exitCode: 0,
      }));
      // cdsTouched 检查 — feat-x 动了 cds,old-branch 没动
      mock.addResponsePattern(/git log --format=%H -n 1 origin\/main\.\.origin\/feat-x -- cds\//, () => ({
        stdout: 'somesha', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git log --format=%H -n 1 origin\/main\.\.origin\/old-branch -- cds\//, () => ({
        stdout: '', stderr: '', exitCode: 0,
      }));

      // 触发 cache refresh,等 job done。新契约:/api/self-branches 读 cache。
      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      const body = res.body as {
        ok?: boolean;
        degraded?: boolean;
        current: string;
        commitHash: string;
        currentCommitterDate: string;
        branches: string[];
        branchDetails: Array<{
          name: string;
          committerDate: string;
          commitHash: string;
          subject: string;
          cdsTouched: boolean;
        }>;
      };

      // 关键断言:branchDetails 不能为空(之前 bug 让它空)
      expect(body.branchDetails).toBeDefined();
      expect(body.branchDetails.length).toBeGreaterThan(0);

      // origin/HEAD -> origin/main 这种 ref 应被过滤
      const names = body.branchDetails.map((b) => b.name);
      expect(names).not.toContain('HEAD -> main');
      expect(names).not.toContain('HEAD');

      // 分支按 committerDate 倒序(git for-each-ref --sort=-committerdate 已排,前端不再排)
      // 第一行 main,第二行 feat-x,第三行被 HEAD 过滤,第四行 old-branch
      expect(names).toEqual(['main', 'feat-x', 'old-branch']);

      // origin/ 前缀应被剥掉
      expect(names.every((n) => !n.startsWith('origin/'))).toBe(true);

      // 字段被正确解析(说明 split('\x1f') 工作)
      const main = body.branchDetails.find((b) => b.name === 'main')!;
      expect(main.committerDate).toBe('2026-05-04T12:00:00+00:00');
      expect(main.commitHash).toBe('aaa1111');
      expect(main.subject).toBe('feat: latest main commit');

      // cdsTouched:feat-x = true,old-branch = false(当前分支 main 自己不算)
      const featX = body.branchDetails.find((b) => b.name === 'feat-x')!;
      expect(featX.cdsTouched).toBe(true);
      const old = body.branchDetails.find((b) => b.name === 'old-branch')!;
      expect(old.cdsTouched).toBe(false);

      // 旧字段 branches: string[] 也按时间倒排
      expect(body.branches).toEqual(['main', 'feat-x', 'old-branch']);
    });

    it('subject 含空格和特殊字符仍能正确解析(0x1F 分隔不被空格破坏)', async () => {
      mock.clearPatterns();
      const SEP = '\x1f';
      mock.addResponsePattern(/^git for-each-ref/, () => ({
        stdout: [
          // subject 含中文 + 空格 + 特殊字符,SEP 才能可靠分割
          `origin/main${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}fix(cds): 修 bug — 含 () : / 等特殊符号`,
        ].join('\n'),
        stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({ stdout: 'aaa1111', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log -1 --format=%cI HEAD/, () => ({ stdout: '2026-05-04T12:00:00+00:00', stderr: '', exitCode: 0 }));

      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      const body = res.body as { branchDetails: Array<{ subject: string }> };
      expect(body.branchDetails).toHaveLength(1);
      expect(body.branchDetails[0].subject).toBe('fix(cds): 修 bug — 含 () : / 等特殊符号');
    });

    it('git for-each-ref 失败时返回 200 + degraded(永不 5xx)', async () => {
      // 2026-05-28 契约变更:本端点永远 200,失败用 degraded:true 暴露。
      mock.clearPatterns();
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/^git for-each-ref/, () => {
        throw new Error('fatal: not a git repository');
      });

      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      const body = res.body as {
        ok: boolean;
        degraded: boolean;
        reason?: string | null;
        branchDetails: unknown[];
      };
      // remoteBranches scan 抛错时 cache.scanRemoteBranches 会内部 catch,
      // 仍然保留旧 remoteBranches(空)— 接口表现为 ok+空列表,不是 500。
      expect(body.branchDetails).toEqual([]);
    });
  });

  // ── 轻量重启 + 分支系统日志（2026-05-18）──

  describe('POST /api/branches/:id/restart', () => {
    it('404 when branch does not exist', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/restart');
      expect(res.status).toBe(404);
    });

    it('409 when branch has no built containers', async () => {
      stateService.addBranch({
        id: 'feat-x', branch: 'feat/x', worktreePath: '/tmp/wt/feat-x',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z',
        projectId: 'default',
      });
      const res = await request(server, 'POST', '/api/branches/feat-x/restart');
      expect(res.status).toBe(409);
    });

    it('records manual restart as a fenced branch operation with container operationId', async () => {
      stateService.addBranch({
        id: 'feat-restart',
        branch: 'feat/restart',
        worktreePath: '/tmp/wt/feat-restart',
        services: {
          api: {
            profileId: 'api',
            containerName: 'restart-api',
            hostPort: 10001,
            status: 'stopped',
          },
        },
        status: 'idle',
        createdAt: '2026-02-12T00:00:00Z',
        projectId: 'default',
      });
      mock.addResponsePattern(/docker restart restart-api/, () => ({ stdout: 'restart-api', stderr: '', exitCode: 0 }));

      const res = await request(server, 'POST', '/api/branches/feat-restart/restart');

      expect(res.status).toBe(200);
      const branch = stateService.getBranch('feat-restart')!;
      expect(branch.status).toBe('running');
      expect(branch.services.api.status).toBe('running');
      const started = operationEvents.find((event) => event.branchId === 'feat-restart' && event.action === 'branch.operation.started');
      const completed = operationEvents.find((event) => event.branchId === 'feat-restart' && event.action === 'branch.operation.completed');
      expect(started?.details).toMatchObject({ kind: 'restart', source: 'api.restart-branch' });
      expect(completed?.operationId).toBe(started?.operationId);
      expect(mock.commands.some((command) => command.includes('docker restart restart-api'))).toBe(true);
    });

  });

  describe('GET /api/branches/:id/activity-logs', () => {
    it('404 for unknown branch', async () => {
      const res = await request(server, 'GET', '/api/branches/nope/activity-logs');
      expect(res.status).toBe(404);
    });

    it('只返回本分支事件且最新在前', async () => {
      stateService.addBranch({
        id: 'feat-z', branch: 'feat/z', worktreePath: '/tmp/wt/feat-z',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z', projectId: 'default',
      });
      stateService.appendActivityLog('default', { type: 'deploy', branchId: 'feat-z', actor: 'user', at: '2026-05-18T00:00:00.000Z' });
      stateService.appendActivityLog('default', { type: 'crash', branchId: 'feat-z', actor: 'auto-restart', at: '2026-05-18T01:00:00.000Z' });
      stateService.appendActivityLog('default', { type: 'stop', branchId: 'other-branch', actor: 'user', at: '2026-05-18T02:00:00.000Z' });
      stateService.save();
      const res = await request(server, 'GET', '/api/branches/feat-z/activity-logs');
      expect(res.status).toBe(200);
      const body = res.body as { logs: Array<{ type: string; branchId: string }> };
      expect(body.logs.every((e) => e.branchId === 'feat-z')).toBe(true);
      expect(body.logs[0].type).toBe('crash'); // 最新在前
      expect(body.logs.map((e) => e.type)).toEqual(['crash', 'deploy']);
    });
  });
});
