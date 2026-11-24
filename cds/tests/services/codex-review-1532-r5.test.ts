/**
 * Codex review（PR #1532）第五轮：两条服务端。
 *
 * 一条是「接口失败了，但内存已经改了」——路由回 500、不落盘，可同一个进程里
 * 后续的列表与详情读到的已经是被拒绝的那一版。
 * 一条是滚动均值的开头：图上每一点都标着 7 日均，而前六天只有 1~6 个样本。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPipelineSeries, SERIES_LEAD_IN } from '../../src/services/acceptance-pipeline.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { AcceptanceReportMeta, BranchEntry, Project } from '../../src/types.js';

describe('更新失败必须回滚内存里的元数据', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function svcWithStore(fail: boolean): StateService {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rollback-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    const store = new Map<string, string>();
    (svc as unknown as { reportObjects: unknown }).reportObjects = {
      isConfigured: () => true,
      put: async (meta: { id: string; format: string }, content: string) => {
        if (fail) throw new Error('对象上传失败（HTTP 503）');
        const key = `k/${meta.id}.${meta.format}`;
        store.set(key, content);
        return key;
      },
      get: async (key: string) => store.get(key) ?? null,
      remove: async () => undefined,
    };
    return svc;
  }

  it('上传失败时标题与格式必须回到改之前，而不是留在内存里', async () => {
    const svc = svcWithStore(false);
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 原标题', kind: '验收', format: 'md', content: '正文',
    } as never);
    const originalKey = meta.objectKey;

    (svc as unknown as { reportObjects: { put: unknown } }).reportObjects.put = async () => {
      throw new Error('对象上传失败（HTTP 503）');
    };

    await expect(svc.updateAcceptanceReportAsync(meta.id, {
      title: '[验收] 被拒绝的新标题', format: 'html', content: '新正文',
    } as never)).rejects.toThrow('对象上传失败');

    // 路由此时回 500 且不 save；内存里这条必须仍是改之前那一版。
    const after = svc.getAcceptanceReport(meta.id)!;
    expect(after.title, '被拒绝的标题留在了内存里').toBe('[验收] 原标题');
    expect(after.format, '被拒绝的格式留在了内存里，本地缓存会去找另一个扩展名').toBe('md');
    expect(after.objectKey).toBe(originalKey);
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('正文');
  });

  it('上传成功时该改的照样改（防止回滚写过头）', async () => {
    const svc = svcWithStore(false);
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 原标题', kind: '验收', format: 'md', content: '正文',
    } as never);
    await svc.updateAcceptanceReportAsync(meta.id, { title: '[验收] 新标题', content: '新正文' } as never);
    const after = svc.getAcceptanceReport(meta.id)!;
    expect(after.title).toBe('[验收] 新标题');
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('新正文');
  });
});

describe('走向序列的预热段：7 日均的第一天也得真有 7 天', () => {
  const project = (id: string): Project => ({
    id, slug: id, name: id, kind: 'git',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project);
  const branch = (b: string, createdAt: string): BranchEntry => ({
    id: `b-${b}`, branch: b, projectId: 'p1', worktreePath: '/tmp/x', status: 'running',
    createdAt, services: {},
  } as unknown as BranchEntry);
  const report = (id: string, createdAt: string): AcceptanceReportMeta => ({
    id, format: 'md', sizeBytes: 1, projectId: 'p1', verdict: 'pass',
    title: `功能验收 · T${id} · ${createdAt.slice(0, 10)}`, createdAt, updatedAt: createdAt,
  } as unknown as AcceptanceReportMeta);

  const NOW = new Date('2026-09-15T12:00:00.000Z');
  const build = (branches: BranchEntry[], reports: AcceptanceReportMeta[]) =>
    buildPipelineSeries([project('p1')], branches, reports, { days: 10, now: NOW });

  it('预热天数与前端的滚动窗口是同一个契约的两半', () => {
    // 两边各写一个数字，改一边不改另一边不会有任何东西变红——开头几天又会少样本，
    // 而图上照旧标着 7 日均。这条把它们钉在一起。
    const web = fs.readFileSync(
      path.resolve(__dirname, '../..', 'web/src/pages/reports/TrendCharts.tsx'), 'utf8',
    );
    const win = Number(web.match(/^const WIN = (\d+);$/m)?.[1]);
    expect(win, '前端的 WIN 找不到了').toBeGreaterThan(0);
    expect(SERIES_LEAD_IN, `预热 ${SERIES_LEAD_IN} 天配不上 ${win} 日滚动`).toBe(win - 1);
  });

  it('预热段长度等于 SERIES_LEAD_IN，且排在显示窗口正前方', () => {
    const s = build([], []);
    expect(s.days).toHaveLength(10);
    expect(s.leadIn.days).toHaveLength(SERIES_LEAD_IN);
    expect(s.leadIn.days[s.leadIn.days.length - 1]).toBe('2026-09-05');
    expect(s.days[0]).toBe('2026-09-06');
  });

  it('窗口之前的活动落进预热段，而不是凭空消失', () => {
    // 9-03 建了 3 条分支：它在显示窗口之外，但 9-06 那天的 7 日均应当看得见它。
    const s = build(
      ['a', 'b', 'c'].map((n) => branch(n, '2026-09-03T00:00:00.000Z')),
      [],
    );
    expect(s.changes.every((v) => v === 0), '显示窗口里本来就没有新开改动').toBe(true);
    expect(s.leadIn.changes.reduce((a, b) => a + b, 0), '窗口前那三条掉了').toBe(3);
  });

  it('合计只算显示窗口，预热段不许混进 total', () => {
    const s = build([], [report('r1', '2026-09-03T00:00:00.000Z'), report('r2', '2026-09-10T00:00:00.000Z')]);
    expect(s.leadIn.pass.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.pass.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.projects[0]?.total, '预热段那份被算进了项目合计').toBe(1);
    expect(s.projects[0]?.leadIn?.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.projects[0]?.counts).toHaveLength(10);
  });

  it('只在预热段有活动的项目不许因此上榜', () => {
    // 排名与上榜都按显示窗口算。只在预热段有报告的项目 total 为 0，
    // 它本来就不会被画线，把它留在 projects 里只会让图例多出一条恒零的线。
    const onlyWarm = build([], [report('r1', '2026-09-03T00:00:00.000Z')]);
    expect(onlyWarm.projects).toHaveLength(0);

    // 窗口内有一份，它就该上榜，且带上预热段那份供滚动均值用（但不计入 total）。
    const both = build([], [
      report('r1', '2026-09-03T00:00:00.000Z'),
      report('r2', '2026-09-10T00:00:00.000Z'),
    ]);
    expect(both.projects).toHaveLength(1);
    expect(both.projects[0].total).toBe(1);
    expect(both.projects[0].leadIn?.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
