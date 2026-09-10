/**
 * 报告正文「容器重建后还在不在」的守卫（2026-09-10）。
 *
 * 这组用例复现的是真实事故：元数据在 Mongo（持久、跨分支共享），正文在容器本地盘。
 * 容器一重建正文全没、元数据还在——列表里 23 份报告，点开每一份都是 404。
 * 所以下面每条用例都用「删掉本地缓存目录」来模拟容器重建，这是判据的关键动作：
 * 不删缓存的测试永远是绿的，也就永远测不出这个 bug。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { createReportObjectStore } from '../../src/services/report-object-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

/** 一个装在内存里的对象存储替身：桶本身不随容器走，这正是它要模拟的性质。 */
function memoryObjectStore(): ReturnType<typeof createReportObjectStore> & { bucket: Map<string, string> } {
  const bucket = new Map<string, string>();
  const store = createReportObjectStore(
    { endpoint: 'https://x', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', prefix: 'p' },
    {
      upload: async (opts) => {
        bucket.set(opts.objectKey, opts.body.toString('utf-8'));
        return { objectKey: opts.objectKey, bytes: opts.body.byteLength, sha256: 'x' };
      },
      fetchObject: async (opts) => {
        const hit = bucket.get(opts.objectKey);
        return hit === undefined ? null : Buffer.from(hit, 'utf-8');
      },
      remove: async (opts) => { bucket.delete(opts.objectKey); },
    },
  );
  return Object.assign(store, { bucket });
}

describe('验收报告正文的持久性', () => {
  let stateFile: string;
  let cacheBase: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-report-durability-'));
    stateFile = path.join(tmpDir, 'state.json');
    cacheBase = path.join(tmpDir, 'cache');
    process.env.CDS_CACHE_BASE = cacheBase;
    service = new StateService(stateFile);
    service.load();
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** 容器重建：本地盘上的一切都没了，元数据（在 Mongo）原封不动。 */
  const rebuildContainer = (): void => {
    const reportsDir = service.getReportsBase();
    if (fs.existsSync(reportsDir)) fs.rmSync(reportsDir, { recursive: true, force: true });
  };

  it('配了对象存储：容器重建后正文照样读得回来', async () => {
    const objects = memoryObjectStore();
    service.setReportObjectStore(objects);

    const meta = await service.createAcceptanceReportAsync({
      title: '功能验收 · 订单导出 · 2026-09-10',
      format: 'md', content: '# 结论\n\n通过。', projectId: 'p1', createdBy: 'ai',
    });
    expect(meta.storage).toBe('object');
    expect(meta.objectKey).toBe('reports/p1/' + meta.id + '.md');

    rebuildContainer();

    // 这一行就是整个事故的判据：以前它是 undefined，于是页面上是 404。
    expect(await service.readAcceptanceReportContentAsync(meta.id)).toBe('# 结论\n\n通过。');
  });

  it('读回来会顺手回填本地缓存，下一次不必再打对象存储', async () => {
    const objects = memoryObjectStore();
    service.setReportObjectStore(objects);
    const meta = await service.createAcceptanceReportAsync({
      title: 't', format: 'md', content: '正文', projectId: 'p1', createdBy: 'ai',
    });
    rebuildContainer();
    await service.readAcceptanceReportContentAsync(meta.id);

    // 缓存回填后，即便桶里被清空也还能读到——证明确实落了本地一份
    objects.bucket.clear();
    expect(await service.readAcceptanceReportContentAsync(meta.id)).toBe('正文');
  });

  it('没配对象存储：如实标 storage=local，并说得出「为什么会没」', async () => {
    service.setReportObjectStore(createReportObjectStore(null));
    const meta = await service.createAcceptanceReportAsync({
      title: 't', format: 'md', content: '正文', projectId: 'p1', createdBy: 'ai',
    });
    expect(meta.storage).toBe('local');
    expect(meta.objectKey).toBeNull();

    const why = service.describeAcceptanceReportStorage(meta);
    expect(why.durable).toBe(false);
    expect(why.reason).toContain('未配置对象存储');

    rebuildContainer();
    // 正文确实没了——但这不是「悄悄没的」，元数据上写着它只在本地
    expect(await service.readAcceptanceReportContentAsync(meta.id)).toBeUndefined();
  });

  it('历史报告（改动之前归档的）与「本地存储」区分得开——下一步动作不同', () => {
    const legacy = { id: 'x', format: 'md' as const, storage: undefined, objectKey: undefined };
    const why = service.describeAcceptanceReportStorage(legacy as never);
    expect(why.durable).toBe(false);
    expect(why.reason).toContain('归档于正文入对象存储之前');
  });

  it('改正文会同步改对象存储，不会读回旧正文', async () => {
    const objects = memoryObjectStore();
    service.setReportObjectStore(objects);
    const meta = await service.createAcceptanceReportAsync({
      title: 't', format: 'md', content: '第一版', projectId: 'p1', createdBy: 'ai',
    });
    await service.updateAcceptanceReportAsync(meta.id, { content: '第二版' });

    rebuildContainer();
    expect(await service.readAcceptanceReportContentAsync(meta.id)).toBe('第二版');
  });

  it('删报告会连对象一起删，桶里不留没人认领的正文', async () => {
    const objects = memoryObjectStore();
    service.setReportObjectStore(objects);
    const meta = await service.createAcceptanceReportAsync({
      title: 't', format: 'md', content: '正文', projectId: 'p1', createdBy: 'ai',
    });
    expect(objects.bucket.size).toBe(1);
    service.deleteAcceptanceReport(meta.id);
    await new Promise((r) => setTimeout(r, 0)); // 删对象是异步的，等它落地
    expect(objects.bucket.size).toBe(0);
  });

  it('上传失败就整个归档失败，绝不落一条点不开的元数据', async () => {
    service.setReportObjectStore(createReportObjectStore(
      { endpoint: 'https://x', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', prefix: 'p' },
      { upload: async () => { throw new Error('离机对象上传失败（HTTP 503）'); } },
    ));
    await expect(service.createAcceptanceReportAsync({
      title: 't', format: 'md', content: '正文', projectId: 'p1', createdBy: 'ai',
    })).rejects.toThrow('上传失败');
    // 关键：元数据一条都不许留下——留下就又是一条幽灵记录
    expect(service.listAcceptanceReports('p1')).toHaveLength(0);
  });
});
