import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { branchDbCredentialOwner, branchDbCredentialsBelongTo } from '../../src/services/branch-db-identity.js';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 现场（2026-09-01）：分支 mdimp-claude-open-api-channel-cl04-byglbh 下挂着两台 MySQL——
 * `cloudbridge-db` 与 `mysql-mdimp`。分支作用域的 env 只有一份 MYSQL_USER / MYSQL_PASSWORD /
 * MYSQL_DATABASE，派发给谁就是谁的；工作台却拿这一份去连**另一台**，账号在那台库里不存在，
 * 于是「CDS 自己建的库，CDS 自己连不上」。同一处漏判在删库路径上更狠：删 B 资源掉的是 A 的库。
 */
const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readBranchesRoute(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
}

const BRANCH_ENV_FOR_MYSQL_MDIMP = {
  DATABASE_URL: 'mysql://cds_x:pw@mysql-mdimp:3306/imp_cb_939d75849081e7a8',
  MYSQL_HOST: 'mysql-mdimp',
  MYSQL_PORT: '3306',
  MYSQL_DATABASE: 'imp_cb_939d75849081e7a8',
  MYSQL_USER: 'cds_x',
  MYSQL_PASSWORD: 'pw',
};

describe('分支凭据的归属判定', () => {
  it('HOST 就是派发目标：认得出这套凭据是给哪台服务的', () => {
    expect(branchDbCredentialOwner(BRANCH_ENV_FOR_MYSQL_MDIMP, 'mysql')).toBe('mysql-mdimp');
    expect(branchDbCredentialsBelongTo(BRANCH_ENV_FOR_MYSQL_MDIMP, 'mysql', 'mysql-mdimp')).toBe(true);
    expect(branchDbCredentialsBelongTo(BRANCH_ENV_FOR_MYSQL_MDIMP, 'mysql', 'cloudbridge-db')).toBe(false);
  });

  it('没有 HOST 时从连接串里取 host', () => {
    const env = { DATABASE_URL: 'mysql://u:p@cloudbridge-db:3306/app' };
    expect(branchDbCredentialOwner(env, 'mysql')).toBe('cloudbridge-db');
    expect(branchDbCredentialsBelongTo(env, 'mysql', 'cloudbridge-db')).toBe(true);
    expect(branchDbCredentialsBelongTo(env, 'mysql', 'mysql-mdimp')).toBe(false);
  });

  it('判断不出归属时维持既有行为（老数据不因为多一条判据而连不上）', () => {
    expect(branchDbCredentialOwner({}, 'mysql')).toBe('');
    expect(branchDbCredentialsBelongTo({}, 'mysql', 'any-service')).toBe(true);
    expect(branchDbCredentialsBelongTo({ MYSQL_USER: 'u', MYSQL_PASSWORD: 'p' }, 'mysql', 'any-service')).toBe(true);
    // 解析不了的连接串同样算「判断不出」，不是「不属于」
    expect(branchDbCredentialsBelongTo({ DATABASE_URL: 'not a url' }, 'mysql', 'any-service')).toBe(true);
  });

  /**
   * DATABASE_URL 是共用键：分支后来注入 PostgreSQL 凭据时它指向那台库，
   * 拿它当 MySQL 的归属证据会把仍然有效的 MYSQL_* 判成别人的（Codex P1，第二轮）。
   */
  it('共用的 DATABASE_URL 只在 scheme 对得上时才认', () => {
    const pgUrlOnly = { MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', MYSQL_DATABASE: 'app', DATABASE_URL: 'postgresql://u:p@pg-main:5432/app' };
    expect(branchDbCredentialOwner(pgUrlOnly, 'mysql'), 'postgres 连接串不该当作 mysql 的归属证据').toBe('');
    expect(branchDbCredentialsBelongTo(pgUrlOnly, 'mysql', 'any-mysql')).toBe(true);
    expect(branchDbCredentialOwner(pgUrlOnly, 'postgres')).toBe('pg-main');
    expect(branchDbCredentialOwner({ DATABASE_URL: 'mongodb://m-main:27017/app' }, 'mysql')).toBe('');
    expect(branchDbCredentialOwner({ DATABASE_URL: 'mongodb://m-main:27017/app' }, 'mongodb')).toBe('m-main');
    expect(branchDbCredentialOwner({ DATABASE_URL: 'mysql://my-main:3306/app' }, 'mysql')).toBe('my-main');
  });

  it('不认识的运行时直接判断不出，不抛', () => {
    // /connection-string 对 RabbitMQ / MinIO 会带着 unknown 进来，抛错会把只读端点打成 500
    expect(() => branchDbCredentialOwner({ MYSQL_HOST: 'x' }, 'unknown' as never)).not.toThrow();
    expect(branchDbCredentialOwner({ MYSQL_HOST: 'x' }, 'unknown' as never)).toBe('');
    expect(branchDbCredentialsBelongTo({ MYSQL_HOST: 'x' }, 'unknown' as never, 'svc')).toBe(true);
  });

  it('三种运行时各看自己的 HOST，不串台', () => {
    const env = { MYSQL_HOST: 'db-a', POSTGRES_HOST: 'db-b', MONGODB_HOST: 'db-c' };
    expect(branchDbCredentialOwner(env, 'mysql')).toBe('db-a');
    expect(branchDbCredentialOwner(env, 'postgres')).toBe('db-b');
    expect(branchDbCredentialOwner(env, 'mongodb')).toBe('db-c');
  });
});

describe('branches.ts 的每个分支 env 读取点都判了归属', () => {
  const OWNED_CALLERS = [
    'mysqlClientCredentials',
    'mysqlDatabaseForBranch',
    'postgresClientCredentials',
    'postgresDatabaseForBranch',
    'mongoDatabaseForBranch',
    'mongoCredentials',
    'getExistingMysqlConnectionEnv',
    'getExistingPostgresConnectionEnv',
    'getExistingMongoConnectionEnv',
  ];

  for (const fnName of OWNED_CALLERS) {
    it(`${fnName} 取的是判过归属的分支 env`, () => {
      const source = readBranchesRoute();
      const at = source.indexOf(`function ${fnName}(`);
      expect(at, `找不到 ${fnName}`).toBeGreaterThan(-1);
      const head = source.slice(at, at + 420);
      expect(head, `${fnName} 仍在读未判归属的分支 env`).not.toContain('stateService.getCustomEnvScope(branch.id)');
      expect(head).toContain('ownedBranchEnv(branch,');
    });
  }

  it('删库前先判归属：不是本服务的分支 env 一律拒绝', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('function branchOwnedDatabaseForDelete(');
    expect(at).toBeGreaterThan(-1);
    const fn = source.slice(at, at + 3200);
    expect(fn).toContain('branchDbCredentialOwner(branchEnv,');
    expect(fn).toContain('if (owner !== service.id) {');
    expect(fn).toContain('拒绝按它删库');
  });

  /**
   * 破坏性路径失败关闭：读路径可以在「判断不出归属」时沿用老行为，删库不行——
   * 拿一份没有归属标记的库名去删，掉的可能是另一台同类型库的同名库（Codex P1）。
   */
  it('归属判断不出来时，删库拒绝执行而不是沿用老行为', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('function branchOwnedDatabaseForDelete(');
    const fn = source.slice(at, at + 3200);
    expect(fn).toContain('if (!owner) {');
    expect(fn).toContain('没有归属标记');
    expect(fn).toContain('拒绝执行');
    // 「未知归属」必须在「归属不符」之前先拦
    expect(fn.indexOf('if (!owner) {')).toBeLessThan(fn.indexOf('if (owner !== service.id) {'));
  });

  it('红用例：让未知归属重新放行，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('function branchOwnedDatabaseForDelete(');
      expect(source.slice(at, at + 3200)).toContain('if (!owner) {');
    };
    expectGuardRedOnMutation(guard, real, mutate(real, 'if (!owner) {', 'if (false) {'));
  });

  it('红用例：拆掉删库的归属判断，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('function branchOwnedDatabaseForDelete(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 3200)).toContain('if (owner !== service.id) {');
    };
    expectGuardRedOnMutation(guard, real, mutate(real, 'if (owner !== service.id) {', 'if (false) {'));
  });

  it('红用例：把工作台凭据改回不判归属，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('function mysqlClientCredentials(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 420)).toContain("ownedBranchEnv(branch, 'mysql', service)");
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(
        real,
        `function mysqlClientCredentials(service: InfraService, branch: BranchEntry): { user: string; password: string; database: string; secrets: string[] } {
    const branchEnv = ownedBranchEnv(branch, 'mysql', service);`,
        `function mysqlClientCredentials(service: InfraService, branch: BranchEntry): { user: string; password: string; database: string; secrets: string[] } {
    const branchEnv = stateService.getCustomEnvScope(branch.id);`,
      ),
    );
  });

  it('连接串构造只对三种数据库运行时判归属，其余走原始 env', () => {
    const source = readBranchesRoute();
    expect(source).toContain('function isBranchDbRuntime(runtime: string): runtime is BranchDbRuntime {');
    // 两个连接串构造用它分流；删库路径不需要，它在算出库名那一步就把 redis 抛掉了，
    // 走到归属判断时运行时必然是三种之一。
    const guards = source.split('isBranchDbRuntime(runtime)').length - 1;
    expect(guards, '两个连接串构造都要用这个判据').toBe(2);
    expect(source, '不许再用 runtime !== redis 反推它是数据库运行时')
      .not.toContain("runtime === 'redis' ? stateService.getCustomEnvScope(branch.id) : ownedBranchEnv");
  });

  it('资源清单里的连接串也判归属（否则面板显示的是另一台库的账号）', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/services/resources.ts'), 'utf8');
    expect(source).toContain('branchDbCredentialsBelongTo(rawBranchEnv, runtimeKey, service.id)');
  });
});
