import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from '../../web/node_modules/react-router-dom';
import { IncidentTimeline } from '../../web/src/pages/status/IncidentTimeline';
import { TargetDetail } from '../../web/src/pages/status/TargetDetail';
import { MonitorWorkspace } from '../../web/src/pages/status/MonitorWorkspace';
import type { UptimeIncidentView, UptimeSummary, UptimeTargetSummary } from '../../web/src/lib/monitorCenter';
beforeAll(() => vi.stubGlobal('window', { innerWidth: 1200, location: new URL('https://fixture.invalid/status'), matchMedia: () => ({ matches: false }) }));
afterAll(() => vi.unstubAllGlobals());
const now = Date.UTC(2026, 10, 13, 8);
const target: UptimeTargetSummary = { id: 'monitor@recovery-proof', name: '隔离服务', source: 'custom', projectId: 'fixture', projectName: '隔离项目', branchId: '', profileId: '', probeKind: 'http', status: 'up', measured: true,
  lastSample: { t: now, up: true, ms: 1 }, availability24h: 1, availability7d: 1, avgLatencyMs24h: 1, sampleCount24h: 1, buckets: [], openIncidentSince: null, statusSince: now,
  incidentCount: 1, probeDescription: '隔离检查', intervalSeconds: 60, timeoutMs: 1000, environment: 'test', environmentLabel: '测试', observeMode: 'active' };
const closed: UptimeIncidentView = { id: 'legacy-closed', targetId: target.id, targetName: target.name, source: 'custom', projectId: 'fixture', branchId: '', startedAt: now - 60_000, endedAt: now, durationMs: 60000, ongoing: false, cause: '曾经检查失败' };
const summary = { generatedAt: now, targets: [target], enabled: true } as unknown as UptimeSummary;
const noop = () => {};
const wrap = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(MemoryRouter, null, element));
const renderers = {
  timeline: (incident: UptimeIncidentView) => wrap(createElement(IncidentTimeline, { incidents: [incident], filter: 'all', onFilter: noop, onOpenTarget: noop })),
  target: (incident: UptimeIncidentView) => wrap(createElement(TargetDetail, { target, incidents: [incident], generatedAt: now, now, actions: { probeNow: async () => {}, toggleEnabled: async () => {}, edit: noop, remove: async () => {} }, busy: null, onBack: noop })),
  workspace: (incident: UptimeIncidentView) => wrap(createElement(MonitorWorkspace, { targets: [target], summary, incidents: [incident], now, onAdd: noop, onNotify: noop, onProbe: async () => {}, onManage: noop, onReload: noop })),
};
describe('通知入口相关三个视图共享恢复证据边界', () => {
  for (const [view, render] of Object.entries(renderers)) {
    it.each([undefined, { t: now, up: false, ms: 1 }, { t: now, up: true, noData: true, ms: 1 }])(`${view}：结束时间或无效采样不能显示恢复`, endedSample => {
      const html = render({ ...closed, endedSample });
      expect(html).not.toContain(view === 'workspace' ? '最近恢复' : '已恢复');
      if (view !== 'workspace') expect(html).toContain('恢复未确认');
    });
    it(`${view}：已有成功恢复采样才显示恢复`, () => {
      const html = render({ ...closed, endedSample: { t: now, up: true, ms: 1 } });
      expect(html).toContain(view === 'workspace' ? '最近恢复' : '已恢复');
    });
  }
});
