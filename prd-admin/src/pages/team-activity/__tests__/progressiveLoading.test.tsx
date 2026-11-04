// @vitest-environment jsdom
import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, fail, type ApiResponse } from '@/types/api';
import type { TeamActivityRequestOptions } from '@/services/contracts/teamActivity';
import { useActivityResource } from '../useActivityResource';
import { TimeRangePicker } from '../TimeRangePicker';
import { InsightsPanel } from '../InsightsPanel';
import { ActivitySectionState } from '../ActivitySectionState';

const services = vi.hoisted(() => ({ trend: vi.fn(), map: vi.fn(), insights: vi.fn() }));
vi.mock('@/services', () => ({ getTeamActivityExperienceTrend: services.trend,
  getTeamActivityExperienceMap: services.map, getTeamActivityInsights: services.insights }));
vi.mock('@/lib/useSseStream', () => ({ useSseStream: () => ({ typing: '', running: false, start: vi.fn(), stop: vi.fn() }) }));
vi.mock('@/components/ui/MarkdownContent', () => ({ MarkdownContent: () => null }));
vi.mock('../ExperienceMap', () => ({ ExperienceMap: ({ data }: { data: unknown }) => <div data-testid="map">{data ? 'rendered map' : 'no map'}</div> }));
vi.mock('../ExperienceBoard', () => ({ ExperienceBoard: () => <div data-testid="board">voice board</div> }));
vi.mock('../ExperienceRibbon', () => ({ ExperienceRibbon: () => <div>ribbon</div> }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.values(services).forEach((mock) => mock.mockReset());
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

function Section({ name, load }: { name: string; load: (options: TeamActivityRequestOptions) => Promise<ApiResponse<string>> }) {
  const result = useActivityResource(load);
  return <div data-section={name}>{result.loading ? 'loading' : result.error ?? result.data}<button onClick={result.reload}>retry</button></div>;
}

describe('VOC progressive resources', () => {
  it('the real panel mounts its charts before insights resolves and keeps a single desktop board', async () => {
    const insight = deferred<ApiResponse<never>>();
    services.insights.mockReturnValue(insight.promise);
    services.map.mockResolvedValue(ok({ groups: [], totalRequests: 0 }));
    services.trend.mockResolvedValue(ok({ buckets: [
      { bucketStart: '2026-11-04T00:00:00Z', total: 10, errors: 1, slow: 0 },
      { bucketStart: '2026-11-04T01:00:00Z', total: 20, errors: 2, slow: 1 },
    ], bucketUnit: 'hour' }));
    window.innerWidth = 1440;
    window.dispatchEvent(new Event('resize'));
    await act(async () => root.render(<InsightsPanel from="2026-11-04T00:00:00Z" />));
    expect(host.querySelector('[data-testid="map"]')?.textContent).toBe('rendered map');
    expect(host.querySelectorAll('[data-testid="board"]')).toHaveLength(1);
    expect(services.trend).toHaveBeenCalledTimes(1);
    expect(services.insights).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('行为洞察');
    // The chart may move into a portal or between responsive layouts; its request stays in the panel.
    await act(async () => (host.querySelector('button[title="全屏查看"]') as HTMLButtonElement).click());
    expect(document.body.textContent).toContain('趋势爆点曲线');
    await act(async () => (document.querySelector('button[title="退出全屏"]') as HTMLButtonElement).click());
    await act(async () => { window.innerWidth = 390; window.dispatchEvent(new Event('resize')); });
    const trendButton = [...host.querySelectorAll('button')].find((button) => button.textContent === '趋势爆点');
    await act(async () => trendButton?.click());
    expect(services.trend).toHaveBeenCalledTimes(1);
  });

  it('shows elapsed progress and changes timeout into a recoverable section error', async () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      await act(async () => root.render(<ActivitySectionState title="行为洞察" loading onRetry={retry} />));
      await act(async () => vi.advanceTimersByTime(22000));
      expect(host.textContent).toContain('已等待 22 秒');
      expect(host.textContent).toContain('其他模块可继续查看');
      await act(async () => root.render(<ActivitySectionState title="行为洞察" loading={false} error="查询超时" onRetry={retry} />));
      expect(host.textContent).toContain('查询超时');
      await act(async () => host.querySelector('button')?.click());
      expect(retry).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('shows the map while insights is still pending and isolates its failure', async () => {
    const insight = deferred<ApiResponse<string>>();
    const loadInsights = vi.fn(() => insight.promise);
    const loadMap = vi.fn(async () => ok('map visible'));
    await act(async () => { root.render(<><Section name="map" load={loadMap} /><Section name="insights" load={loadInsights} /></>); });
    expect(host.querySelector('[data-section="map"]')?.textContent).toContain('map visible');
    expect(host.querySelector('[data-section="insights"]')?.textContent).toContain('loading');
    await act(async () => { insight.resolve(fail('VOC_QUERY_TIMEOUT', 'query timed out')); });
    expect(host.textContent).toContain('map visible');
    expect(host.textContent).toContain('query timed out');
  });

  it('cancels old windows and rejects their late results, then retries only the current section', async () => {
    const old = deferred<ApiResponse<string>>();
    const loadOld = vi.fn((_options: TeamActivityRequestOptions) => old.promise);
    const loadNew = vi.fn(async (_options: TeamActivityRequestOptions) => ok('new window'));
    await act(async () => root.render(<Section name="map" load={loadOld} />));
    await act(async () => root.render(<Section name="map" load={loadNew} />));
    expect(loadOld.mock.calls[0][0].signal?.aborted).toBe(true);
    await act(async () => old.resolve(ok('stale window')));
    expect(host.textContent).toContain('new window');
    expect(host.textContent).not.toContain('stale window');
    await act(async () => host.querySelector('button')?.click());
    expect(loadNew).toHaveBeenCalledTimes(2);
    expect(loadOld).toHaveBeenCalledTimes(1);
  });

  it('requests density on demand and lets an unavailable preview be retried', async () => {
    services.trend.mockResolvedValueOnce(fail('TIMEOUT', '查询超时')).mockResolvedValueOnce(ok({ buckets: [], bucketUnit: 'day' }));
    function Picker() {
      const onChange = useCallback(() => {}, []);
      return <TimeRangePicker value={{ kind: 'preset', preset: 'today' }} onChange={onChange} />;
    }
    await act(async () => root.render(<Picker />));
    expect(services.trend).not.toHaveBeenCalled();
    await act(async () => (host.querySelector('[title="活动密度刷选条：拖动两个把手刷选任意窗口"]') as HTMLButtonElement).click());
    expect(services.trend).toHaveBeenCalledTimes(1);
    expect(services.trend.mock.calls[0][1].timeoutMs).toBe(180000);
    expect(document.body.textContent).toContain('活动密度预览暂不可用');
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === '重试密度预览');
    await act(async () => retry?.click());
    expect(services.trend).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('活动密度预览暂不可用');
  });
});
