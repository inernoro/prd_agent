import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_DB_ACCOUNT_MAX_LEN,
  branchDbAccountName,
  branchDbFingerprint,
  explainBranchDbAuthFailure,
  allBranchDbEnvKeys,
  foreignBranchDbEnvKeys,
  isCdsManagedBranchAccount,
  isDbAuthFailure,
  legacyBranchDbAccountName,
} from '../../src/services/branch-db-identity.js';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 事故复现在第一条用例里：报错报文中的账号 `cds_mdimp_claude_open_api_ch` 就是旧规则
 * 把分支 id 截到 24 字符的产物，同项目下所有 `claude/open-api-ch...` 分支都算出它。
 */
const INCIDENT_BRANCH = 'mdimp-claude-open-api-channel-cl04-byglbh';
const SIBLING_BRANCH = 'mdimp-claude-open-api-channel-cl05-qzk2rd';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readBranchesRoute(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
}

describe('分支数据库账号身份', () => {
  it('旧规则确实会让兄弟分支算出同一个账号（事故本体）', () => {
    expect(legacyBranchDbAccountName(INCIDENT_BRANCH)).toBe('cds_mdimp_claude_open_api_ch');
    expect(legacyBranchDbAccountName(SIBLING_BRANCH)).toBe(legacyBranchDbAccountName(INCIDENT_BRANCH));
  });

  it('新规则下同前缀的兄弟分支拿到不同账号', () => {
    const a = branchDbAccountName(INCIDENT_BRANCH);
    const b = branchDbAccountName(SIBLING_BRANCH);
    expect(a).not.toBe(b);
    // 可读前缀允许一样（它只给人看），唯一性必须来自指纹。
    expect(a.endsWith(branchDbFingerprint(INCIDENT_BRANCH))).toBe(true);
    expect(b.endsWith(branchDbFingerprint(SIBLING_BRANCH))).toBe(true);
  });

  it('账号名不超过 MySQL 的 32 字符上限，且只含合法字符', () => {
    for (const branchId of [
      INCIDENT_BRANCH,
      SIBLING_BRANCH,
      'main',
      'x',
      'a'.repeat(200),
      'proj-claude/feature_with.dots-and-UPPER',
    ]) {
      const account = branchDbAccountName(branchId);
      expect(account.length, `${branchId} 的账号名超长: ${account}`).toBeLessThanOrEqual(BRANCH_DB_ACCOUNT_MAX_LEN);
      expect(account).toMatch(/^cds_[a-z0-9_]*[a-z0-9]$/);
      expect(account).not.toMatch(/__/);
    }
  });

  it('派发是确定性的：同一个分支 id 永远算出同一个账号', () => {
    expect(branchDbAccountName(INCIDENT_BRANCH)).toBe(branchDbAccountName(INCIDENT_BRANCH));
  });

  it('分支 id 归一后为空时仍给得出合法账号', () => {
    const account = branchDbAccountName('---');
    expect(account).toMatch(/^cds_[0-9a-f]{8}$/);
  });

  it('CDS 派发的账号认得出，用户自填的账号不认', () => {
    expect(isCdsManagedBranchAccount(branchDbAccountName(INCIDENT_BRANCH))).toBe(true);
    expect(isCdsManagedBranchAccount('cds_mdimp_claude_open_api_ch')).toBe(true);
    expect(isCdsManagedBranchAccount('app')).toBe(false);
    expect(isCdsManagedBranchAccount('root')).toBe(false);
    expect(isCdsManagedBranchAccount('')).toBe(false);
  });
});

/**
 * 归属判定只堵住「直接读分支 env」那一条路；服务 env 写成 `${POSTGRES_USER}` 模板时，
 * 展开用的 merged env 里照样躺着别人家的分支凭据（Codex P1，2026-09-01）。
 */
