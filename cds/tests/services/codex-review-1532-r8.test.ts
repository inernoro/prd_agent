/**
 * Codex review（PR #1532）第八轮的服务端两条。
 *
 * 一条是上一轮那个判据开得太窄的续集：只挡了「projectId 为空」，没挡「projectId 指着
 * 一个已经被删掉的项目」。后者同样挂不到任何现存项目，同样从总览里消失，
 * 而走向序列照旧按那个悬空 id 把它画出来。
 *
 * 一条是持久顺序：改格式时把旧对象删在 save() 之前，而 save() 是写后即返回的。
 * 删完要是没写成，持久的元数据还指着刚被删掉的旧键——重启即读不出来。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPipelineOverview, buildPipelineSeries } from '../../src/services/acceptance-pipeline.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { AcceptanceReportMeta, Project } from '../../src/types.js';

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

describe('项目被删之后，它名下的报告不许从总览里消失', () => {
  it('指着已删项目的报告与无主报告一样落账', () => {
    // gone 这个项目不在 projects 里（被 removeProject 删了，而报告原样留着）。
    const reports = [report('r1', { projectId: 'gone' }), report('r2', { projectId: 'gone' })];
    const o = buildPipelineOverview([project('p1')], [], [], reports, { now: NOW });
    expect(o.totalLeaks['report-missing-change-key'], '悬空项目的报告一条都没进总览').toBe(2);
    expect(o.leaks.map((l) => l.projectId), '漏点要保留它原本指的那个项目 id')
      .toEqual(['gone', 'gone']);
  });

  it('记了标识但挂不上的，照样算背景数不算漏', () => {
    const o = buildPipelineOverview(
      [project('p1')], [], [], [report('r1', { projectId: 'gone', branch: 'feat/x' })], { now: NOW },
    );
    expect(o.totalLeaks['report-missing-change-key']).toBe(0);
    expect(o.staleReports).toBe(1);
  });

  it('两个聚合对得上：走向序列画出来的那条悬空项目线，总览里数得出同样多', () => {
    const reports = [
      report('r1', { projectId: 'gone' }),
      report('r2', { projectId: 'gone', branch: 'feat/x' }),
    ];
    const o = buildPipelineOverview([project('p1')], [], [], reports, { now: NOW });
    const s = buildPipelineSeries([project('p1')], [], reports, { days: 30, now: NOW });
    const dangling = s.projects.find((p) => p.projectId === 'gone');
    expect(dangling, '走向序列里没有那条悬空项目线').toBeTruthy();
    expect(o.totalLeaks['report-missing-change-key'] + o.staleReports).toBe(dangling!.total);
  });

  it('现存项目的报告照常走项目内那一圈，没被这次放宽重复计数', () => {
    const reports = [report('r1', { projectId: 'p1' }), report('r2', { projectId: 'gone' })];
    const o = buildPipelineOverview([project('p1')], [], [], reports, { now: NOW });
    expect(o.totalLeaks['report-missing-change-key']).toBe(2);
    expect(o.leaks).toHaveLength(2);
    expect(new Set(o.leaks.map((l) => l.projectId))).toEqual(new Set(['p1', 'gone']));
  });
});

describe('旧版本对象不许删在元数据落定之前', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('改格式重写正文之后，旧对象仍在桶里（留给日后回收，不是当场删）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-keep-old-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    const store = new Map<string, string>();
    const removed: string[] = [];
    (svc as unknown as { reportObjects: unknown }).reportObjects = {
      isConfigured: () => true,
      put: async (m: { id: string; format: string }, c: string) => {
        const key = `k/${m.id}.${m.format}`;
        store.set(key, c);
        return key;
      },
      get: async (key: string) => store.get(key) ?? null,
      remove: async (key: string) => { removed.push(key); store.delete(key); },
    };

    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 换格式', kind: '验收', format: 'md', content: '旧正文',
    } as never);
    const oldKey = meta.objectKey!;
    await svc.updateAcceptanceReportAsync(meta.id, { format: 'html', content: '新正文' } as never);

    expect(meta.objectKey, '新键没换上').not.toBe(oldKey);
    expect(removed, '旧对象被当场删了：save() 是写后即返回，这一刻元数据还没落定').toEqual([]);
    expect(store.has(oldKey), '旧正文已经不在桶里，元数据没写成就再也读不回来').toBe(true);
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('新正文');
  });
});
