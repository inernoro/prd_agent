// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReportMainView } from './ReportMainView';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useNotificationActions } from '@/components/notifications/useNotificationActions';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./ReportEditor', () => ({ ReportEditor: ({ weekYear, weekNumber }: { weekYear: number; weekNumber: number }) => <output>编辑周期:{weekYear}/{weekNumber}</output> }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
let root: Root;
let host: HTMLDivElement;
const target = '/report-agent?tab=report&weekYear=2026&weekNumber=46';
function Journey() {
  const navigate = useNavigate();
  const { openNotification } = useNotificationActions({ refresh: async () => {} });
  return <><button onClick={() => void openNotification({ id: 'same-notice', title: '周报提醒', source: 'report-agent', level: 'info', status: 'open', createdAt: '', updatedAt: '', actionUrl: target })}>重开通知</button><button onClick={() => navigate(target + '&view=list')}>内部地址变化</button><ReportMainView /></>;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  useReportAgentStore.setState({ reports: [], teams: [{ id: 'team', name: '团队', leaderUserId: 'owner', createdAt: '', updatedAt: '' }], templates: [{ id: 'template', name: '模板', sections: [], isDefault: true, createdBy: 'owner', createdAt: '', updatedAt: '' }], showReportEditor: false, loadReports: async () => {} });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function mount(url = target) { await act(async () => root.render(<MemoryRouter initialEntries={[url]}><Journey /></MemoryRouter>)); }
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!.click()); }
it('手动改周次后重开同一通知恢复目标周期，创建参数一致；内部导航不抢回手动选择', async () => {
  await mount();
  await click('上周'); expect(host.querySelector('select')?.value).toBe('2026-45');
  await click('内部地址变化'); expect(host.querySelector('select')?.value).toBe('2026-45');
  await click('重开通知'); expect(host.querySelector('select')?.value).toBe('2026-46');
  await click('全部'); await click('重开通知');
  await click('写周报'); expect(host.querySelector('output')?.textContent).toBe('编辑周期:2026/46');
});
it('没有该周报告的旧周期仍显示真实选项，创建参数与可见选择一致，不伪造报告', async () => {
  await mount('/report-agent?tab=report&weekYear=2026&weekNumber=2');
  const select = host.querySelector('select')!;
  expect(select.value).toBe('2026-02');
  expect([...select.options].some(o => o.value === '2026-02')).toBe(true);
  expect(useReportAgentStore.getState().reports).toHaveLength(0);
  await click('写周报'); expect(host.querySelector('output')?.textContent).toBe('编辑周期:2026/2');
});
