import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { inspectMongoArchive, summarizeArchive, countNeedlesAcrossChunks } from '../../src/services/infra-archive-inspect.js';

/**
 * 归档体检的回归。
 *
 * 这个工具的产出会被当成「拿哪一份备份去恢复」的依据，所以两类错误都必须钉死：
 *   - 少数：跨 chunk 边界的集合名漏掉 → 好备份被误判成空库 → 被跳过不用；
 *   - 多数：同一处命中被重复统计 → 空库看起来像有数据 → 拿它去恢复，恢复出个空。
 * 前者更隐蔽，因为它不会报错，只会让判断悄悄偏保守。
 */

let dir = '';
const write = async (name: string, buf: Buffer): Promise<string> => {
  const p = path.join(dir, name);
  await fs.promises.writeFile(p, buf);
  return p;
};

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-archive-inspect-'));
});
afterAll(async () => {
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('归档体检', () => {
  it('含业务集合名的归档判为 has-data，并给出命中次数', async () => {
    const body = Buffer.from('....defect_reports....llmrequestlogs....defect_reports....', 'utf8');
    const file = await write('has-data.gz', zlib.gzipSync(body));

    const r = await inspectMongoArchive({
      filePath: file,
      expectCollections: ['defect_reports', 'llmrequestlogs', 'never_present_here'],
    });

    expect(r.gzipOk).toBe(true);
    expect(r.uncompressedBytes).toBe(body.length);
    expect(r.hits.defect_reports).toBe(2);
    expect(r.hits.llmrequestlogs).toBe(1);
    expect(r.missing).toEqual(['never_present_here']);
    expect(summarizeArchive(r).verdict).toBe('has-data');
  });

  it('一个已知集合都没有的归档判为 empty——这正是删库后备份的形状', async () => {
    const file = await write('empty.gz', zlib.gzipSync(Buffer.from('no business collections here', 'utf8')));
    const r = await inspectMongoArchive({
      filePath: file,
      expectCollections: ['defect_reports', 'llmrequestlogs'],
    });
    expect(r.gzipOk).toBe(true);
    expect(Object.keys(r.hits)).toEqual([]);
    expect(summarizeArchive(r).verdict).toBe('empty');
  });

  it('gzip 损坏判为 broken，并说明读到哪里断的', async () => {
    const good = zlib.gzipSync(Buffer.from('defect_reports'.repeat(5000), 'utf8'));
    const file = await write('broken.gz', good.subarray(0, Math.floor(good.length / 2)));
    const r = await inspectMongoArchive({ filePath: file, expectCollections: ['defect_reports'] });
    expect(r.gzipOk).toBe(false);
    expect(r.gzipError).toBeTruthy();
    expect(summarizeArchive(r).verdict).toBe('broken');
  });

  // 下面两条直接驱动计数器：分块位置由测试指定，不依赖 zlib 怎么切。
  // 第一版这两条走 gunzip 间接测，去掉去重条件后仍然全绿——假绿，已换掉。
  it('集合名横跨块边界要数到（少数会把好备份误判成空库）', () => {
    const n = 'defect_reports';
    const b = Buffer.from(`....${n}....`, 'utf8');
    for (let cut = 1; cut < b.length; cut += 1) {
      const counts = countNeedlesAcrossChunks([b.subarray(0, cut), b.subarray(cut)], [n]);
      expect(counts[n], `切点 ${cut} 处漏数`).toBe(1);
    }
  });

  it('同一处命中不许被重复统计（多数会把空库说成有数据）', () => {
    const n = 'llmrequestlogs';
    const b = Buffer.from(`--${n}--${n}--`, 'utf8');
    for (let cut = 1; cut < b.length; cut += 1) {
      const counts = countNeedlesAcrossChunks([b.subarray(0, cut), b.subarray(cut)], [n]);
      expect(counts[n], `切点 ${cut} 处计数不对`).toBe(2);
    }
  });

  // 去重条件只在**候选长短不一**时才可达：overlap 取最长 needle - 1，
  // 于是短名字可以整个落进尾巴、下一块再被数一遍。真实用法正是 304 个长短不一的
  // 集合名，所以这条必须覆盖。单 needle 的用例测不到它（尾巴装不下一个完整 needle），
  // 第一版就是这么漏的：把去重条件删光，测试照样全绿。
  it('长短不一的候选：短名字落在尾巴里也不许被数两遍', () => {
    const short = 'customers';                          // 9 字节
    const long = 'channel_trace_diagnose_sessions';     // 31 字节 -> overlap = 30
    const b = Buffer.from(`${'.'.repeat(20)}${short}${'.'.repeat(40)}`, 'utf8');
    // 切点选在 short 之后不远处，保证 short 完整落进 30 字节的尾巴里。
    const cut = 20 + short.length + 4;
    const counts = countNeedlesAcrossChunks([b.subarray(0, cut), b.subarray(cut)], [short, long]);
    expect(counts[short], '短名字被重复统计').toBe(1);
    expect(counts[long]).toBe(0);
  });

  it('三块以上连续切分同样不重不漏', () => {
    const n = 'attachments';
    const b = Buffer.from(`x${n}yy${n}z`, 'utf8');
    const counts = countNeedlesAcrossChunks(
      [b.subarray(0, 3), b.subarray(3, 7), b.subarray(7, 15), b.subarray(15)], [n]);
    expect(counts[n]).toBe(2);
  });

  it('sha256 算的是压缩态文件本身，可与离机副本比对同一性', async () => {
    const raw = zlib.gzipSync(Buffer.from('defect_reports', 'utf8'));
    const file = await write('sha.gz', raw);
    const r = await inspectMongoArchive({ filePath: file, expectCollections: ['defect_reports'] });
    const expected = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex');
    expect(r.sha256).toBe(expected);
    expect(r.compressedBytes).toBe(raw.length);
  });

  it('随仓库发布的候选集合清单结构完整', async () => {
    const cfg = JSON.parse(
      await fs.promises.readFile(new URL('../../config/prdagent-expected-collections.json', import.meta.url), 'utf8'),
    );
    expect(Array.isArray(cfg.collections)).toBe(true);
    expect(cfg.collections.length).toBeGreaterThan(100);
    expect(cfg.collections).toContain('defect_reports');
    // 名字里带空格/引号会让子串匹配失去意义，派生脚本出错时这里会红。
    for (const name of cfg.collections) expect(name).toMatch(/^[a-zA-Z0-9_]+$/);
  });
});
