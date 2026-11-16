// @vitest-environment jsdom
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ok } from '@/types/api';

const calls = vi.hoisted(() => ({
  getExecutiveOverview: vi.fn(),
  getExecutiveTrends: vi.fn(),
  getExecutiveTeam: vi.fn(),
  getExecutiveAgents: vi.fn(),
  getExecutiveModels: vi.fn(),
  getTeamInsights: vi.fn(),
}));
vi.mock('@/services', () => calls);
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isMobile: false }),
  useIsMobile: () => false,
}));
vi.mock('@/components/charts/EChart', () => ({ EChart: () => null }));
vi.mock('@/components/reactbits/CountUp', () => ({ default: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
vi.mock('@/pages/executive/TeamInsightsWorkspace', () => ({
  default: ({ data, loading }: { data: unknown; loading: boolean }) => (
    <div>{loading ? '等待统计' : data ? '团队结果' : '暂无结果'}</div>
  ),
}));
import ExecutiveDashboardPage from '../ExecutiveDashboardPage';

it('团队洞察只请求自己的接口，结果返回立即展示', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // 其余统计即使永远不返回，也不影响首屏。
  for (const call of Object.values(calls))
    call.mockImplementation(() => new Promise(() => {}));
  calls.getTeamInsights.mockResolvedValue(ok({ members: [] }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ExecutiveDashboardPage />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toContain('团队结果');
    expect(calls.getTeamInsights).toHaveBeenCalledTimes(1);
    expect(calls.getTeamInsights).toHaveBeenCalledWith(0);
    for (const [name, call] of Object.entries(calls)) {
      if (name !== 'getTeamInsights') expect(call).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('URL时间窗口随返回恢复，非法窗口回退到全部时间', async () => {
  for (const window of ['7', 'invalid']) {
    for (const call of Object.values(calls))
      call.mockClear().mockImplementation(() => new Promise(() => {}));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter
            initialEntries={['/executive?tab=agents&days=' + window]}
          >
            <ExecutiveDashboardPage />
          </MemoryRouter>,
        ),
      );
      expect(calls.getExecutiveAgents).toHaveBeenCalledWith(
        window === '7' ? 7 : 0,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});