describe('别人家的分支凭据要从模板变量里摘掉', () => {
  const FOREIGN_PG = {
    POSTGRES_HOST: 'postgres-a',
    POSTGRES_PORT: '5432',
    POSTGRES_DB: 'branch_a',
    POSTGRES_USER: 'cds_branch_a',
    POSTGRES_PASSWORD: 'a-pw',
    DATABASE_URL: 'postgresql://cds_branch_a:a-pw@postgres-a:5432/branch_a',
  };

  it('归属是别的服务时，这套键全部点名', () => {
    const keys = foreignBranchDbEnvKeys(FOREIGN_PG, 'postgres-b');
    expect(keys.sort()).toEqual([
      'DATABASE_URL', 'POSTGRES_DB', 'POSTGRES_HOST', 'POSTGRES_PASSWORD', 'POSTGRES_PORT', 'POSTGRES_USER',
    ]);
  });

  it('归属就是自己时，一个都不摘', () => {
    expect(foreignBranchDbEnvKeys(FOREIGN_PG, 'postgres-a')).toEqual([]);
  });

  it('判断不出归属（老数据没写 HOST）时一个都不摘，与宽松侧同口径', () => {
    const { POSTGRES_HOST: _host, DATABASE_URL: _url, ...noOwner } = FOREIGN_PG;
    expect(foreignBranchDbEnvKeys(noOwner, 'postgres-b')).toEqual([]);
  });

  it('共用键 DATABASE_URL 按 scheme 归到某条运行时线上，那条线是自己的就不摘', () => {
    // postgres 那套是别人家的（该摘），但 DATABASE_URL 是 mysql scheme 且指向本服务
    const mixed = {
      ...FOREIGN_PG,
      MYSQL_HOST: 'mysql-b',
      MYSQL_USER: 'cds_b',
      DATABASE_URL: 'mysql://cds_b:p@mysql-b:3306/app',
    };
    const keys = foreignBranchDbEnvKeys(mixed, 'mysql-b');
    expect(keys).toContain('POSTGRES_USER');
    expect(keys, 'DATABASE_URL 归 mysql 那条线，而那条线就是本服务').not.toContain('DATABASE_URL');
  });

  it('只摘分支 env 里真的有的键，不无中生有', () => {
    const sparse = { POSTGRES_HOST: 'postgres-a', POSTGRES_USER: 'cds_branch_a' };
    expect(foreignBranchDbEnvKeys(sparse, 'postgres-b').sort()).toEqual(['POSTGRES_HOST', 'POSTGRES_USER']);
  });

  /**
   * 形状 3（判据分裂后漂移）的防线：注入端加了一个新键、这边的表没跟上，
   * 「摘掉别人家的凭据」就会漏摘一条，而漏掉的那条照样能把 A 的账号展开进 B。
   * 这条守卫按源码扫注入端的 injectedEnv，逐键要求登记在册。
   */
  it('注入端写进分支 env 的键，全部登记在册（漏一个就漏摘一个）', () => {
    const source = readBranchesRoute();
    const registered = new Set(allBranchDbEnvKeys());
    const injected = new Set<string>();
    for (const block of source.match(/const injectedEnv: Record<string, string> = \{[\s\S]*?\n {4}\};/g) || []) {
      for (const key of block.match(/^\s{6}([A-Z][A-Z0-9_]+):/gm) || []) injected.add(key.trim().replace(':', ''));
    }
    for (const assign of source.match(/injectedEnv\.([A-Z][A-Z0-9_]+)\s*=/g) || []) {
      injected.add(assign.replace(/injectedEnv\.|\s*=/g, ''));
    }
    expect(injected.size, '没扫到注入端的 injectedEnv，锚点漂了').toBeGreaterThanOrEqual(6);
    expect([...injected].filter((key) => !registered.has(key))).toEqual([]);
  });

  it('多台库并存时各判各的：mysql 是自己的就留着，postgres 是别人的才摘', () => {
    const both = { ...FOREIGN_PG, MYSQL_HOST: 'mysql-b', MYSQL_USER: 'cds_b', MYSQL_PASSWORD: 'b-pw' };
    const keys = foreignBranchDbEnvKeys(both, 'mysql-b');
    expect(keys).toContain('POSTGRES_USER');
    expect(keys).not.toContain('MYSQL_USER');
  });
});

