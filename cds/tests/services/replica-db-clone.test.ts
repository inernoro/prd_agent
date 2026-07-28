/**
 * 复制集一键隔离数据库 — resolveReplicaDbTarget 契约测试（design.cds.replica-set MVP-2）
 *
 * 验证:
 *   1. env 无数据库名 key → 带原因失败
 *   2. dbScope=per-branch 时源库名折算成运行时真实库名（含分支后缀）
 *   3. 同引擎的 CDS_ 前缀与裸名 key 一起收集为覆写目标
 *   4. infra 未运行 → 带原因失败；dependsOn 优先选中声明的实例
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { isolatedDbNameFor, resolveReplicaDbTarget } from '../../src/services/replica-db-clone.js';
import type { BranchEntry, BuildProfile, InfraService } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

let tmpDir: string;
let state: StateService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rs-db-'));
  state = new StateService(path.join(tmpDir, 'state.json'));
  state.addProject({
    id: 'proj', slug: 'demo', name: 'demo', createdAt: new Date().toISOString(),
  } as Parameters<typeof state.addProject>[0]);
});

afterEach(async () => {
  await flushAllJsonStateStores();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-main',
    projectId: 'proj',
    branch: 'claude/feat-x',
    worktreePath: '/tmp/x',
    services: {},
    status: 'running',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as BranchEntry;
}

function profile(overrides: Partial<BuildProfile> = {}): BuildProfile {
  return {
    id: 'api', projectId: 'proj', name: 'api', dockerImage: 'node:20', workDir: '.', containerPort: 3000,
    ...overrides,
  } as BuildProfile;
}

function addInfra(id: string, image: string, env: Record<string, string> = {}, status = 'running'): void {
  state.addInfraService({
    id, name: id, projectId: 'proj', scope: 'project',
    dockerImage: image, containerName: `cds-infra-${id}`,
    hostPort: 0, containerPort: 3306, status, env,
  } as unknown as InfraService);
}

describe('resolveReplicaDbTarget', () => {
  it('env 无数据库名 key 时带原因失败', () => {
    const { target, reason } = resolveReplicaDbTarget(state, branch(), profile());
    expect(target).toBeNull();
    expect(reason).toContain('没有数据库名');
  });

  it('per-branch dbScope 折算运行时真实库名 + 收集同引擎全部 key', () => {
    state.setCustomEnv({ CDS_MYSQL_DATABASE: 'app', MYSQL_DATABASE: 'app' }, 'proj');
    addInfra('mysql', 'mysql:8', { MYSQL_ROOT_PASSWORD: 'pw' });
    const { target } = resolveReplicaDbTarget(
      state,
      branch(),
      profile({ dbScope: 'per-branch' }),
    );
    expect(target).not.toBeNull();
    expect(target!.engine).toBe('mysql');
    expect(target!.sourceDb).toBe('app_claude_feat_x');
    expect(target!.envKeys.sort()).toEqual(['CDS_MYSQL_DATABASE', 'MYSQL_DATABASE']);
  });

  it('infra 未运行时带原因失败', () => {
    state.setCustomEnv({ MONGO_INITDB_DATABASE: 'appdb' }, 'proj');
    addInfra('mongo', 'mongo:7', {}, 'stopped');
    const { target, reason } = resolveReplicaDbTarget(state, branch(), profile());
    expect(target).toBeNull();
    expect(reason).toContain('mongo');
  });

  it('识别 .NET 框架风格 MongoDB__DatabaseName（验收 P1-1 回归）', () => {
    state.setCustomEnv({ MongoDB__DatabaseName: 'prdagent' }, 'proj');
    addInfra('mongo', 'mongo:7', { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'pw' });
    const { target, reason } = resolveReplicaDbTarget(state, branch(), profile());
    expect(reason).toBeUndefined();
    expect(target).not.toBeNull();
    expect(target!.engine).toBe('mongo');
    expect(target!.sourceDb).toBe('prdagent');
    expect(target!.envKeys).toEqual(['MongoDB__DatabaseName']);
  });

  it('识别 Mongo 连接串 env key（专用隔离实例通道的改指前提）', () => {
    state.setCustomEnv({
      MongoDB__DatabaseName: 'prdagent',
      MongoDB__ConnectionString: 'mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}',
      MONGO_URI: 'mongodb://x:1',
      Redis__ConnectionString: 'redis:1',
    }, 'proj');
    addInfra('mongo', 'mongo:7', {});
    const { target } = resolveReplicaDbTarget(state, branch(), profile());
    expect(target!.connEnvKeys.sort()).toEqual(['MONGO_URI', 'MongoDB__ConnectionString']);
  });

  it('同引擎但值不同的 key 不被一起覆写（init 库不等于应用库）', () => {
    state.setCustomEnv({ MongoDB__DatabaseName: 'prdagent', MONGO_INITDB_DATABASE: 'admin_init' }, 'proj');
    addInfra('mongo', 'mongo:7', {});
    const { target } = resolveReplicaDbTarget(state, branch(), profile());
    expect(target).not.toBeNull();
    // 框架 key 优先作为源库；值不同的白名单 key 不进覆写清单
    expect(target!.sourceDb).toBe('prdagent');
    expect(target!.envKeys).toEqual(['MongoDB__DatabaseName']);
  });

  it('MySql__Database / Postgres__Database 框架变体也能归类', () => {
    state.setCustomEnv({ MySql__Database: 'shop' }, 'proj');
    addInfra('mysql', 'mysql:8', { MYSQL_ROOT_PASSWORD: 'pw' });
    const a = resolveReplicaDbTarget(state, branch(), profile());
    expect(a.target?.engine).toBe('mysql');
    expect(a.target?.sourceDb).toBe('shop');

    state.setCustomEnv({ Postgres__Database: 'ledger' }, 'proj');
    addInfra('pg', 'postgres:16', { POSTGRES_PASSWORD: 'pw' });
    const b = resolveReplicaDbTarget(state, branch(), profile());
    expect(b.target?.engine).toBe('postgres');
    expect(b.target?.sourceDb).toBe('ledger');
  });

  it('隔离库名生成必须自证通过白名单（复验 R2-P1-1：guard-N/res-N 连字符归一）', () => {
    const SAFE = /^[a-z0-9_]+$/;
    // isolateProfile / startDbGuard 的真实生成格式是 guard-<N>；addMember 的是 res-<N>；
    // 库名含分支哈希段（Codex P1：防跨分支 guard-1 同名互杀），格式 <源库>_rs_<hash6>_<成员>
    expect(isolatedDbNameFor('prdagent', 'guard-1', 'br-a', 'api')).toMatch(/^prdagent_rs_[0-9a-f]{6}_guard_1$/);
    expect(isolatedDbNameFor('prdagent', 'res-2', 'br-a', 'api')).toMatch(/^prdagent_rs_[0-9a-f]{6}_res_2$/);
    for (const memberId of ['guard-1', 'guard-12', 'res-1', 'res-3', 'rsfa7a2b']) {
      const name = isolatedDbNameFor('prdagent', memberId, 'proj-main', 'api');
      expect(SAFE.test(name), `${memberId} → ${name} 必须通过 DB_NAME_SAFE`).toBe(true);
      expect(name).toContain('_rs_'); // dropReplicaDb 的删除守卫要求
    }
  });

  it('同源库同成员 id 在不同分支/不同 profile 生成不同库名（Codex P1 两连：跨分支与跨 profile 同名互杀）', () => {
    const a = isolatedDbNameFor('prdagent', 'guard-1', 'proj-branch-a', 'api');
    const b = isolatedDbNameFor('prdagent', 'guard-1', 'proj-branch-b', 'api');
    const c = isolatedDbNameFor('prdagent', 'res-1', 'proj-branch-a', 'api');
    const d = isolatedDbNameFor('prdagent', 'res-1', 'proj-branch-a', 'web');
    expect(a).not.toBe(b);      // 跨分支唯一
    expect(c).not.toBe(d);      // 同分支跨 profile 唯一（res-N 按 profile 顺位命名必然重复）
    // 同作用域重复调用必须稳定（快照复用/删除守卫都依赖确定性命名）
    expect(isolatedDbNameFor('prdagent', 'guard-1', 'proj-branch-a', 'api')).toBe(a);
  });

  it('dependsOn 优先选中显式声明的 infra 实例', () => {
    state.setCustomEnv({ POSTGRES_DB: 'main' }, 'proj');
    addInfra('pg-a', 'postgres:16', { POSTGRES_PASSWORD: 'a' });
    addInfra('pg-b', 'postgres:16', { POSTGRES_PASSWORD: 'b' });
    const { target } = resolveReplicaDbTarget(
      state,
      branch(),
      profile({ dependsOn: ['pg-b'] }),
    );
    expect(target!.infra.id).toBe('pg-b');
  });
});

describe('envOverrideFromSnapshot 统一战线同库复用（2026-07-25）', () => {
  it('专用实例快照：库名键 + 连接串键都覆写到既有实例', async () => {
    const { envOverrideFromSnapshot } = await import('../../src/services/replica-db-clone.js');
    const target = {
      engine: 'mongo', sourceDb: 'prdagent', envKeys: ['MongoDB__DatabaseName'],
      connEnvKeys: ['MongoDB__ConnectionString'],
    } as never;
    const snap = {
      id: 'rsdb_guard-1', profileId: 'api', memberId: 'guard-1', engine: 'mongo',
      sourceDb: 'prdagent', dbName: 'prdagent_rs_guard_1',
      dedicatedContainer: 'cds-rsdb-prdagent_rs_guard_1', dedicatedHostPort: 12345,
      clonedAt: new Date().toISOString(),
    } as never;
    const env = envOverrideFromSnapshot(target, snap);
    expect(env.MongoDB__DatabaseName).toBe('prdagent_rs_guard_1');
    expect(env.MongoDB__ConnectionString).toBe('mongodb://${CDS_HOST}:12345');
  });

  it('带认证标记的专用实例快照：连接串带源库 root 凭据（percent-encode + authSource=admin）', async () => {
    const { envOverrideFromSnapshot } = await import('../../src/services/replica-db-clone.js');
    const target = {
      engine: 'mongo', sourceDb: 'prdagent', envKeys: ['MongoDB__DatabaseName'],
      connEnvKeys: ['MongoDB__ConnectionString'],
      infra: { env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'p@ss$1' } },
    } as never;
    const snap = {
      id: 'rsdb_guard-1', profileId: 'api', memberId: 'guard-1', engine: 'mongo',
      sourceDb: 'prdagent', dbName: 'prdagent_rs_abc123_guard_1',
      dedicatedContainer: 'cds-rsdb-prdagent_rs_abc123_guard_1', dedicatedHostPort: 12345,
      dedicatedAuth: 'source-infra',
      clonedAt: new Date().toISOString(),
    } as never;
    const env = envOverrideFromSnapshot(target, snap);
    // $ 必须被编码为 %24，否则会撞上容器 env 的 ${VAR} 模板展开
    expect(env.MongoDB__ConnectionString).toBe('mongodb://root:p%40ss%241@${CDS_HOST}:12345/?authSource=admin');
  });

  it('共享实例快照（mysql/pg 通道）：只覆写库名键，不动连接串', async () => {
    const { envOverrideFromSnapshot } = await import('../../src/services/replica-db-clone.js');
    const target = { engine: 'mysql', sourceDb: 'app', envKeys: ['MYSQL_DATABASE'], connEnvKeys: ['DATABASE_URL'] } as never;
    const snap = { id: 'rsdb_guard-2', profileId: 'api', memberId: 'guard-2', engine: 'mysql', sourceDb: 'app', dbName: 'app_rs_guard_2', clonedAt: new Date().toISOString() } as never;
    const env = envOverrideFromSnapshot(target, snap);
    expect(env.MYSQL_DATABASE).toBe('app_rs_guard_2');
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

/**
 * 引擎中立 key 只能兜底，不许压过自带引擎的 key（Codex PR #1275 四轮 P1）。
 *
 * 项目级 customEnv 会把一个泛化的 DB_NAME 灌给全部服务。若它与 profile 自己的
 * MYSQL_DATABASE 并列，而排序只按「框架 key 优先」，两者同档 → 退化成 merged env
 * 的插入顺序（project → branch → profile），项目级那个先进来就赢：sourceDb 取到
 * 与本服务无关的库名 → 克隆错库；应用连接串路径段对不上这个值 → urlEnvValues
 * 漏掉它 → 副本仍打源库，控制面还报「隔离成功」。
 */
