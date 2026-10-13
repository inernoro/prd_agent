import { describe, expect, it } from 'vitest';
import { parseSqlConsoleResults } from '../../src/services/sql-console-results.js';

describe('数据库客户端多结果展示', () => {
  it('MySQL 独立查询、修改记录、空结果、NULL 和转义内容均保留', () => {
    const result = parseSqlConsoleResults(`Query OK, 1 row affected
<?xml version="1.0"?><resultset statement="SELECT 'a&amp;b'">
<row><field name="text">a&amp;b&lt;c&gt;\n下一行</field><field name="missing" xsi:nil="true"/><field name="empty"></field></row>
</resultset>
Query OK, 2 rows affected
<resultset statement="SELECT 2"><row><field name="n">2</field></row></resultset>
<resultset statement="SELECT 3 WHERE false"></resultset>`, 'mysql');
    expect(result.resultSets).toHaveLength(3);
    expect(result.resultSets![0].rows).toEqual([['a&b<c>\n下一行', null, '']]);
    expect(result.resultSets![0].statement).toBe("SELECT 'a&b'");
    expect(result.resultSets![1].columns).toEqual(['n']);
    expect(result.resultSets![2].rowCount).toBe(0);
    expect(result.output).toContain('1 row affected');
    expect(result.output).toContain('2 rows affected');
    expect(result.output).not.toContain('<field');
  });

  it('PostgreSQL HTML 结果单独解析，命令结果连续保留', () => {
    const result = parseSqlConsoleResults('UPDATE 1\n<table border="1"><tr><th>a</th></tr><tr><td>&lt;x&gt;<br />y</td></tr></table>\nUPDATE 2\n<table border="1"><tr><th>b</th></tr></table>', 'postgres');
    expect(result.resultSets).toHaveLength(2);
    expect(result.resultSets![0].rows).toEqual([['<x>\ny']]);
    expect(result.resultSets![1].columns).toEqual(['b']);
    expect(result.output).toContain('UPDATE 1');
    expect(result.output).toContain('UPDATE 2');
  });

  it('大输出标记截断，保留完整的先前查询，不拼出伪结果', () => {
    const result = parseSqlConsoleResults('<resultset statement="SELECT 1"><row><field name="a">1</field></row></resultset>' + 'x'.repeat(300_000), 'mysql');
    expect(result.truncated).toBe(true);
    expect(result.resultSets![0].rows).toEqual([['1']]);
    expect(result.output!.length).toBeLessThanOrEqual(256 * 1024);
  });
});
