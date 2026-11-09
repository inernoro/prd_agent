import { describe, expect, it } from 'vitest';
import { buildWorkspaceModel, workspaceMinimapRows } from '../../web/src/lib/monitorWorkspace.js';
import type { UptimeSummary, UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';

const now = Date.parse('2026-11-08T12:00:00Z');
function target(id: string, over: Partial<UptimeTargetSummary> = {}): UptimeTargetSummary {
  return {
    id, name: id, source: 'custom', projectId: 'cds', projectName: 'CDS', branchId: '', profileId: '', probeKind: 'http',
    status: 'up', measured: true, lastSample: { t: now, up: true, ms: 12 }, availability24h: 1, availability7d: 1,
    avgLatencyMs24h: 12, sampleCount24h: 1, buckets: [], openIncidentSince: null, statusSince: now,
    incidentCount: 0, probeDescription: '', intervalSeconds: 60, timeoutMs: 5000, environment: 'production',
    environmentLabel: '生产', observeMode: 'active', ...over,
  };
}

describe('真实监控工作区', () => {
  it('小地图按画布行高的比例填充自身，不把冻结的像素高度带进小地图', () => {
    expect(workspaceMinimapRows('400px 200px')).toBe('400fr 200fr');
    expect(workspaceMinimapRows('400px 200px auto')).toBe('400fr 200fr 300fr');
    expect(workspaceMinimapRows('2fr 1fr')).toBe('2fr 1fr');
  });
  it('当前正常和历史低通过率分别展示，不把历史失败判为当前故障', () => {
    const model = buildWorkspaceModel([target('index', { availability24h: 0.0769 })], now);
    expect(model.services[0].state).toBe('ok');
    expect(model.services[0].rate).toBe('7.69%');
  });
  it('无样本、暂停、已故障和停止采集互不冒充正常', () => {
    const rows = [target('empty', { lastSample: null, availability24h: null }), target('paused', { status: 'paused' }), target('failed', { status: 'down', lastSample: { t: now, up: false, ms: 1, err: '服务不可达' } }), target('ok')];
    const model = buildWorkspaceModel(rows, now, { enabled: false } as UptimeSummary);
    expect(model.services.map(s => s.state)).toEqual(['none', 'none', 'bad', 'warn']);
    expect(model.services[0].rate).toBe('—');
    expect(model.services[0].fresh).toBe(true);
    expect(model.services[1].fresh).toBe(false);
    expect(model.counts).toEqual({ ok: 0, bad: 1, warn: 1, none: 2 });
  });
  it('项目名称不会被基础设施空名称覆盖，轮询状态改变保留位置和ID', () => {
    const rows = [target('a'), target('b', { projectName: undefined }), target('c', { projectId: 'other', projectName: '其他' })];
    const before = buildWorkspaceModel(rows, now);
    const after = buildWorkspaceModel(rows.map(t => ({ ...t, status: 'down' })), now);
    expect(before.categories.map(c => c.name)).toEqual(['CDS', '其他']);
    expect(after.categories.map(c => c.id)).toEqual(before.categories.map(c => c.id));
    expect(after.services.map(s => s.id)).toEqual(before.services.map(s => s.id));
  });
  it('同项目追加个人服务后仍能按服务来源筛选，不继承公共分类标签', () => {
    const model = buildWorkspaceModel([target('monitor@self-health'), target('mine', { addedBy: { by: 'operator', kind: 'human', origin: 'manual' } })], now);
    expect(model.categories[0].custom).toBe(false);
    expect(model.services.map(s => s.custom)).toEqual([false, true]);
  });
});
