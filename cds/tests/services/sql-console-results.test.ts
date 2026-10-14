import { describe, expect, it } from 'vitest';
import { SqlResultCollector } from '../../src/services/sql-console-executor.js';

describe('数据库协议多结果展示', () => {
  it('重复列名、NULL、空串、特殊字符、大数及空查询元数据均保留', () => {
    const collector = new SqlResultCollector();
    collector.record('UPDATE 1');
    const first = collector.fields(['value', 'value', 'empty', 'text', 'big']);
    collector.row(first, [null, 'NULL', '', '前\t后\n下一行\r\n<>&&nbsp;', '1000000000000000001']);
    collector.fields(['empty_id', 'empty_qty']);
    const result = collector.result();
    expect(result.resultSets).toHaveLength(2);
    expect(result.rows).toEqual([[null, 'NULL', '', '前\t后\n下一行\r\n<>&&nbsp;', '1000000000000000001']]);
    expect(result.columns).toEqual(['value', 'value', 'empty', 'text', 'big']);
    expect(result.resultSets![1]).toEqual({ columns: ['empty_id', 'empty_qty'], rows: [], rowCount: 0 });
    expect(result.output).toBe('UPDATE 1');
  });

  it('只有修改记录时结果不是伪查询，且多次修改记录连续保留', () => {
    const collector = new SqlResultCollector();
    collector.record('UPDATE 1'); collector.record('DELETE 2');
    expect(collector.result()).toMatchObject({ columns: [], rows: [], resultSets: [], output: 'UPDATE 1\nDELETE 2' });
  });

  it('按 UTF-8 字节截断，不切破一个值；保留先前完整行及后续空查询列名', () => {
    const collector = new SqlResultCollector(64);
    const first = collector.fields(['text']);
    collector.row(first, ['短内容']);
    collector.row(first, ['汉'.repeat(30)]);
    collector.fields(['empty']);
    expect(collector.result()).toMatchObject({ truncated: true, rows: [['短内容']], rowCount: 2 });
    expect(collector.result().resultSets![1].columns).toEqual(['empty']);
  });
});
