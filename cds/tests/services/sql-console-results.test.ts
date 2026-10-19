import { describe, expect, it, vi } from 'vitest';
import { executeSqlConsole, SqlResultCollector } from '../../src/services/sql-console-executor.js';

describe('数据库协议多结果展示', () => {
  it('隔离预览实例不能通过原生驱动越过原有宿主访问边界', async () => {
    vi.stubEnv('CDS_PREVIEW_INSTANCE', '1');
    try {
      for (const readOnly of [true, false]) {
        await expect(executeSqlConsole({ runtime: 'postgres', port: 44001, database: 'preview_fixture', user: 'fake_user', password: 'fake_password', sql: 'SELECT 1', readOnly, timeoutMs: 50 })).rejects.toThrow(/预览实例不连接真实数据库/);
      }
    } finally { vi.unstubAllEnvs(); }
  });

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
    const collector = new SqlResultCollector(512);
    const first = collector.fields(['text']);
    collector.row(first, ['短内容']);
    collector.row(first, ['汉'.repeat(200)]);
    collector.fields(['empty']);
    expect(collector.result()).toMatchObject({ truncated: true, rows: [['短内容']], rowCount: 2 });
    expect(collector.result().resultSets![1].columns).toEqual(['empty']);
  });
});

it('bounds wide/repeated query metadata, including JSON overhead and first-result duplication',()=>{
 const cap=4096,collector=new SqlResultCollector(cap);
 const first=collector.fields(['kept']);collector.row(first,['正常']);
 for(let i=0;i<1000;i++){const set=collector.fields(['列'.repeat(100)]);collector.row(set,['row']);}
 const result=collector.result();expect(result.truncated).toBe(true);expect(result.rows).toEqual([['正常']]);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(cap);expect(result.resultSets!.length).toBeLessThan(1000);
});
it('drops oversized metadata without creating a fake empty result or retaining its rows',()=>{
 const collector=new SqlResultCollector(1024);const skipped=collector.fields(['名'.repeat(2000)]);expect(skipped).toBeUndefined();collector.row(skipped,['discard']);
 collector.record('UPDATE 1');const kept=collector.fields(['ok']);collector.row(kept,['2']);
 expect(collector.result()).toMatchObject({truncated:true,columns:['ok'],rows:[['2']],output:'UPDATE 1'});
 expect(Buffer.byteLength(JSON.stringify(collector.result()))).toBeLessThanOrEqual(1024);
});
