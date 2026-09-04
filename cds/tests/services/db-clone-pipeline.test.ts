/**
 * 数据库隔离收敛 4：克隆管线入参抽成「来源库、目标库、作用域」三元组；逐表行数校验；
 * 分支独立库「时间点克隆」初始化（首次部署前从共享库克隆，克隆时间点与校验结果进台账）。
 *
 * docker 全部走注入的 exec 桩，按 argv 内容应答。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import {
  relationalCloneArgv, parseTableCounts, compareTableCounts, verifyCloneRowCounts, cloneRelationalDbInPlace,
  type DbCloneExec, type DbCloneSpec,
} from '../../src/services/db-clone-pipeline.js';
import { perBranchCloneSpec, ensurePerBranchDbInitialized } from '../../src/services/per-branch-db-init.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import type { BranchEntry, BuildProfile, InfraService } from '../../src/types.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = new Date('2026-09-04T02:00:00.000Z');

const mysqlInfra = {
  id: 'mysql', name: 'mysql', projectId: 'p', scope: 'project', dockerImage: 'mysql:8', containerName: 'cds-infra-mysql',
  hostPort: 0, containerPort: 3306, status: 'running', env: { MYSQL_ROOT_PASSWORD: 'rootpw' },
} as unknown as InfraService;
const pgInfra = { ...mysqlInfra, id: 'pg', name: 'pg', dockerImage: 'postgres:16', containerName: 'cds-infra-pg', containerPort: 5432, env: { POSTGRES_PASSWORD: 'pgpw', POSTGRES_USER: 'app' } } as unknown as InfraService;
const mongoInfra = { ...mysqlInfra, id: 'mongo', name: 'mongo', dockerImage: 'mongo:7', containerName: 'cds-infra-mongo', containerPort: 27017, env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'mpw' } } as unknown as InfraService;

function spec(o: Partial<DbCloneSpec> = {}): DbCloneSpec {
  return { engine: 'mysql', infra: mysqlInfra, sourceDb: 'shop', targetDb: 'shop_feat_x', scope: { kind: 'per-branch', projectId: 'p', branchId: 'p-feat-x', profileId: 'api' }, ...o };
}

/** 按 argv 应答的 docker 桩：记录克隆脚本；表清单 / 行数按「库名 → 表 → 行数」的字典回答 */
function fakeExec(world: Record<string, Record<string, number>>, log: string[] = []): DbCloneExec {
  return async (argv) => {
    const joined = argv.join(' ');
    const sql = argv[argv.length - 1];
    if (argv[0] === 'run') {
      log.push(`clone:${joined.includes('mysqldump') ? 'mysql' : joined.includes('pg_dump') ? 'postgres' : '?'}`);
      const m = /(?:mysqldump|pg_dump)[^;]*?\s(\w+)\s*>\s*\/tmp\/rsclone\.sql;[^;]*?(?:mysql|psql)[^;]*?\s(?:-d )?(\w+)\s*<\s*\/tmp\/rsclone\.sql/.exec(sql);
      if (m) world[m[2]] = { ...(world[m[1]] ?? {}) };
      return { code: 0, stdout: '', stderr: '' };
    }
    const dIdx = argv.indexOf('-d');
    const schema = dIdx >= 0 ? argv[dIdx + 1] : /table_schema\s*=\s*'(\w+)'/.exec(sql)?.[1];
    if (/information_schema\.tables/.test(sql)) {
      const tables = Object.keys(world[schema] ?? {});
      return { code: 0, stdout: tables.map((t) => `${t}\n`).join(''), stderr: '' };
    }
    if (/COUNT\(\*\)/.test(sql)) {
      const db = /FROM\s+`?(\w+)`?\.`?\w+`?/.exec(sql)?.[1] ?? schema;
      const rows = [...sql.matchAll(/SELECT '(\w+)'/g)].map((x) => x[1]).map((t) => `${t}\t${world[db]?.[t] ?? 0}`);
      return { code: 0, stdout: rows.join('\n'), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected argv: ${joined}` };
  };
}

describe('克隆三元组：脚本只从来源库、目标库、实例取值', () => {
  it('mysql 与 postgres 的克隆脚本都长在三元组上，凭据经 -e 注入而不进脚本正文', () => {
    const my = relationalCloneArgv(spec());
    expect(my.argv[0]).toBe('run');
    expect(my.argv).toContain('container:cds-infra-mysql');
    const myScript = my.argv[my.argv.length - 1];
    expect(myScript).toContain('mysqldump');
    expect(myScript).toContain(' shop > /tmp/rsclone.sql');
    expect(myScript).toContain('mysql -h127.0.0.1 -P3306 -uroot shop_feat_x < /tmp/rsclone.sql');
    expect(myScript).not.toContain('rootpw');
    expect(my.argv).toContain('MYSQL_PWD=rootpw');
    expect(my.secrets).toEqual(['rootpw']);

    const pg = relationalCloneArgv(spec({ engine: 'postgres', infra: pgInfra, targetDb: 'shop_feat_y' }));
    const pgScript = pg.argv[pg.argv.length - 1];
    expect(pgScript).toContain('pg_dump -h 127.0.0.1 -p 5432 -U app shop > /tmp/rsclone.sql');
    expect(pgScript).toContain('-d shop_feat_y < /tmp/rsclone.sql');
    expect(pg.argv).toContain('PGPASSWORD=pgpw');
  });

  it('带 grantTo：克隆完把目标库授权给应用用户（真实 mysql 分支复验的 ERROR 1044 根因）；用户名不安全拒绝', () => {
    const my = relationalCloneArgv(spec({ grantTo: 'shop_app' }));
    const myScript = my.argv[my.argv.length - 1];
    // sh 单引号包住整条 -e：双引号里的反引号会被 sh 当命令替换（真实分支复验踩过）
    expect(myScript).toContain(`-e 'GRANT ALL PRIVILEGES ON shop_feat_x.* TO "shop_app"@"%"; FLUSH PRIVILEGES'`);
    expect(myScript).not.toMatch(/"[^"]*\`shop_feat_x\`[^"]*"/);
    expect(myScript.indexOf('GRANT')).toBeGreaterThan(myScript.indexOf('< /tmp/rsclone.sql'));
    const pg = relationalCloneArgv(spec({ engine: 'postgres', infra: pgInfra, grantTo: 'shop_app' }));
    const pgScript = pg.argv[pg.argv.length - 1];
    expect(pgScript).toContain('GRANT ALL PRIVILEGES ON DATABASE "shop_feat_x" TO "shop_app"');
    expect(pgScript).toContain('GRANT ALL ON ALL TABLES IN SCHEMA public TO "shop_app"');
    expect(() => relationalCloneArgv(spec({ grantTo: "x'; DROP" }))).toThrow(/不安全/);
    expect(relationalCloneArgv(spec()).argv.join(' ')).not.toContain('GRANT');
  });

  it('目标库与源库同名、库名含不安全字符、mongo 引擎：一律拒绝，不生成脚本', () => {
    expect(() => relationalCloneArgv(spec({ targetDb: 'shop' }))).toThrow(/目标库不能等于源库/);
    expect(() => relationalCloneArgv(spec({ targetDb: 'shop;drop' }))).toThrow(/不合法/);
    expect(() => relationalCloneArgv(spec({ engine: 'mongo', infra: mongoInfra }))).toThrow(/mongo/);
  });

  it('实例记录里的密码还是 ${...} 模板：拒绝生成脚本并指出缺哪个变量（真实 mysql 分支复验的 Access denied 根因）', () => {
    const templated = { ...mysqlInfra, env: { MYSQL_ROOT_PASSWORD: '${CDS_MYSQL_ROOT_PASSWORD}' } } as unknown as InfraService;
    expect(() => relationalCloneArgv(spec({ infra: templated }))).toThrow(/MYSQL_ROOT_PASSWORD 仍是未解析的模板/);
    const pgTemplated = { ...pgInfra, env: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: '${CDS_PG_PASSWORD}' } } as unknown as InfraService;
    expect(() => relationalCloneArgv(spec({ engine: 'postgres', infra: pgTemplated }))).toThrow(/POSTGRES_PASSWORD 仍是未解析的模板/);
  });

  it('克隆执行：exec 退出码非 0 就抛错，错误里不出现密码', async () => {
    const exec: DbCloneExec = async () => ({ code: 1, stdout: '', stderr: 'Access denied for user root (using password: rootpw)' });
    await expect(cloneRelationalDbInPlace(spec(), { exec })).rejects.toThrow(/Access denied/);
    await expect(cloneRelationalDbInPlace(spec(), { exec })).rejects.not.toThrow(/rootpw/);
  });
});

describe('逐表行数校验', () => {
  it('解析 mysql 制表符与 postgres 竖线两种客户端输出', () => {
    expect(parseTableCounts('users\t3\norders\t10\n')).toEqual({ users: 3, orders: 10 });
    expect(parseTableCounts('users|3\norders|10')).toEqual({ users: 3, orders: 10 });
    expect(parseTableCounts('')).toEqual({});
  });

  it('克隆中途源库多写一行：校验表指出那一张表，其余表一致', () => {
    const v = compareTableCounts({ users: 3, orders: 11 }, { users: 3, orders: 10 }, NOW);
    expect(v.ok).toBe(false);
    expect(v.mismatched).toEqual(['orders']);
    expect(v.tables).toEqual([{ table: 'orders', source: 11, target: 10 }, { table: 'users', source: 3, target: 3 }]);
    expect(v.sourceOnly).toEqual([]);
    expect(v.targetOnly).toEqual([]);
    expect(v.measuredAt).toBe(NOW.toISOString());
  });

  it('一边缺表也算不一致，并分别列出只在源库 / 只在目标库的表', () => {
    const v = compareTableCounts({ users: 3, audit: 0 }, { users: 3, tmp_x: 1 }, NOW);
    expect(v.ok).toBe(false);
    expect(v.sourceOnly).toEqual(['audit']);
    expect(v.targetOnly).toEqual(['tmp_x']);
  });

  it('verifyCloneRowCounts 用注入的 exec 查两边表清单与行数后比对', async () => {
    const world = { shop: { users: 3, orders: 11 }, shop_feat_x: { users: 3, orders: 10 } };
    const v = await verifyCloneRowCounts(spec(), { exec: fakeExec(world) });
    expect(v.ok).toBe(false);
    expect(v.mismatched).toEqual(['orders']);
    const same = await verifyCloneRowCounts(spec(), { exec: fakeExec({ shop: { users: 3 }, shop_feat_x: { users: 3 } }) });
    expect(same.ok).toBe(true);
    expect(same.tables).toEqual([{ table: 'users', source: 3, target: 3 }]);
  });
});

describe('分支独立库时间点克隆初始化', () => {
  let tmpDir: string; let state: StateService;
  const branch = (): BranchEntry => state.getBranch('p-feat-x')!;
  const effective = (profileId: string): BuildProfile => resolveEffectiveProfile(state.getBuildProfile(profileId)!, branch());

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-db-clone-init-'));
    state = new StateService(path.join(tmpDir, 'state.json'), tmpDir); state.load();
    const T = NOW.toISOString();
    state.addProject({ id: 'p', slug: 'p', name: 'P', kind: 'git', createdAt: T, updatedAt: T } as any);
    state.addBuildProfile({ id: 'api', projectId: 'p', name: 'API', dockerImage: 'node:20', workDir: '.', containerPort: 3000, dbScope: 'per-branch', dbInit: 'clone', env: { CDS_MYSQL_DATABASE: 'shop', CDS_MYSQL_USER: 'shop_app', CDS_MYSQL_PASSWORD: 'apppw' } } as BuildProfile);
    state.addBuildProfile({ id: 'jobs', projectId: 'p', name: 'Jobs', dockerImage: 'node:20', workDir: '.', containerPort: 3001, dbScope: 'per-branch', env: { CDS_MYSQL_DATABASE: 'shop' } } as BuildProfile);
    // 真实项目的写法：连接串用模板，部署时才展开；克隆授权要解析出真实用户名 shop_app 而不是 ${CDS_MYSQL_USER}
    state.addBuildProfile({ id: 'api2', projectId: 'p', name: 'API2', dockerImage: 'node:20', workDir: '.', containerPort: 3003, dbScope: 'per-branch', dbInit: 'clone', env: { CDS_MYSQL_DATABASE: 'shop', DATABASE_URL: 'mysql://${CDS_MYSQL_USER}:${CDS_MYSQL_PASSWORD}@cds-infra-mysql:3306/shop' } } as BuildProfile);
    state.setCustomEnv({ CDS_MYSQL_USER: 'shop_app', CDS_MYSQL_PASSWORD: 'apppw' }, 'p');
    state.addBuildProfile({ id: 'search', projectId: 'p', name: 'Search', dockerImage: 'node:20', workDir: '.', containerPort: 3002, dbScope: 'per-branch', dbInit: 'clone', env: { CDS_MONGO_DATABASE: 'catalog' } } as BuildProfile);
    state.addBuildProfile({ id: 'web', projectId: 'p', name: 'Web', dockerImage: 'nginx', workDir: '.', containerPort: 80, dbScope: 'per-branch', dbInit: 'clone', env: {} } as BuildProfile);
    // 深拷贝：updateInfraService 会原地改对象，别把模块级常量污染给后面的用例
    state.addInfraService({ ...mysqlInfra, env: { ...mysqlInfra.env } } as InfraService);
    state.addInfraService({ ...mongoInfra, env: { ...mongoInfra.env } } as InfraService);
    state.addBranch({ id: 'p-feat-x', projectId: 'p', branch: 'feat/x', worktreePath: path.join(tmpDir, 'wt'), status: 'running', createdAt: T, services: {} } as unknown as BranchEntry);
    state.save();
  });
  afterEach(() => { flushAllJsonStateStores(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('实例记录里的 ${CDS_MYSQL_ROOT_PASSWORD} 按项目环境变量解析后才进三元组；解不出来的保留模板原样', () => {
    state.updateInfraService('mysql', { env: { MYSQL_ROOT_PASSWORD: '${CDS_MYSQL_ROOT_PASSWORD}', MYSQL_DATABASE: '${NOPE}' } }, 'p');
    state.setCustomEnv({ CDS_MYSQL_ROOT_PASSWORD: 'real-root-pw' }, 'p');
    state.save();
    const r = perBranchCloneSpec(state, branch(), effective('api'));
    expect('spec' in r && r.spec.infra.env?.MYSQL_ROOT_PASSWORD).toBe('real-root-pw');
    expect('spec' in r && r.spec.infra.env?.MYSQL_DATABASE).toBe('${NOPE}');
    expect(state.getInfraService('mysql')?.env?.MYSQL_ROOT_PASSWORD).toBe('${CDS_MYSQL_ROOT_PASSWORD}');
  });

  it('三元组：来源是共享库 shop，目标是折算后的 shop_feat_x，作用域带项目 / 分支 / 服务', () => {
    const r = perBranchCloneSpec(state, branch(), effective('api'));
    expect('spec' in r && r.spec).toMatchObject({ engine: 'mysql', sourceDb: 'shop', targetDb: 'shop_feat_x', scope: { kind: 'per-branch', projectId: 'p', branchId: 'p-feat-x', profileId: 'api' } });
    expect('spec' in r && r.spec.infra.containerName).toBe('cds-infra-mysql');
    // 克隆完授权给应用自己的用户（与库探测同一套凭据解析）；没声明应用用户的服务不授权
    expect('spec' in r && r.spec.grantTo).toBe('shop_app');
    // 只有项目级 CDS_MYSQL_USER 的服务同样授给它（项目级变量本来就会灌给每个服务）
    const jobs = perBranchCloneSpec(state, branch(), effective('jobs'));
    expect('spec' in jobs && jobs.spec.grantTo).toBe('shop_app');
    const api2 = perBranchCloneSpec(state, branch(), effective('api2'));
    expect('spec' in api2 && api2.spec.grantTo).toBe('shop_app');
  });

  it('mongo 拒绝时间点克隆并说明原因（共享实例写压会崩）；不涉及数据库的服务不适用', () => {
    const mongo = perBranchCloneSpec(state, branch(), effective('search'));
    expect('refused' in mongo && mongo.refused).toMatch(/mongo/i);
    expect('refused' in mongo && mongo.refused).toMatch(/专用实例|写压|写入/);
    const web = perBranchCloneSpec(state, branch(), effective('web'));
    expect('refused' in web && web.refused).toMatch(/不涉及数据库|没有数据库/);
  });

  it('dbInit 缺省（空库重跑迁移）不克隆、不碰 docker', async () => {
    let touched = 0;
    const out = await ensurePerBranchDbInitialized(state, branch(), effective('jobs'), { exec: async () => { touched += 1; return { code: 0, stdout: '', stderr: '' }; }, listDatabases: async () => { touched += 1; return []; }, now: () => NOW });
    expect(out.kind).toBe('not-applicable');
    expect(touched).toBe(0);
  });

  it('目标库已经在实例上：跳过克隆，说明「已存在」', async () => {
    const log: string[] = [];
    const out = await ensurePerBranchDbInitialized(state, branch(), effective('api'), { exec: fakeExec({ shop: { users: 3 }, shop_feat_x: { users: 3 } }, log), listDatabases: async () => ['shop', 'shop_feat_x'], now: () => NOW });
    expect(out).toMatchObject({ kind: 'exists', dbName: 'shop_feat_x' });
    expect(log).toEqual([]);
  });

  it('目标库不存在：克隆 → 逐表校验 → 台账记下克隆时间点与校验结果', async () => {
    const log: string[] = [];
    const lines: string[] = [];
    const world = { shop: { users: 3, orders: 10 } } as Record<string, Record<string, number>>;
    const out = await ensurePerBranchDbInitialized(state, branch(), effective('api'), { exec: fakeExec(world, log), listDatabases: async () => ['shop'], now: () => NOW, onOutput: (l) => lines.push(l) });
    expect(out.kind).toBe('cloned');
    expect(log).toEqual(['clone:mysql']);
    expect(out.kind === 'cloned' && out.verification.ok).toBe(true);
    expect(out.kind === 'cloned' && out.verification.tables.length).toBe(2);
    const entry = state.getDbLedger('p').find((e) => e.dbName === 'shop_feat_x');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('per-branch');
    expect(entry!.branchId).toBe('p-feat-x');
    expect(entry!.clone).toMatchObject({ sourceDb: 'shop', clonedAt: NOW.toISOString(), verification: { ok: true, mismatched: [] } });
    expect(entry!.lastObjects).toEqual({ count: 2, measuredAt: NOW.toISOString() });
    expect(lines.join('\n')).toMatch(/shop → shop_feat_x/);
    expect(lines.join('\n')).toMatch(/2 张表行数一致/);
  });

  it('克隆后源库又被写了一行：校验结果标出那张表，台账如实记不一致', async () => {
    const world = { shop: { users: 3, orders: 10 } } as Record<string, Record<string, number>>;
    let cloned = false;
    const base = fakeExec(world);
    const exec: DbCloneExec = async (argv, stdin, t, m) => {
      const r = await base(argv, stdin, t, m);
      if (argv[0] === 'run' && !cloned) { cloned = true; world.shop.orders = 11; }
      return r;
    };
    const out = await ensurePerBranchDbInitialized(state, branch(), effective('api'), { exec, listDatabases: async () => ['shop'], now: () => NOW });
    expect(out.kind).toBe('cloned');
    expect(out.kind === 'cloned' && out.verification).toMatchObject({ ok: false, mismatched: ['orders'] });
    const entry = state.getDbLedger('p').find((e) => e.dbName === 'shop_feat_x')!;
    expect(entry.clone?.verification.ok).toBe(false);
    expect(entry.clone?.verification.tables).toContainEqual({ table: 'orders', source: 11, target: 10 });
  });

  it('同分支两个服务共用一个独立库并行部署：只克隆一次，后到的等完再判「已存在」（真实 mysql 分支复验的并发缺口）', async () => {
    state.addBuildProfile({ id: 'web2', projectId: 'p', name: 'Web2', dockerImage: 'nginx', workDir: '.', containerPort: 81, dbScope: 'per-branch', dbInit: 'clone', env: { CDS_MYSQL_DATABASE: 'shop' } } as BuildProfile);
    state.save();
    const log: string[] = [];
    const listed = ['shop'];
    const world = { shop: { users: 3 } } as Record<string, Record<string, number>>;
    const base = fakeExec(world, log);
    const slowExec: DbCloneExec = async (argv, stdin, t, m) => {
      const r = await base(argv, stdin, t, m);
      if (argv[0] === 'run') { await new Promise((res) => setTimeout(res, 30)); listed.push('shop_feat_x'); }
      return r;
    };
    const deps = { exec: slowExec, listDatabases: async () => [...listed], now: () => NOW };
    const [a, b] = await Promise.all([
      ensurePerBranchDbInitialized(state, branch(), effective('api'), deps),
      ensurePerBranchDbInitialized(state, branch(), effective('web2'), deps),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['cloned', 'exists']);
    expect(log.filter((l) => l.startsWith('clone:'))).toHaveLength(1);
  });

  it('克隆脚本失败：抛错（部署据此中止），不写台账', async () => {
    const exec: DbCloneExec = async (argv) => argv[0] === 'run' ? { code: 1, stdout: '', stderr: 'disk full' } : { code: 0, stdout: '', stderr: '' };
    await expect(ensurePerBranchDbInitialized(state, branch(), effective('api'), { exec, listDatabases: async () => ['shop'], now: () => NOW })).rejects.toThrow(/disk full/);
    expect(state.getDbLedger('p').find((e) => e.dbName === 'shop_feat_x')).toBeUndefined();
  });
});

describe('接线守卫：一条克隆管线，两个调用方', () => {
  const read = (f: string): string => fs.readFileSync(path.join(CDS_ROOT, f), 'utf8');
  it('复制集隔离库的关系型克隆改走同一条三元组管线，不再自己拼 dump 脚本', () => {
    const s = read('src/services/replica-db-clone.ts');
    expect(s).toContain('cloneRelationalDbInPlace(');
    expect(s).not.toContain('mysqldump ${conn}');
  });
  it('分支部署在启动容器前先跑分支独立库初始化', () => {
    const s = read('src/routes/branches.ts');
    expect(s).toContain('ensurePerBranchDbInitialized(');
  });
  it('删分支丢弃派生库也按项目环境变量解析实例密码，丢弃失败时条目转孤儿而不是留着「活跃」', () => {
    const s = read('src/routes/branches.ts');
    expect(s).toContain('realDbLedgerOps.dropDb(derived.engine, resolveInfraForDb(stateService, rawInfra), derived)');
    expect(s).toContain("status: 'orphaned', orphanedAt: new Date().toISOString()");
  });
  it('分支覆盖合并把 dbInit 一起带上（与 dbScope 同款）', () => {
    const s = read('src/services/container.ts');
    expect(s).toMatch(/override\.dbInit !== undefined \? \{ dbInit: override\.dbInit \}/);
  });
});
