/**
 * 验收报告正文的持久层守卫（2026-09-10）。
 *
 * 起因是一条真实事故：元数据在 Mongo、正文在容器本地盘，容器一重建，
 * 列表里 23 份报告点开每一份都是 404。这组断言钉住三件事：
 *   1. 配了对象存储 → 正文必须进对象存储，本地盘只是缓存;
 *   2. 没配 → 必须如实标 storage='local'，绝不许标成持久而骗人;
 *   3. 「读不到」的三种成因要分得开——它们的下一步动作完全不同。
 */
import { describe, it, expect } from 'vitest';
import {
  createReportObjectStore, reportObjectKey, reportObjectStoreFromEnv,
} from '../../src/services/report-object-store.js';

const CONFIG = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'cds',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
  prefix: 'cds-acceptance-reports',
};

describe('reportObjectStoreFromEnv', () => {
  it('凭据齐全才给配置', () => {
    expect(reportObjectStoreFromEnv({
      R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's',
    })).not.toBeNull();
  });

  it('凭据只有一半时返回 null，不做「有几个算几个」的降级', () => {
    // 半套凭据只会写出一批取不回来的对象——prd-api 的 AssetStorageProviderResolver
    // 早就明令禁止这种静默回退，CDS 这边照抄。
    for (const partial of [
      { R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com' },
      { R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_BUCKET: 'b' },
      { R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'a' },
    ]) {
      expect(reportObjectStoreFromEnv(partial), JSON.stringify(partial)).toBeNull();
    }
  });

  it('报告前缀与基础设施备份前缀分开——备份桶的回收策略不能顺手把证据删了', () => {
    const cfg = reportObjectStoreFromEnv({
      R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's',
      R2_PREFIX: 'cds-infra-backups',
    });
    expect(cfg!.prefix).toBe('cds-acceptance-reports');
  });
});

describe('reportObjectKey', () => {
  it('按项目分段，扩展名跟格式走', () => {
    expect(reportObjectKey({ id: 'abc', format: 'md', projectId: 'p1' })).toBe('reports/p1/abc.md');
    expect(reportObjectKey({ id: 'abc', format: 'html', projectId: 'p1' })).toBe('reports/p1/abc.html');
  });

  it('projectId 缺失或含奇怪字符时不许拼出空段或穿越路径', () => {
    expect(reportObjectKey({ id: 'abc', format: 'md', projectId: null })).toBe('reports/_unassigned/abc.md');
    expect(reportObjectKey({ id: 'abc', format: 'md', projectId: '../../etc' })).toBe('reports/etc/abc.md');
  });
});

describe('createReportObjectStore', () => {
  it('未配置时 put 返回 null——调用方据此标 local，而不是假装存上了', async () => {
    const store = createReportObjectStore(null);
    expect(store.isConfigured()).toBe(false);
    expect(await store.put({ id: 'a', format: 'md', projectId: 'p' }, '正文')).toBeNull();
    expect(await store.get('reports/p/a.md')).toBeNull();
  });

  it('配置后 put 走上传并返回对象键，内容类型跟格式走', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = createReportObjectStore(CONFIG, {
      upload: async (opts) => {
        calls.push({ objectKey: opts.objectKey, contentType: opts.contentType, body: opts.body.toString('utf-8') });
        return { objectKey: opts.objectKey, bytes: opts.body.byteLength, sha256: 'x' };
      },
    });
    expect(await store.put({ id: 'a', format: 'md', projectId: 'p' }, '# 标题')).toBe('reports/p/a.md');
    expect(calls[0]).toEqual({
      objectKey: 'reports/p/a.md',
      contentType: 'text/markdown; charset=utf-8',
      body: '# 标题',
    });
  });

  it('空正文不上传：写一个取回来也没用的对象不如让调用方走 local 那条路', async () => {
    let uploaded = 0;
    const store = createReportObjectStore(CONFIG, {
      upload: async (opts) => { uploaded += 1; return { objectKey: opts.objectKey, bytes: 0, sha256: '' }; },
    });
    expect(await store.put({ id: 'a', format: 'md', projectId: 'p' }, '')).toBeNull();
    expect(uploaded).toBe(0);
  });

  it('对象不存在返回 null，网络故障照常抛——「没存过」与「取不回来」不能混成一种', async () => {
    const missing = createReportObjectStore(CONFIG, { fetchObject: async () => null });
    expect(await missing.get('reports/p/a.md')).toBeNull();

    const broken = createReportObjectStore(CONFIG, {
      fetchObject: async () => { throw new Error('对象取回失败（HTTP 500）'); },
    });
    await expect(broken.get('reports/p/a.md')).rejects.toThrow('对象取回失败');
  });
});