describe('认证失败的解释', () => {
  const RAW_1045 = "mysql: [Warning] Using a password on the command line interface can be insecure. "
    + "ERROR 1045 (28000): Access denied for user 'cds_mdimp_claude_open_api_ch'@'localhost' (using password: YES)";

  it('1045 认得出，普通 SQL 错误不认', () => {
    expect(isDbAuthFailure(RAW_1045)).toBe(true);
    expect(isDbAuthFailure('ERROR 1146 (42S02): Table \'app.users\' doesn\'t exist')).toBe(false);
  });

  /**
   * PostgreSQL 角色被删掉时报 `FATAL: role "cds_..." does not exist`——对用户是同一个
   * 下一步（重新派发凭据），不认它就只剩一行裸报文（Codex P2，第三轮）。
   */
  it('PostgreSQL 角色缺失算认证失败，给得出恢复路径', () => {
    const raw = 'psql: error: connection to server failed: FATAL:  role "cds_demo_1a2b3c4d" does not exist';
    expect(isDbAuthFailure(raw)).toBe(true);
    const message = explainBranchDbAuthFailure({
      runtime: 'postgres',
      branchId: INCIDENT_BRANCH,
      user: 'cds_demo_1a2b3c4d',
      rawError: raw,
    });
    expect(message).toContain('重置连接凭据');
    expect(message).toContain(raw);
  });

  /**
   * 反过来的一半（Codex P2，第五轮）：`GRANT SELECT ON demo TO missing_role` 报的是
   * 语句级的 `ERROR: role "missing_role" does not exist`——连接好好的、分支账号也好好的，
   * 只是被 GRANT 的角色不存在。把它算成认证失败，工作台会对着一条正常 SQL 说
   * 「当前分支账号被拒」并指路重置凭据，而凭据根本没坏。
   */
  it('语句里引用到别的缺失角色，不算认证失败', () => {
    const raw = 'ERROR:  role "missing_role" does not exist';
    expect(isDbAuthFailure(raw, 'cds_demo_1a2b3c4d')).toBe(false);
    expect(explainBranchDbAuthFailure({
      runtime: 'postgres',
      branchId: INCIDENT_BRANCH,
      user: 'cds_demo_1a2b3c4d',
      rawError: raw,
    })).toBe(raw);
  });

  it('缺失的角色就是登录账号时，即使没有 FATAL 也算认证失败', () => {
    const raw = 'ERROR:  role "cds_demo_1a2b3c4d" does not exist';
    expect(isDbAuthFailure(raw, 'cds_demo_1a2b3c4d')).toBe(true);
    // 不知道登录账号是谁时，只认连接级的 FATAL，不瞎猜
    expect(isDbAuthFailure(raw)).toBe(false);
  });

  it('CDS 派发账号的 1045 给出原因与下一步，并保留原始错误', () => {
    const message = explainBranchDbAuthFailure({
      runtime: 'mysql',
      branchId: INCIDENT_BRANCH,
      user: 'cds_mdimp_claude_open_api_ch',
      rawError: RAW_1045,
    });
    expect(message).toContain('重置连接凭据');
    expect(message).toContain('重新部署');
    expect(message).toContain('兄弟分支');
    expect(message).toContain(RAW_1045);
  });

  it('账号名不是旧截断名时不瞎认「兄弟分支覆盖」', () => {
    const account = branchDbAccountName(INCIDENT_BRANCH);
    const message = explainBranchDbAuthFailure({
      runtime: 'mysql',
      branchId: INCIDENT_BRANCH,
      user: account,
      rawError: RAW_1045.replace('cds_mdimp_claude_open_api_ch', account),
    });
    expect(message).toContain('重置连接凭据');
    expect(message).not.toContain('兄弟分支会算出同一个账号');
  });

  /**
   * 真机复现（2026-09-01）：出事的 cloudbridge-db 用 MYSQL_RANDOM_ROOT_PASSWORD 起的，
   * root 口令只在容器日志里出现过一次，CDS 拿不到。对这种库指路「点重置连接凭据」
   * 是把人送进死胡同——他点了会再吃一条 root 的 1045。
   */
  it('拿不到管理员口令时，不许指路「重置连接凭据」', () => {
    const message = explainBranchDbAuthFailure({
      runtime: 'mysql',
      branchId: INCIDENT_BRANCH,
      user: 'cds_mdimp_claude_open_api_ch',
      rawError: RAW_1045,
      adminAvailable: false,
    });
    expect(message).toContain('这条路走不通');
    expect(message).toContain('直连');
    expect(message).toContain('root 口令');
    expect(message).not.toContain('下一步：在该资源的面板点「重置连接凭据」');
  });

  it('拿得到管理员口令 / 未知时，维持「重置连接凭据」指引', () => {
    for (const adminAvailable of [true, undefined]) {
      const message = explainBranchDbAuthFailure({
        runtime: 'mysql',
        branchId: INCIDENT_BRANCH,
        user: 'cds_mdimp_claude_open_api_ch',
        rawError: RAW_1045,
        adminAvailable,
      });
      expect(message).toContain('下一步：在该资源的面板点「重置连接凭据」');
      expect(message).not.toContain('这条路走不通');
    }
  });

  it('用户自填账号 / 非认证错误原样返回，不硬套指引', () => {
    expect(explainBranchDbAuthFailure({
      runtime: 'mysql',
      branchId: INCIDENT_BRANCH,
      user: 'app',
      rawError: RAW_1045.replace('cds_mdimp_claude_open_api_ch', 'app'),
    })).not.toContain('重置连接凭据');
    const syntaxError = "ERROR 1064 (42000): You have an error in your SQL syntax";
    expect(explainBranchDbAuthFailure({
      runtime: 'mysql',
      branchId: INCIDENT_BRANCH,
      user: 'cds_mdimp_claude_open_api_ch',
      rawError: syntaxError,
    })).toBe(syntaxError);
  });
});