describe('库名 key 的取用优先级', () => {
  it('自带引擎的 MYSQL_DATABASE 压过项目级泛化 DB_NAME', () => {
    addInfra('mysql', 'mysql:8');
    // 项目级先灌一个与本服务无关的 DB_NAME，profile 自己声明真正的库
    state.setCustomEnv({ DB_NAME: 'unrelated_project_db', DATABASE_URL: 'mysql://h:3306/appdb' }, 'proj');
    const { target, reason } = resolveReplicaDbTarget(
      state,
      branch(),
      profile({ env: { MYSQL_DATABASE: 'appdb' } }),
    );
    expect(reason).toBeUndefined();
    expect(target?.engine).toBe('mysql');
    expect(target?.sourceDb).toBe('appdb');
    // 应用真正读的连接串必须进改写集合（路径段与 sourceDb 对得上）
    expect(Object.keys(target?.urlEnvValues || {})).toContain('DATABASE_URL');
  });

  it('没有自带引擎的 key 时，中立 DB_NAME 仍然照常兜底（不能因为加了优先级就失效）', () => {
    addInfra('mysql', 'mysql:8');
    state.setCustomEnv({ DB_NAME: 'impdb', SPRING_DATASOURCE_URL: 'jdbc:mysql://h:3306/impdb' }, 'proj');
    const { target, reason } = resolveReplicaDbTarget(state, branch(), profile());
    expect(reason).toBeUndefined();
    expect(target?.engine).toBe('mysql');
    expect(target?.sourceDb).toBe('impdb');
    expect(Object.keys(target?.urlEnvValues || {})).toContain('SPRING_DATASOURCE_URL');
  });
});
