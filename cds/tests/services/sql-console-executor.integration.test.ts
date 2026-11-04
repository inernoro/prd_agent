import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSqlConsole, type SqlConsoleOptions } from '../../src/services/sql-console-executor.js';
import { SqlConsoleExecutionError } from '../../src/services/sql-console-results.js';

// Explicit opt-in only: never discover production credentials or start external services.
const connectionFile = process.env.CDS_SQL_TEST_CONNECTIONS_FILE;
describe.skipIf(!connectionFile)('真实 SQL 协议、权限与事务回归（专用验收库）', () => {
  const options = {} as Record<'mysql' | 'postgres', Omit<SqlConsoleOptions, 'sql' | 'readOnly'>>;
  const query = (engine: 'mysql' | 'postgres', sql: string, readOnly = true) => executeSqlConsole({ ...options[engine], sql, readOnly });
  beforeAll(async () => {
    const connections = JSON.parse(readFileSync(connectionFile!, 'utf8'));
    for (const engine of ['mysql', 'postgres'] as const) {
      const url = new URL(connections[engine]);
      const database = decodeURIComponent(url.pathname.slice(1));
      if (!/^cds_qa_[a-zA-Z0-9_]+$/.test(database)) throw new Error('集成测试只能连接专用 cds_qa_ 验收库');
      options[engine] = { runtime: engine, port: Number(process.env[engine === 'mysql' ? 'CDS_SQL_TEST_MYSQL_PORT' : 'CDS_SQL_TEST_POSTGRES_PORT']), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database, timeoutMs: 10_000 };
      await query(engine, 'CREATE TABLE IF NOT EXISTS qa_console_protocol_test (id INT PRIMARY KEY, qty INT); DELETE FROM qa_console_protocol_test; INSERT INTO qa_console_protocol_test VALUES (1,10)', false);
      const functionSql = engine === 'mysql'
        ? 'CREATE PROCEDURE qa_console_write_test() BEGIN UPDATE qa_console_protocol_test SET qty=qty+1 WHERE id=1; END'
        : 'CREATE FUNCTION qa_console_write_test() RETURNS INT LANGUAGE plpgsql AS $$ BEGIN UPDATE qa_console_protocol_test SET qty=qty+1 WHERE id=1; RETURN 1; END $$';
      await query(engine, `DROP ${engine === 'mysql' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS qa_console_write_test`, false);
      await query(engine, functionSql, false);
    }
  });
  afterAll(async () => {
    for (const engine of ['mysql', 'postgres'] as const) {
      if (options[engine]) await query(engine, `DROP ${engine === 'mysql' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS qa_console_write_test; DROP TABLE IF EXISTS qa_console_protocol_test`, false);
    }
  });

  for (const engine of ['mysql', 'postgres'] as const) {
    const sample = engine === 'mysql'
      ? "SELECT CONCAT('前',CHAR(9),'后',CHAR(10),'下一行',CHAR(13),CHAR(10),'末尾') AS multiline, NULL AS missing, '' AS empty_value, '<>&&nbsp;' AS markup, 'NULL' AS literal_null, CAST(1000000000000000001 AS SIGNED) AS big_value, CAST(1.234567890123456789 AS DECIMAL(30,18)) AS decimal_value"
      : "SELECT '前'||chr(9)||'后'||chr(10)||'下一行'||chr(13)||chr(10)||'末尾' AS multiline, NULL::text AS missing, ''::text AS empty_value, '<>&&nbsp;' AS markup, 'NULL' AS literal_null, 1000000000000000001::bigint AS big_value, 1.234567890123456789::numeric AS decimal_value";

    it(`${engine} 单条与多条查询完整保留值及空结果列名`, async () => {
      const expected = [['前\t后\n下一行\r\n末尾', null, '', '<>&&nbsp;', 'NULL', '1000000000000000001', '1.234567890123456789']];
      const single = await query(engine, sample);
      expect(single.rows).toEqual(expected);
      const multi = await query(engine, `${sample}; SELECT id AS empty_id, qty AS empty_qty FROM qa_console_protocol_test WHERE 1=0; SELECT 3 AS final_result`);
      expect(multi.resultSets).toHaveLength(3);
      expect(multi.resultSets![0].rows).toEqual(expected);
      expect(multi.resultSets![1]).toEqual({ columns: ['empty_id', 'empty_qty'], rows: [], rowCount: 0 });
      expect(multi.resultSets![2].rows).toEqual([['3']]);
    });

    it(`${engine} 只读连接连存储例程内写入也拒绝，并且不改数据`, async () => {
      await expect(query(engine, engine === 'mysql' ? 'CALL qa_console_write_test()' : 'SELECT qa_console_write_test()')).rejects.toThrow(/read.only/i);
      expect((await query(engine, 'SELECT qty FROM qa_console_protocol_test WHERE id=1')).rows).toEqual([['10']]);
    });

    it(`${engine} JSON 的中文与大整数文本不乱码或失精度`, async () => {
      const sql = engine === 'mysql' ? "SELECT JSON_OBJECT('name','中文','n',1000000000000000001) AS payload" : "SELECT json_build_object('name','中文','n',1000000000000000001::bigint) AS payload";
      for (const input of [sql, `${sql}; SELECT 2`]) {
        const result = await query(engine, input);
        expect(result.rows[0][0]).toContain('中文');
        expect(result.rows[0][0]).toMatch(/1000000000000000001/);
        expect(JSON.parse(result.rows[0][0]!).name).toBe('中文');
      }
    });

    it(`${engine} 执行超时会关闭连接，未提交修改回滚`, async () => {
      const sleep = engine === 'mysql' ? 'SELECT SLEEP(2)' : 'SELECT pg_sleep(2)';
      await expect(executeSqlConsole({ ...options[engine], timeoutMs: 400, sql: `BEGIN; UPDATE qa_console_protocol_test SET qty=99; ${sleep}; COMMIT`, readOnly: false })).rejects.toThrow(/超时|timeout|terminated/i);
      expect((await query(engine, 'SELECT qty FROM qa_console_protocol_test')).rows).toEqual([['10']]);
    });

    it(`${engine} 多条修改与查询保持同一事务，回滚后原值不变`, async () => {
      const result = await query(engine, 'BEGIN; UPDATE qa_console_protocol_test SET qty=qty+2 WHERE id=1; SELECT id,qty FROM qa_console_protocol_test; ROLLBACK', false);
      expect(result.resultSets![0].rows).toEqual([['1', '12']]);
      expect(result.output).toMatch(/UPDATE 1|1 row affected/);
      expect((await query(engine, 'SELECT qty FROM qa_console_protocol_test')).rows).toEqual([['10']]);
    });

    it(`${engine} 第二条失败仍保留已执行查询和修改记录，未提交事务回滚`, async () => {
      const error = await query(engine, 'BEGIN; UPDATE qa_console_protocol_test SET qty=99; SELECT id,qty FROM qa_console_protocol_test; SELECT * FROM qa_console_missing_table; COMMIT', false).catch(error => error);
      expect(error).toBeInstanceOf(SqlConsoleExecutionError);
      expect(error.partialResult.resultSets[0].rows).toEqual([['1', '99']]);
      expect(error.partialResult.output).toMatch(/UPDATE 1|1 row affected/);
      expect((await query(engine, 'SELECT qty FROM qa_console_protocol_test')).rows).toEqual([['10']]);
    });

    it(`${engine} 不能在只读查询中关闭数据库只读事务`, async () => {
      const sql = engine === 'postgres' ? "SELECT set_config('transaction_read_only','off',true)" : 'SET TRANSACTION READ WRITE';
      await expect(query(engine, sql)).rejects.toThrow();
      expect((await query(engine, 'SELECT qty FROM qa_console_protocol_test')).rows).toEqual([['10']]);
    });
  }
});