/**
 * 接线守卫（predicate-and-wiring-discipline 形状 2）：上面的纯函数全绿，
 * 但只要 branches.ts 不用它们，事故照旧——删掉接线不会有任何测试变红。
 */
describe('branches.ts 真的用上了这套身份与解释', () => {
  const guards: Array<[string, (source: string) => void, [string, string]]> = [
    [
      '账号派发走 branchDbAccountName，不再自己截断拼名字',
      (source) => {
        expect(source).toContain('return branchDbAccountName(branch.id);');
        expect(source).not.toMatch(/`cds_\$\{StateService\.slugify\(branch\.id\)/);
      },
      ['return branchDbAccountName(branch.id);', "return `cds_${StateService.slugify(branch.id).replace(/-/g, '_').slice(0, 24)}`.slice(0, 32);"],
    ],
    [
      'MySQL 查询失败经过解释',
      (source) => {
        const at = source.indexOf('async function runMysqlDataQuery(');
        expect(at, '找不到 runMysqlDataQuery').toBeGreaterThan(-1);
        expect(source.slice(at, at + 1600)).toContain('explainBranchDbAuthFailure({');
      },
      ["        runtime: 'mysql',\n        branchId: branch.id,", "        // removed\n        branchId: branch.id,"],
    ],
  ];

  for (const [title, guard] of guards) {
    it(title, () => { guard(readBranchesRoute()); });
  }

  it('红用例：把派发改回旧的截断写法，守卫必须变红', () => {
    const real = readBranchesRoute();
    const [, guard, [from, to]] = guards[0];
    expectGuardRedOnMutation(guard, real, mutate(real, from, to));
  });

  it('红用例：拆掉 MySQL 失败解释的调用，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('async function runMysqlDataQuery(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 1600)).toContain('explainBranchDbAuthFailure({');
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(
        real,
        `      throw new Error(explainBranchDbAuthFailure({
        runtime: 'mysql',`,
        `      throw new Error(String({
        runtime: 'mysql',`,
      ),
    );
  });

  /**
   * 管理员能力判据必须**独立于** mysqlRootPassword()：后者会一路回落到 MYSQL_PASSWORD
   * （应用账号的口令），拿它判「有没有 root」永远为真，随机 root 口令的容器就会被判成
   * 「能重置」，指引再次把用户送进死胡同。
   */
  it('管理员能力判据只认显式 root 口令 / 显式空口令，不看 MYSQL_PASSWORD', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('function resolveMysqlAdmin(');
    expect(at, '找不到 resolveMysqlAdmin').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 900);
    expect(fn).toContain('MYSQL_ROOT_PASSWORD');
    expect(fn).toContain('MYSQL_ALLOW_EMPTY_PASSWORD');
    expect(fn, '不得回落到应用账号口令').not.toContain('MYSQL_PASSWORD ||');
  });

  /**
   * 判「能不能用 root」与取「用什么口令连 root」必须是同一处：分成两处时会出现
   * 「判定说能（ALLOW_EMPTY），实际却拿应用账号口令去连 root」的错位（Codex P1，第二轮）。
   */
  it('管理员能力与管理员口令由同一个函数解出', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('function resolveMysqlAdmin(');
    expect(at, '找不到 resolveMysqlAdmin').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 900);
    expect(fn).toContain('return { available: true, password: rootPassword };');
    expect(fn).toContain('return { available: true, password: \'\' };');
    expect(fn).toContain('return { available: false, password: \'\' };');
    // 重置必须用它解出的口令，不能再走会回落到应用账号口令的旧取法
    const resetAt = source.indexOf('async function resetMysqlBranchCredentials(');
    const reset = source.slice(resetAt, resetAt + 1800);
    expect(reset).toContain('const rootPassword = admin.password;');
    expect(reset, '重置不该再用会回落到 MYSQL_PASSWORD 的取法').not.toContain('mysqlRootPassword(service)');
  });

  it('重置凭据在拿不到管理员口令时当场拒绝，而不是硬跑注定 1045 的命令', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('async function resetMysqlBranchCredentials(');
    expect(at, '找不到 resetMysqlBranchCredentials').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 1800);
    expect(fn).toContain('if (!admin.available) {');
    // 拒绝必须给得出去处（对齐仓库既有的「拒绝要有下一步」纪律）
    expect(fn).toContain('MYSQL_ROOT_PASSWORD');
    const guardAt = fn.indexOf('if (!admin.available) {');
    const execAt = fn.indexOf('shell.exec(');
    expect(guardAt, '拒绝必须排在执行之前').toBeLessThan(execAt);
  });

  it('红用例：拆掉重置的管理员前置检查，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('async function resetMysqlBranchCredentials(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 1800)).toContain('if (!admin.available) {');
    };
    expectGuardRedOnMutation(guard, real, mutate(real, 'if (!admin.available) {', 'if (false) {'));
  });

  it('删库时只删得掉「证明是本分支的」账号', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('async function deleteBranchDatabaseResource(');
    expect(at, '找不到 deleteBranchDatabaseResource').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 4000);
    expect(fn).toContain('const dropUser = user && user === branchDatabaseUser(branch);');
    expect(fn).toContain('const dropRole = user && user === branchDatabaseUser(branch);');
    expect(fn).not.toContain("user ? `DROP USER IF EXISTS");
    expect(fn).not.toContain('user ? `DROP ROLE IF EXISTS');
  });

  it('红用例：把 DROP USER 改回无条件删，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('async function deleteBranchDatabaseResource(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 4000)).not.toContain("user ? `DROP USER IF EXISTS");
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, "dropUser ? `DROP USER IF EXISTS", "user ? `DROP USER IF EXISTS"),
    );
  });
});
