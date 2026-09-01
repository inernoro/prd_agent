import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { explainMissingTable, foreignSchemaRefusal, isMissingTableOrSchemaError, isTablePermissionError } from '../../src/services/db-error-explain.js';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 现场（2026-09-01，用户截图）：
 *   GET .../data/preview?table=distributed_lock&schema=webhook_platform&limit=50
 *   → ERROR 1146: Table 'imp_b_9bd351d94c8f35ab.distributed_lock' doesn't exist
 *
 * 请求明明带了 schema=webhook_platform，MySQL 这一侧却把它丢了，拼出来的是
 * `SELECT * FROM \`distributed_lock\``，走连接的默认库 imp_b_...。报文里的库名与
 * 用户在面板上看到的库名对不上，只能干瞪眼。
 */
const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readBranchesRoute(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
}

describe('MySQL 表标识符要带库名', () => {
  it('sqlTableIdent 在有 schema 时限定库名，没有时保持原样', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('function sqlTableIdent(');
    expect(at, '找不到 sqlTableIdent').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 700);
    expect(fn).toContain('ref.schema ? `${sqlIdent(ref.schema)}.${sqlIdent(ref.table)}` : sqlIdent(ref.table)');
  });

  it('查字段用请求带的库，而不是永远 DATABASE()', () => {
    const source = readBranchesRoute();
    expect(source).toContain("TABLE_SCHEMA = ${ref.schema ? sqlString(ref.schema) : 'DATABASE()'}");
    expect(source, '不许再留一处写死 DATABASE() 的字段查询').not.toContain('WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME');
  });

  it('红用例：把 MySQL 的库名限定去掉，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const at = source.indexOf('function sqlTableIdent(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 700)).toContain('sqlIdent(ref.schema)');
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(
        real,
        'return ref.schema ? `${sqlIdent(ref.schema)}.${sqlIdent(ref.table)}` : sqlIdent(ref.table);',
        'return sqlIdent(ref.table);',
      ),
    );
  });

  /**
   * MySQL 的 schema 就是 database：放任请求方自带库名，等于让工作台读到同实例里别的
   * 分支/项目的库（回落到服务自带账号时尤其明显）。必须在**执行之前**挡住（Codex P1）。
   */
  it('MySQL 请求本分支库以外的库，执行前就拒绝', () => {
    const source = readBranchesRoute();
    const guards = source.split("if (ctx.runtime === 'mysql' && ref.schema && ref.schema !== database) {").length - 1;
    expect(guards, '预览与字段两个入口都要有这道闸').toBe(2);
    expect(source).toContain('foreignSchemaRefusal({ database, requestedSchema: ref.schema, table: ref.table })');
    // 闸必须排在真正发查询之前
    const at = source.indexOf("router.get('/branches/:id/resources/:resourceId/data/preview'");
    const slice = source.slice(at, at + 2200);
    expect(slice.indexOf("ref.schema !== database")).toBeLessThan(slice.indexOf('runSqlDataQuery('));
  });

  it('拒绝文案说清「只能读自己的库」并给下一步', () => {
    const message = foreignSchemaRefusal({ database: 'imp_b_1', requestedSchema: 'mysql', table: 'user' });
    expect(message).toContain('只能读它自己的库 imp_b_1');
    expect(message).toContain('mysql.user');
    expect(message).toContain('刷新');
  });

  it('红用例：拆掉跨库闸，守卫必须变红', () => {
    const real = readBranchesRoute();
    const guard = (source: string) => {
      const n = source.split("if (ctx.runtime === 'mysql' && ref.schema && ref.schema !== database) {").length - 1;
      expect(n).toBe(2);
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, "if (ctx.runtime === 'mysql' && ref.schema && ref.schema !== database) {", 'if (false) {'),
    );
  });

  it('预览与字段两个入口都把「找不到表」翻成人话', () => {
    const source = readBranchesRoute();
    expect(source.split('explainMissingTable({').length - 1, '两个入口都要接上').toBe(2);
  });
});

describe('找不到表时的解释', () => {
  const RAW_1146 = "mysql: [Warning] Using a password on the command line interface can be insecure.\n"
    + "ERROR 1146 (42S02) at line 1: Table 'imp_b_9bd351d94c8f35ab.distributed_lock' doesn't exist";

  it('认得出「表/库不存在」这类错误', () => {
    expect(isMissingTableOrSchemaError(RAW_1146)).toBe(true);
    expect(isMissingTableOrSchemaError('ERROR 1049 (42000): Unknown database \'x\'')).toBe(true);
    expect(isMissingTableOrSchemaError('ERROR 1045 (28000): Access denied')).toBe(false);
  });

  it('请求的库与当前连接的库不一致时，把差异讲清楚并给下一步', () => {
    const message = explainMissingTable({
      database: 'imp_b_9bd351d94c8f35ab',
      requestedSchema: 'webhook_platform',
      table: 'distributed_lock',
      rawError: RAW_1146,
    });
    expect(message).toContain('webhook_platform.distributed_lock');
    expect(message).toContain('imp_b_9bd351d94c8f35ab');
    expect(message).toContain('刷新');
    expect(message).toContain(RAW_1146);
  });

  /**
   * 带上库名限定之后，同一台服务器上「库在、账号没权限」的真实报文变成 1142
   * （实测：SELECT command denied to user 'cds_...' for table 'distributed_lock'）。
   * 它比 1146 准确，对用户依然是天书，同样要给下一步。
   */
  it('跨库但没权限（1142）也给解释', () => {
    const raw = "ERROR 1142 (42000) at line 1: SELECT command denied to user 'cds_mdimp_codex_async_worker'@'localhost' for table 'distributed_lock'";
    expect(isTablePermissionError(raw)).toBe(true);
    const message = explainMissingTable({
      database: 'imp_b_9bd351d94c8f35ab',
      requestedSchema: 'webhook_platform',
      table: 'distributed_lock',
      rawError: raw,
    });
    expect(message).toContain('读不了 webhook_platform.distributed_lock');
    expect(message).toContain('imp_b_9bd351d94c8f35ab');
    expect(message).toContain('另一个数据库资源');
    expect(message).toContain(raw);
  });

  it('库一致 / 没带 schema / 非此类错误时不加戏', () => {
    expect(explainMissingTable({
      database: 'app', requestedSchema: 'app', table: 't', rawError: RAW_1146,
    })).toBe(RAW_1146);
    expect(explainMissingTable({
      database: 'app', table: 't', rawError: RAW_1146,
    })).toBe(RAW_1146);
    const denied = 'ERROR 1045 (28000): Access denied';
    expect(explainMissingTable({
      database: 'app', requestedSchema: 'other', table: 't', rawError: denied,
    })).toBe(denied);
  });
});
