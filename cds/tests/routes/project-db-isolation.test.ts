/**
 * 项目级数据库隔离（GET/PUT /api/projects/:id/db-isolation）。
 *
 * 钉住四件事：
 *   1. 读：项目内每个服务的生效档位 + 来源 + 会被改写的库名 key + 分支覆盖概况；
 *   2. 写是原子的：任何一个 profileId 不存在或值非法，整批不落盘；
 *   3. 分支覆盖不被项目级写入碰到，且真实部署路径（applyProfileOverride →
 *      applyPerBranchDbIsolation）上「继承的分支跟着变、覆盖的分支不变」；
 *   4. 项目 key 只能改自己的项目；托管交付项目只读。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import {
  buildProjectDbIsolationView,
  countAffectedBranches,
  createProjectDbIsolationRouter,
  planProjectDbIsolationWrite,
} from '../../src/routes/project-db-isolation.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import { resolveReplicaDbTarget } from '../../src/services/replica-db-clone.js';
import { applyPerBranchDbIsolation } from '../../src/services/db-scope-isolation.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BuildProfile } from '../../src/types.js';

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const NOW = '2026-09-02T00:00:00.000Z';
const KEY_PROJ_A = 'TEST-KEY-PROJ-A';
const KEY_PROJ_B = 'TEST-KEY-PROJ-B';

function profile(overrides: Partial<BuildProfile> & { id: string; projectId: string }): BuildProfile {
  return {
    name: overrides.id,
    dockerImage: 'node:20',
    workDir: '.',
    containerPort: 3000,
    command: 'npm start',
    ...overrides,
  } as BuildProfile;
}

describe('项目级数据库隔离路由', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-db-iso-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();

    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: NOW, updatedAt: NOW });
    stateService.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: NOW, updatedAt: NOW });
    stateService.addProject({
      id: 'proj-managed', slug: 'm', name: 'M', kind: 'git', createdAt: NOW, updatedAt: NOW,
      deliveryMode: 'managed',
      managedProfiles: [profile({ id: 'managed-api', projectId: 'proj-managed' })],
    } as any);

    // api 声明了库名变量（切独立库会真的改写）；web 没声明（切了也没效果）；
    // worker 已显式 per-branch。
    stateService.addBuildProfile(profile({
      id: 'api', projectId: 'proj-a', name: 'API',
      env: { CDS_POSTGRES_DB: 'app', DATABASE_URL: 'postgres://db/${CDS_POSTGRES_DB}' },
    }));
    stateService.addBuildProfile(profile({ id: 'web', projectId: 'proj-a', name: 'Web' }));
    stateService.addBuildProfile(profile({
      id: 'worker', projectId: 'proj-a', name: 'Worker', dbScope: 'per-branch',
      env: { CDS_MYSQL_DATABASE: 'jobs' },
    }));
    stateService.addBuildProfile(profile({ id: 'b-api', projectId: 'proj-b' }));

    // proj-c：收敛 1 的口径样本——.NET 框架变量、项目级 DB_NAME + JDBC 串、纯白名单
    stateService.addProject({ id: 'proj-c', slug: 'c', name: 'C', kind: 'git', createdAt: NOW, updatedAt: NOW });
    stateService.addBuildProfile(profile({ id: 'dotnet', projectId: 'proj-c', env: { MongoDB__DatabaseName: 'prdagent' } }));
    stateService.addBuildProfile(profile({ id: 'java', projectId: 'proj-c', env: { DB_NAME: 'imp', SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/imp' } }));
    stateService.addBuildProfile(profile({ id: 'node', projectId: 'proj-c', env: { CDS_MYSQL_DATABASE: 'shop' } }));
    stateService.addInfraService({
      id: 'mongo', name: 'mongo', projectId: 'proj-c', scope: 'project', dockerImage: 'mongo:8',
      containerName: 'cds-infra-mongo', hostPort: 0, containerPort: 27017, status: 'running', env: {},
    } as any);
    stateService.addInfraService({
      id: 'mysql', name: 'mysql', projectId: 'proj-c', scope: 'project', dockerImage: 'mysql:8',
      containerName: 'cds-infra-mysql', hostPort: 0, containerPort: 3306, status: 'running', env: {},
    } as any);
    stateService.addBranch({
      id: 'c-main', projectId: 'proj-c', branch: 'main', worktreePath: path.join(tmpDir, 'c-main'),
      services: {}, status: 'idle', createdAt: NOW,
    } as any);

    // 三条分支：main 继承；feat 对 api 钉了 shared；hotfix 对 worker 钉了 shared。
    for (const [id, branch, profileOverrides] of [
      ['b-main', 'main', undefined],
      ['b-feat', 'feat/x', { api: { dbScope: 'shared' } }],
      ['b-hotfix', 'hotfix/y', { worker: { dbScope: 'shared' } }],
    ] as const) {
      stateService.addBranch({
        id, projectId: 'proj-a', branch, worktreePath: path.join(tmpDir, id),
        services: {}, status: 'idle', createdAt: NOW,
        ...(profileOverrides ? { profileOverrides: profileOverrides as any } : {}),
      } as any);
    }
    stateService.save();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === KEY_PROJ_A) (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      if (h === KEY_PROJ_B) (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
      next();
    });
    app.use('/api', createProjectDbIsolationRouter({ stateService, assertProjectAccess: assertProjectAccess as any }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('GET', () => {
    it('列出项目内每个服务的生效档位、来源、会改写的库名 key 与分支覆盖概况', async () => {
      const res = await request(server, 'GET', '/api/projects/proj-a/db-isolation');
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe('proj-a');
      expect(res.body.readOnly).toBe(false);

      const byId = Object.fromEntries(res.body.services.map((s: any) => [s.profileId, s]));
      expect(Object.keys(byId).sort()).toEqual(['api', 'web', 'worker']);
      // 没写 = 默认 shared，来源标 default
      expect(byId.api).toMatchObject({ dbScope: 'shared', dbScopeSource: 'default', dbEnvKeys: ['CDS_POSTGRES_DB'], branchOverrideCount: 1 });
      // 没有任何数据库变量 → 不涉及数据库，不是缺库；档位对它无意义，不进 shared 计数
      expect(byId.web).toMatchObject({ dbScope: 'shared', dbScopeSource: 'default', dbEnvKeys: [], dbInvolvement: 'none', suspectDbEnvKeys: [], branchOverrideCount: 0 });
      expect(byId.api.dbInvolvement).toBe('db');
      expect(byId.worker).toMatchObject({ dbScope: 'per-branch', dbScopeSource: 'explicit', dbEnvKeys: ['CDS_MYSQL_DATABASE'], branchOverrideCount: 1 });

      expect(res.body.summary).toEqual({ services: 3, shared: 1, perBranch: 1, withoutDb: 1, branches: 3, branchesWithOverride: 2 });
      // 各分支实测要逐条列分支（探测本体走 /api/branches/:id/db-probe，这里只给清单）
      expect(res.body.branches).toEqual([
        { branchId: 'b-main', branch: 'main', status: 'idle', hasOverride: false },
        { branchId: 'b-feat', branch: 'feat/x', status: 'idle', hasOverride: true },
        { branchId: 'b-hotfix', branch: 'hotfix/y', status: 'idle', hasOverride: true },
      ]);
      expect(res.body.branchOverrides).toEqual([
        { branchId: 'b-feat', branch: 'feat/x', overrides: { api: 'shared' } },
        { branchId: 'b-hotfix', branch: 'hotfix/y', overrides: { worker: 'shared' } },
      ]);
      // 不泄露 env 值：视图只给 key 名
      expect(JSON.stringify(res.body)).not.toContain('postgres://');
    });

    it('收敛 1：框架变量与引擎中立变量被识别并标「不加后缀」，而不是提示没声明库名变量', async () => {
      const res = await request(server, 'GET', '/api/projects/proj-c/db-isolation');
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.services.map((s: any) => [s.profileId, s]));
      // .NET 双下划线：分类器认得（mongo），但白名单不改写 → dbEnvKeys 仍空，dbEnvKeyDetails 标 rewritten=false
      expect(byId.dotnet.dbEnvKeys).toEqual([]);
      expect(byId.dotnet.dbEnvKeyDetails).toEqual([
        { key: 'MongoDB__DatabaseName', engine: 'mongo', family: 'framework', rewritten: false },
      ]);
      // DB_NAME + JDBC 串：引擎从连接串读出
      expect(byId.java.dbEnvKeyDetails).toEqual([
        { key: 'DB_NAME', engine: 'mysql', family: 'neutral', rewritten: false },
      ]);
      // 纯白名单：两处一致
      expect(byId.node.dbEnvKeys).toEqual(['CDS_MYSQL_DATABASE']);
      expect(byId.node.dbEnvKeyDetails).toEqual([
        { key: 'CDS_MYSQL_DATABASE', engine: 'mysql', family: 'whitelist', rewritten: true },
      ]);
      // 值不外泄
      expect(JSON.stringify(res.body)).not.toContain('jdbc:mysql');
    });

    it('有疑似数据库变量但认不出（如只有 DATABASE_URL=mongodb://…）→ unrecognized，列出疑似变量名不报值', () => {
      const view = buildProjectDbIsolationView(
        { id: 'p', deliveryMode: undefined } as any,
        [profile({ id: 'admin', projectId: 'p', env: { DATABASE_URL: 'mongodb://u:pw@mongo:27017/prdagent' } })],
        [],
      );
      expect(view.services[0]).toMatchObject({ dbInvolvement: 'unrecognized', suspectDbEnvKeys: ['DATABASE_URL'], dbEnvKeyDetails: [] });
      expect(JSON.stringify(view)).not.toContain('u:pw');
      // unrecognized 仍算涉及数据库（要用户处理），进 shared 计数
      expect(view.summary).toMatchObject({ shared: 1, withoutDb: 0 });
    });

    it('收敛 1：项目级 customEnv 也算进「配置说的」（与定位器同口径，profile 优先）', () => {
      const view = buildProjectDbIsolationView(
        { id: 'p', deliveryMode: undefined } as any,
        [profile({ id: 'svc', projectId: 'p', env: { CDS_MYSQL_DATABASE: 'own' } })],
        [],
        { CDS_MYSQL_DATABASE: 'project_default', MongoDB__DatabaseName: 'legacy' },
      );
      expect(view.services[0].dbEnvKeyDetails.map((k) => k.key).sort()).toEqual(['CDS_MYSQL_DATABASE', 'MongoDB__DatabaseName']);
    });

    it('收敛 1：三个入口口径一致——项目视图列出的变量与复制集定位器认的是同一批', async () => {
      const branch = stateService.getBranch('c-main')!;
      const res = await request(server, 'GET', '/api/projects/proj-c/db-isolation');
      for (const id of ['dotnet', 'java', 'node']) {
        const svc = res.body.services.find((s: any) => s.profileId === id);
        const p = stateService.getBuildProfile(id)!;
        const { target } = resolveReplicaDbTarget(stateService, branch, resolveEffectiveProfile(p, branch));
        expect(target, `${id} 应能被定位器定位`).not.toBeNull();
        expect(svc.dbEnvKeyDetails.map((k: any) => k.key).sort()).toEqual([...target!.envKeys].sort());
        expect(svc.dbEnvKeyDetails[0].engine).toBe(target!.engine);
      }
    });

    it('别的项目的服务不混进来', async () => {
      const res = await request(server, 'GET', '/api/projects/proj-b/db-isolation');
      expect(res.status).toBe(200);
      expect(res.body.services.map((s: any) => s.profileId)).toEqual(['b-api']);
    });

    it('托管交付项目标 readOnly 并给出原因', async () => {
      const res = await request(server, 'GET', '/api/projects/proj-managed/db-isolation');
      expect(res.status).toBe(200);
      expect(res.body.readOnly).toBe(true);
      expect(res.body.readOnlyReason).toContain('托管');
      expect(res.body.services.map((s: any) => s.profileId)).toEqual(['managed-api']);
    });

    it('项目不存在 → 404', async () => {
      const res = await request(server, 'GET', '/api/projects/nope/db-isolation');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT（原子批量写）', () => {
    it('all 一次把项目内所有服务设为分支独立库，回包告知影响面并附最新视图', async () => {
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { all: 'per-branch' });
      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([
        { profileId: 'api', from: 'shared', to: 'per-branch' },
        { profileId: 'web', from: 'shared', to: 'per-branch' },
      ]);
      // worker 本来就是 per-branch，不算变更
      expect(res.body.unchanged).toEqual(['worker']);
      // main / hotfix 对 api、web 没有覆盖 → 跟着变；feat 对 api 钉了 shared → 保持
      expect(res.body.affectedBranches).toBe(3);
      expect(res.body.keptBranchOverrides).toBe(1);
      expect(typeof res.body.snapshotId).toBe('string');
      expect(res.body.message).toContain('重新部署后生效');
      expect(res.body.message).toContain('本分支覆盖保持不变');
      // web 不涉及数据库，不进档位计数
      expect(res.body.view.summary).toMatchObject({ shared: 0, perBranch: 2, withoutDb: 1 });

      // SSOT 仍是 BuildProfile.dbScope
      expect(stateService.getBuildProfile('api')!.dbScope).toBe('per-branch');
      expect(stateService.getBuildProfile('web')!.dbScope).toBe('per-branch');
      // 别的项目一根毫毛都没动
      expect(stateService.getBuildProfile('b-api')!.dbScope).toBeUndefined();
    });

    it('services 逐服务写；同时给 all 时逐服务条目优先', async () => {
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', {
        all: 'per-branch',
        services: { web: 'shared' },
      });
      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([{ profileId: 'api', from: 'shared', to: 'per-branch' }]);
      expect(stateService.getBuildProfile('web')!.dbScope).toBeUndefined();
      expect(stateService.getBuildProfile('api')!.dbScope).toBe('per-branch');
    });

    it('分支覆盖原样保留：项目级写入不碰 profileOverrides', async () => {
      const before = JSON.stringify(stateService.getBranch('b-feat')!.profileOverrides);
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { all: 'per-branch' });
      expect(res.status).toBe(200);
      expect(JSON.stringify(stateService.getBranch('b-feat')!.profileOverrides)).toBe(before);
      expect(JSON.stringify(stateService.getBranch('b-hotfix')!.profileOverrides)).toBe(JSON.stringify({ worker: { dbScope: 'shared' } }));
      expect(stateService.getBranch('b-main')!.profileOverrides).toBeUndefined();
    });

    it('真实部署路径：继承的分支库名被后缀，钉了 shared 覆盖的分支库名不动', async () => {
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { services: { api: 'per-branch' } });
      expect(res.status).toBe(200);

      const api = stateService.getBuildProfile('api')!;
      const main = stateService.getBranch('b-main')!;
      const feat = stateService.getBranch('b-feat')!;
      // 与 container.ts 部署链同源：先合并分支覆盖，再按最终 dbScope 改写库名。
      const mainEffective = resolveEffectiveProfile(api, main);
      const featEffective = resolveEffectiveProfile(api, feat);
      expect(mainEffective.dbScope).toBe('per-branch');
      expect(featEffective.dbScope).toBe('shared');
      expect(applyPerBranchDbIsolation(api.env!, mainEffective.dbScope, main.branch).CDS_POSTGRES_DB).toBe('app_main');
      expect(applyPerBranchDbIsolation(api.env!, featEffective.dbScope, feat.branch).CDS_POSTGRES_DB).toBe('app');
    });

    it('值非法 → 400 且整批不落盘', async () => {
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', {
        services: { api: 'per-branch', web: 'bogus' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('web');
      expect(stateService.getBuildProfile('api')!.dbScope).toBeUndefined();
    });

    it('profileId 不属于本项目 → 400 列出未知 id，且整批不落盘（含别的项目的 id）', async () => {
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', {
        services: { api: 'per-branch', 'b-api': 'per-branch', ghost: 'shared' },
      });
      expect(res.status).toBe(400);
      expect(res.body.unknownProfileIds).toEqual(['b-api', 'ghost']);
      expect(res.body.error).toContain('整批未写入');
      expect(stateService.getBuildProfile('api')!.dbScope).toBeUndefined();
      expect(stateService.getBuildProfile('b-api')!.dbScope).toBeUndefined();
    });

    it('空请求体 / 两者都不给 / services 为空 → 400', async () => {
      expect((await request(server, 'PUT', '/api/projects/proj-a/db-isolation', {})).status).toBe(400);
      expect((await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { services: {} })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { all: 'nope' })).status).toBe(400);
    });

    it('没有实际变更时不拍快照、不记破坏性操作', async () => {
      const snapshotsBefore = stateService.getState().configSnapshots?.length || 0;
      const res = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { services: { worker: 'per-branch' } });
      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([]);
      expect(res.body.snapshotId).toBeUndefined();
      expect(stateService.getState().configSnapshots?.length || 0).toBe(snapshotsBefore);
    });

    it('托管交付项目 → 409', async () => {
      const res = await request(server, 'PUT', '/api/projects/proj-managed/db-isolation', { all: 'per-branch' });
      expect(res.status).toBe(409);
    });

    it('项目 key 只能改自己的项目：B 的 key 改 A → 403，A 的 key 改 A → 200', async () => {
      const denied = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { all: 'per-branch' }, { 'x-test-key': KEY_PROJ_B });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('project_mismatch');
      expect(stateService.getBuildProfile('api')!.dbScope).toBeUndefined();

      const deniedRead = await request(server, 'GET', '/api/projects/proj-a/db-isolation', undefined, { 'x-test-key': KEY_PROJ_B });
      expect(deniedRead.status).toBe(403);

      const ok = await request(server, 'PUT', '/api/projects/proj-a/db-isolation', { all: 'per-branch' }, { 'x-test-key': KEY_PROJ_A });
      expect(ok.status).toBe(200);
    });
  });
});

describe('纯函数：plan / view / 影响面', () => {
  const profiles: BuildProfile[] = [
    profile({ id: 'api', projectId: 'p', env: { POSTGRES_DB: 'app' } }),
    profile({ id: 'web', projectId: 'p', dbScope: 'shared' }),
  ];

  it('plan：显式 shared 与默认 shared 都不算变更，避免制造假变更', () => {
    const plan = planProjectDbIsolationWrite(profiles, { all: 'shared' });
    expect(plan).toEqual({ ok: true, changes: [], unchanged: ['api', 'web'] });
  });

  it('plan：非对象 / 数组 services 拒绝', () => {
    expect(planProjectDbIsolationWrite(profiles, null).ok).toBe(false);
    expect(planProjectDbIsolationWrite(profiles, { services: ['api'] } as any).ok).toBe(false);
  });

  it('view：兼容存量无 dbScope 的 profile 与无 profileOverrides 的分支', () => {
    const view = buildProjectDbIsolationView({ id: 'p' }, profiles, [
      { id: 'b1', projectId: 'p', branch: 'main', worktreePath: '', services: {}, status: 'idle', createdAt: NOW } as any,
    ]);
    expect(view.readOnly).toBe(false);
    expect(view.services.map((s) => s.dbScopeSource)).toEqual(['default', 'explicit']);
    expect(view.branchOverrides).toEqual([]);
    expect(view.summary).toEqual({ services: 2, shared: 1, perBranch: 0, withoutDb: 1, branches: 1, branchesWithOverride: 0 });
  });

  it('影响面：同一分支既继承某服务又覆盖另一服务时两边都计数', () => {
    const branches = [
      { id: 'b1', projectId: 'p', branch: 'main', worktreePath: '', services: {}, status: 'idle', createdAt: NOW,
        profileOverrides: { api: { dbScope: 'shared' } } } as any,
    ];
    const changes = [
      { profileId: 'api', from: 'shared', to: 'per-branch' },
      { profileId: 'web', from: 'shared', to: 'per-branch' },
    ] as const;
    expect(countAffectedBranches(branches, [...changes])).toEqual({ affectedBranches: 1, keptBranchOverrides: 1 });
    expect(countAffectedBranches(branches, [])).toEqual({ affectedBranches: 0, keptBranchOverrides: 0 });
  });
});
