import { describe, it, expect } from 'vitest';
import { listR2Backups, parseListObjectsV2, type R2BackupConfig } from '../../src/services/infra-backup-r2.js';
import { partitionByCutoff, sortByTime } from '../../src/cli/offsite-backups.js';

/**
 * 离机列举的回归。
 *
 * 这个列表是「删库前到底有没有备份」的唯一答案来源，所以两类错误都要钉死：
 *   - 分页没走完却当成走完了 → 更早的那些对象不出现在列表里 → 结论变成
 *     「桶里没有更早的备份」，而它其实躺在第二页；
 *   - 分界点判错 → 把删库后的空档案标成「删库前的救命备份」，拿去恢复出个空。
 */

const config: R2BackupConfig = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'am-west',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'secret_test',
  prefix: 'cds-infra-backups',
};

const contents = (key: string, size: number, iso: string): string =>
  `<Contents><Key>${key}</Key><Size>${size}</Size><LastModified>${iso}</LastModified></Contents>`;

const xmlPage = (items: string, opts: { truncated?: boolean; token?: string } = {}): string =>
  `<?xml version="1.0"?><ListBucketResult>${items}`
  + `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>`
  + (opts.token ? `<NextContinuationToken>${opts.token}</NextContinuationToken>` : '')
  + '</ListBucketResult>';

const okResponse = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

describe('离机备份列举', () => {
  it('翻完所有分页才返回——只取第一页会把更早的备份说成不存在', async () => {
    const seen: URL[] = [];
    const pages = [
      xmlPage(contents('cds-infra-backups/a-20260810.archive.gz', 100, '2026-08-10T00:00:00.000Z'),
        { truncated: true, token: 'tok+/=2' }),
      xmlPage(contents('cds-infra-backups/b-20260819.archive.gz', 200, '2026-08-19T00:00:00.000Z')),
    ];
    const fetchImpl = (async (url: URL) => {
      seen.push(url);
      return okResponse(pages[seen.length - 1]);
    }) as unknown as typeof fetch;

    const out = await listR2Backups({ config, fetchImpl, now: new Date('2026-08-19T00:00:00Z') });

    expect(out.map((e) => e.key)).toEqual([
      'cds-infra-backups/a-20260810.archive.gz',
      'cds-infra-backups/b-20260819.archive.gz',
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1].searchParams.get('continuation-token')).toBe('tok+/=2');
    // SigV4 的 canonical query 必须按参数名排序，否则签名对不上（现有调用方都不带
    // query，这条约束在本函数之前从未被触发过）。
    const names = [...seen[1].searchParams.keys()];
    expect(names).toEqual([...names].sort());
  });

  it('响应说截断了却不给续页令牌时报错，不返回半截列表', async () => {
    const fetchImpl = (async () => okResponse(
      xmlPage(contents('cds-infra-backups/only.archive.gz', 1, '2026-08-01T00:00:00.000Z'), { truncated: true }),
    )) as unknown as typeof fetch;
    await expect(listR2Backups({ config, fetchImpl })).rejects.toThrow(/续页令牌/);
  });

  it('页数超上限时报错，不静默截断', async () => {
    const fetchImpl = (async () => okResponse(
      xmlPage(contents('cds-infra-backups/x.archive.gz', 1, '2026-08-01T00:00:00.000Z'),
        { truncated: true, token: 'more' }),
    )) as unknown as typeof fetch;
    await expect(listR2Backups({ config, fetchImpl, maxPages: 3 })).rejects.toThrow(/超过 3 页/);
  });

  it('HTTP 失败带出 R2 的错误码——403 多半是令牌没有 ListBucket 权限', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      text: async () => '<Error><Code>AccessDenied</Code><Message>no list permission</Message></Error>',
    })) as unknown as typeof fetch;
    await expect(listR2Backups({ config, fetchImpl })).rejects.toThrow(/403.*AccessDenied/);
  });

  it('解析只取 Contents，跳过目录项，还原 XML 转义', () => {
    const out = parseListObjectsV2(
      '<CommonPrefixes><Prefix>cds-infra-backups/</Prefix></CommonPrefixes>'
      + contents('cds-infra-backups/', 0, '2026-08-01T00:00:00.000Z')
      + contents('cds-infra-backups/a&amp;b.archive.gz', 42, '2026-08-02T03:04:05.000Z'),
    );
    expect(out).toEqual([
      { key: 'cds-infra-backups/a&b.archive.gz', bytes: 42, lastModified: '2026-08-02T03:04:05.000Z' },
    ]);
  });
});

describe('删库分界点', () => {
  const e = (key: string, iso: string) => ({ key, bytes: 1, lastModified: iso });

  it('按分界点切成前后两组，边界值算「之后」', () => {
    const { before, after } = partitionByCutoff(
      [e('old', '2026-08-14T23:59:59.000Z'), e('edge', '2026-08-15T00:00:00.000Z'), e('new', '2026-08-18T00:00:00.000Z')],
      '2026-08-15T00:00:00.000Z',
    );
    expect(before.map((x) => x.key)).toEqual(['old']);
    expect(after.map((x) => x.key)).toEqual(['edge', 'new']);
  });

  it('时间戳解析不出来的归到「之后」——来历不明的档案不许被标成救命备份', () => {
    const { before, after } = partitionByCutoff([e('junk', 'not-a-date')], '2026-08-15T00:00:00Z');
    expect(before).toEqual([]);
    expect(after.map((x) => x.key)).toEqual(['junk']);
  });

  it('非法分界点直接报错，不当成 0 时刻把所有备份判成「之后」', () => {
    expect(() => partitionByCutoff([e('a', '2026-08-01T00:00:00Z')], '八月十五')).toThrow(/不是合法时间/);
  });

  it('按时间升序排，最后一份是最新的', () => {
    const sorted = sortByTime([e('b', '2026-08-18T00:00:00Z'), e('a', '2026-08-10T00:00:00Z')]);
    expect(sorted.map((x) => x.key)).toEqual(['a', 'b']);
  });
});
