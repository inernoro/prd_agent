import { describe, expect, it } from 'vitest';
import { planMonitorLayout, type LayoutCategory } from '../../web/src/lib/monitorLayout.js';
import { buildWorkspaceModel, visibleWorkspaceServices, workspaceHealthCell } from '../../web/src/lib/monitorWorkspace.js';
import type { UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';

const categories = (counts: number[]): LayoutCategory[] => counts.map((count, i) => ({ id: `category-${i}`, count, ...(i === counts.length - 2 ? { reserve: 3 } : {}) }));
const now = Date.parse('2026-11-10T12:00:00Z');
function target(id: string, changes: Partial<UptimeTargetSummary> = {}): UptimeTargetSummary {
  return { id, name: id, source: 'custom', projectId: 'p', projectName: '项目', branchId: '', profileId: '', probeKind: 'http', status: 'up', measured: true, lastSample: { t: now, up: true, ms: 12 }, availability24h: 1, availability7d: 1, avgLatencyMs24h: 12, sampleCount24h: 1, buckets: [], openIncidentSince: null, statusSince: now, incidentCount: 0, probeDescription: '', intervalSeconds: 60, timeoutMs: 5000, environment: 'production', environmentLabel: '生产', observeMode: 'active', ...changes };
}

describe('空间驱动的真实监控布局', () => {
  it('223项在原稿的可用空间内全部出现，大分类多列、小分类成组', () => {
    const counts = [89, 76, 26, 17, 4, 4, 2, 2, 2, 1];
    const layout = planMonitorLayout(categories(counts), 1500, 920);
    expect(layout.fits).toBe(true);
    expect(layout.overflow).toBe(false);
    const parts = layout.bands.flatMap(band => band.parts);
    expect(parts.some(part => part.stacked && part.indices.length >= 2)).toBe(true);
    expect(parts.find(part => part.indices[0] === 0)?.columns).toBe(4);
    expect(parts.filter(part => !part.stacked).reduce((sum, part) => sum + part.visible, 0) + parts.filter(part => part.stacked).flatMap(part => part.indices).reduce((sum, i) => sum + counts[i], 0)).toBe(223);
  });
  it('相同数量根据实际面积选择密度，缩窄时保留溢出汇总行而不是拉高空框', () => {
    const entries = categories([89, 76, 26, 17, 4, 4, 2, 2, 2, 1]);
    const wide = planMonitorLayout(entries, 1500, 920), narrow = planMonitorLayout(entries, 908, 640);
    expect(narrow.overflow).toBe(true);
    expect(narrow.height).toBeLessThanOrEqual(narrow.availableHeight + 1);
    expect(narrow.bands.flatMap(b => b.parts).some(part => !part.stacked && part.visible < entries[part.indices[0]].count)).toBe(true);
    expect(wide.bands.flatMap(b => b.parts).some(part => part.columns > 1)).toBe(true);
    for (const band of narrow.bands) expect(band.parts.reduce((sum, part) => sum + part.span, 0)).toBe(24);
  });
  it('手机按分类纵向展示且大分类只露出六项，保留进入分类的位置', () => {
    const layout = planMonitorLayout(categories([89, 4]), 370, 540, 'auto', true);
    expect(layout.narrow).toBe(true);
    expect(layout.bands.map(b => b.parts[0].visible)).toEqual([6, 4]);
    expect(layout.bands.every(b => b.level.key === 'L2')).toBe(true);
  });
  it('空列表及大量分类有有限可用的布局结果', () => {
    expect(planMonitorLayout([], 900, 500).bands).toEqual([]);
    const layout = planMonitorLayout(categories(Array.from({ length: 50 }, () => 2)), 900, 600);
    expect(layout.bands.flatMap(b => b.parts).flatMap(part => part.indices).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(Number.isFinite(layout.height)).toBe(true);
  });
});

describe('截断和健康矩阵保留真实状态语义', () => {
  it('初次截断给后部异常和待确认留位，但轮询不把已有槽位重新排列', () => {
    const model = buildWorkspaceModel([target('a'), target('b'), target('bad', { status: 'down', lastSample: { t: now, up: false, ms: 10 } }), target('c')], now);
    const first = visibleWorkspaceServices(model.services, 2);
    expect(first.map(s => s.id)).toEqual(['a', 'bad']);
    const updated = buildWorkspaceModel([target('a'), target('b', { status: 'down', lastSample: { t: now, up: false, ms: 10 } }), target('bad'), target('c')], now);
    expect(visibleWorkspaceServices(updated.services, 2, first.map(s => s.id)).map(s => s.id)).toEqual(['a', 'bad']);
    expect(visibleWorkspaceServices(updated.services, 3, first.map(s => s.id)).map(s => s.id)).toEqual(['a', 'bad', 'b']);
  });
  it('没有区域来源不会从名称猜城市，全部无观测不能写全部满足预期', () => {
    const model = buildWorkspaceModel([target('上海', { lastSample: null, availability24h: null })], now), category = model.categories[0];
    expect(model.services[0].region).toBe('未标注区域');
    const cell = workspaceHealthCell(category, '未标注区域');
    expect(cell.state).toBe('none'); expect(cell.title).toContain('1 无观测'); expect(cell.title).not.toContain('全部满足预期');
    expect(workspaceHealthCell(category, '上海').state).toBe('empty');
  });
  it('同一区域正常与无观测混合时保留覆盖缺口，异常格定位真实异常ID', () => {
    const identity = { observer: { id: 'observer', name: '观察者', environment: 'test', location: '北京' }, subject: { id: 'subject', name: '目标', environment: 'production', location: '上海' } };
    const model = buildWorkspaceModel([target('up', { alarmIdentity: identity }), target('none', { alarmIdentity: identity, lastSample: null }), target('failed', { alarmIdentity: identity, status: 'down', lastSample: { t: now, up: false, ms: 10 } })], now);
    expect(workspaceHealthCell({ ...model.categories[0], services: model.services.slice(0, 2) }, '上海').state).toBe('none');
    const cell = workspaceHealthCell(model.categories[0], '上海'); expect(cell.state).toBe('bad'); expect(cell.serviceId).toBe('failed'); expect(cell.counts.none).toBe(1);
  });
});
