/**
 * Codex review（PR #1532）第六轮的服务端两条。
 *
 * 一条是「账在哪货就在哪」在演示数据上的形态：元数据跟着库跨部署活了下来，
 * 正文跟着容器没了，而按标题判重的补播直接跳过——那批报告点开永远 404。
 * 判据按规则原话来：**删掉本地目录模拟一次容器重建**，不删的测试永远是绿的。
 *
 * 一条是同一个响应里两个数打架：无主报告（projectId 为空）在走向序列里被当成
 * 「无主」项目照常画出来，在总览里却一条都不算——同屏对不上账。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { seedPreviewInstanceSnapshot } from '../../src/services/preview-instance-seed.js';
import { buildPipelineOverview, buildPipelineSeries } from '../../src/services/acceptance-pipeline.js';
import type { AcceptanceReportMeta, Project } from '../../src/types.js';

describe('演示数据：容器重建之后正文必须还取得出来', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fresh(): { svc: StateService; base: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-seed-rebuild-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    // 正文目录由 StateService 自己决定（挂在 cacheBase 旁边），不许在测试里猜路径——
    // 猜错就删了个空气，用例照样绿，而它自称在模拟容器重建。
    return { svc, base: svc.getReportsBase() };
  }

  it('删掉报告目录再播一次，每一份演示报告的正文都读得回来', () => {
    const { svc, base } = fresh();
    expect(seedPreviewInstanceSnapshot(svc)).toBe(true);
    const seeded = svc.listAcceptanceReports(null).filter((r) => r.createdBy === 'preview-instance-seed');
    expect(seeded.length).toBeGreaterThan(100);
    for (const r of seeded) expect(svc.readAcceptanceReportContent(r.id), r.title).toBeTruthy();

    // 容器重建：库还在（元数据跟着 state 活着），盘上的正文没了。
    expect(fs.existsSync(base), '报告目录找不到了，这条用例没在测它以为在测的东西').toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
    for (const r of seeded) expect(svc.readAcceptanceReportContent(r.id)).toBeUndefined();

    // 重建后的第一次播种要把正文补回来，而不是按标题判重一路跳过。
    seedPreviewInstanceSnapshot(svc);
    const after = svc.listAcceptanceReports(null).filter((r) => r.createdBy === 'preview-instance-seed');
    expect(after, '补播不许重复建记录').toHaveLength(seeded.length);
    for (const r of after) {
      expect(svc.readAcceptanceReportContent(r.id), `${r.title} 的正文没补回来`).toBeTruthy();
    }
  });

  it('正文都在时补播一次不写任何东西（别每次启动都刷一遍库）', () => {
    const { svc } = fresh();
    seedPreviewInstanceSnapshot(svc);
    expect(seedPreviewInstanceSnapshot(svc)).toBe(false);
  });

  it('别人写的报告正文丢了不归这里管', () => {
    const { svc, base } = fresh();
    seedPreviewInstanceSnapshot(svc);
    const mine = svc.createAcceptanceReport({
      title: '功能验收 · 我自己的 · 2026-09-15', kind: '验收', format: 'md', content: '正文',
    } as never);
    fs.rmSync(base, { recursive: true, force: true });
    seedPreviewInstanceSnapshot(svc);
    expect(svc.readAcceptanceReportContent(mine.id), '替别人重写了正文').toBeUndefined();
  });
});

describe('无主报告：总览与走向必须认同一批', () => {
  const project = (id: string): Project => ({
    id, slug: id, name: id, kind: 'git',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project);
  const report = (id: string, extra: Partial<AcceptanceReportMeta> = {}): AcceptanceReportMeta => ({
    id, format: 'md', sizeBytes: 1, projectId: null, verdict: 'pass',
    title: `功能验收 · T${id} · 2026-09-12`,
    createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', ...extra,
  } as unknown as AcceptanceReportMeta);

  const NOW = new Date('2026-09-15T00:00:00.000Z');

  it('三个标识全空的无主报告要进「报告没记它验的是谁」', () => {
    const reports = [report('u1'), report('u2'), report('u3')];
    const o = buildPipelineOverview([project('p1')], [], [], reports, { now: NOW });
    expect(o.totalLeaks['report-missing-change-key'], '无主报告一条都没进总览').toBe(3);
    expect(o.leaks.filter((l) => l.projectId === null)).toHaveLength(3);
  });

  it('记了标识但挂不上的无主报告算背景数，不算漏', () => {
    const o = buildPipelineOverview([project('p1')], [], [], [report('u1', { branch: 'feat/gone' })], { now: NOW });
    expect(o.totalLeaks['report-missing-change-key']).toBe(0);
    expect(o.staleReports).toBe(1);
  });

  it('同一批数据下，总览数得到的无主报告数与走向序列一致', () => {
    // 两个聚合来自同一次请求、画在同一屏。一个算 0 一个算 20，是最难查的那种打架。
    const reports = [report('u1'), report('u2'), report('u3', { branch: 'feat/gone' })];
    const o = buildPipelineOverview([project('p1')], [], [], reports, { now: NOW });
    const s = buildPipelineSeries([project('p1')], [], reports, { days: 30, now: NOW });
    const unowned = s.projects.find((p) => p.projectId === null);
    expect(unowned, '走向序列里没有无主那条').toBeTruthy();
    expect(o.totalLeaks['report-missing-change-key'] + o.staleReports).toBe(unowned!.total);
  });

  it('有主报告不受影响，没被这次改动重复计数', () => {
    const reports = [report('p1r1', { projectId: 'p1' }), report('u1')];
    const o = buildPipelineOverview([project('p1')], [], [], reports, { now: NOW });
    expect(o.totalLeaks['report-missing-change-key']).toBe(2);
    expect(o.leaks.filter((l) => l.kind === 'report-missing-change-key')).toHaveLength(2);
  });
});
