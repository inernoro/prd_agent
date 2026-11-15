// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ReportAgentPage from './ReportAgentPage';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/services', () => ({ getMyDefaultTab: async () => ({ success: true, data: { tab: 'team' } }) }));
vi.mock('./components/ReportMainView', () => ({ ReportMainView: () => <div>个人周报目标</div> }));
vi.mock('./components/TeamDashboard', () => ({ TeamDashboard: () => <div>默认团队汇总</div> }));
vi.mock('./components/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('./components/DailyLogInline', () => ({ DailyLogInline: () => null }));
vi.mock('./monthly/MonthlyReportListView', () => ({ MonthlyReportListView: () => null }));
vi.mock('./components/ZoomControl', () => ({ ZoomControl: () => null, ZOOM_SCALE: { normal: 1 } }));
vi.mock('./components/ThemeControl', () => ({ ThemeControl: () => null }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  sessionStorage.setItem('report-agent:session-landed', '1');
  useReportAgentStore.setState({ activeTab: 'team', loading: false, teamsLoaded: true, error: undefined, teams: [{ id: 'existing-team', name: '本人管理的团队', leaderUserId: 'existing-memory-owner', myRole: 'leader', createdAt: '2026-01-01', updatedAt: '2026-01-01' }], showReportEditor: false, loadAll: async () => {} });
  useAuthStore.setState({ user: { userId: 'existing-memory-owner', username: 'owner', displayName: '本人', role: 'ADMIN' } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); sessionStorage.clear(); });
it('通知指定个人周报时，即使已有团队偏好与会话落地标记，也显示个人目标', async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={['/report-agent?tab=report&weekYear=2026&weekNumber=46']}><ReportAgentPage /></MemoryRouter>));
  expect(useReportAgentStore.getState().activeTab).toBe('report');
  expect(host.textContent).toContain('个人周报目标');
});
it('没有明确通知目标时保留已选择的团队tab，不强制替换用户选择', async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={['/report-agent']}><ReportAgentPage /></MemoryRouter>));
  expect(useReportAgentStore.getState().activeTab).toBe('team');
});
it('手动切到团队后，另一次相同URL的个人通知仍重新应用目标', async () => {
  function Journey() {
    const navigate = useNavigate();
    return <><button onClick={() => navigate('/report-agent?tab=report&weekYear=2026&weekNumber=46', { state: { notificationId: 'second-notice' } })}>另一个通知</button><ReportAgentPage /></>;
  }
  await act(async () => root.render(<MemoryRouter initialEntries={['/report-agent?tab=report&weekYear=2026&weekNumber=46']}><Journey /></MemoryRouter>));
  await act(async () => useReportAgentStore.getState().setActiveTab('team'));
  expect(host.textContent).toContain('默认团队汇总');
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '另一个通知')!.click());
  expect(host.textContent).toContain('个人周报目标');
  expect(useReportAgentStore.getState().activeTab).toBe('report');
});
