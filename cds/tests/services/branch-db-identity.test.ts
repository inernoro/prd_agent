import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_DB_ACCOUNT_MAX_LEN,
  branchDbAccountName,
  branchDbFingerprint,
  explainBranchDbAuthFailure,
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

describe('认证失败的解释', () => {
  const RAW_1045 = "mysql: [Warning] Using a password on the command line interface can be insecure. "
    + "ERROR 1045 (28000): Access denied for user 'cds_mdimp_claude_open_api_ch'@'localhost' (using password: YES)";

  it('1045 认得出，普通 SQL 错误不认', () => {
    expect(isDbAuthFailure(RAW_1045)).toBe(true);
    expect(isDbAuthFailure('ERROR 1146 (42S02): Table \'app.users\' doesn\'t exist')).toBe(false);
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
    const at = source.indexOf('function mysqlAdminAvailable(');
    expect(at, '找不到 mysqlAdminAvailable').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 700);
    expect(fn).toContain('MYSQL_ROOT_PASSWORD');
    expect(fn).toContain('MYSQL_ALLOW_EMPTY_PASSWORD');
    expect(fn, '不得回落到应用账号口令').not.toContain('MYSQL_PASSWORD ||');
    expect(fn).not.toContain('mysqlRootPassword(');
  });

  it('重置凭据在拿不到管理员口令时当场拒绝，而不是硬跑注定 1045 的命令', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('async function resetMysqlBranchCredentials(');
    expect(at, '找不到 resetMysqlBranchCredentials').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 1600);
    expect(fn).toContain('if (!mysqlAdminAvailable(service, branch)) {');
    // 拒绝必须给得出去处（对齐仓库既有的「拒绝要有下一步」纪律）
    expect(fn).toContain('MYSQL_ROOT_PASSWORD');
    const guardAt = fn.indexOf('if (!mysqlAdminAvailable(service, branch)) {');
    const execAt = fn.indexOf('shell.exec(');
    expect(guardAt, '拒绝必须排在执行之前').toBeLessThan(execAt);
  });

  it('红用例：拆掉重置的管理员前置检查，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('async function resetMysqlBranchCredentials(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 1600)).toContain('if (!mysqlAdminAvailable(service, branch)) {');
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'if (!mysqlAdminAvailable(service, branch)) {', 'if (false) {'),
    );
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
