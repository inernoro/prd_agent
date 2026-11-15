// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TeamDashboard } from './TeamDashboard';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import type { ReportTeam } from '@/services/contracts/reportAgent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { readTeam } = vi.hoisted(() => ({ readTeam: vi.fn() }));
vi.mock('@/services', () => ({ getTeamReportsView: readTeam }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('./WeekNavRail', () => ({ WeekNavRail: ({ teamName }: { teamName?: string }) => <div>导航团队:{teamName}</div> }));
vi.mock('./ShareTeamWeekDialog', () => ({ ShareTeamWeekDialog: () => null }));
vi.mock('./MemberReportInlineView', () => ({ MemberReportInlineView: () => null }));
vi.mock('./TeamIssuesPanel', () => ({ TeamIssuesPanel: () => null }));
const managed: ReportTeam = { id: 'managed-a', name: '管理甲团队', leaderUserId: 'owner', myRole: 'leader', relationType: 'managed', createdAt: '', updatedAt: '' };
const joined: ReportTeam = { id: 'joined-b', name: '加入乙团队', leaderUserId: 'other-owner', myRole: 'member', relationType: 'joined', createdAt: '', updatedAt: '' };
let host: HTMLDivElement;
let root: Root;
function View() { const l = useLocation(); return <><output>{l.search}</output><TeamDashboard /></>; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  readTeam.mockResolvedValue({ success: true, data: { members: [], stats: { totalMembers: 0, overdueCount: 0, pendingCount: 0, submittedCount: 0 }, canManageMembers: false, canGenerateSummary: false } });
  useReportAgentStore.setState({ teams: [managed, joined], teamsLoaded: true, loadTeams: async () => {} });
  useAuthStore.setState({ user: { userId: 'owner', username: 'owner', displayName: '本人', role: 'PM' } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(query: string) { await act(async () => root.render(<MemoryRouter initialEntries={['/report-agent?' + query]}><View /></MemoryRouter>)); }
it.each(['', '&scope=managed', '&scope=joined'])('按目标团队真实关系进入加入视图，不替换成无关管理团队%s', async (scope) => {
  await mount('teamId=joined-b&weekYear=2026&weekNumber=46' + scope);
  expect(host.querySelector('output')?.textContent).toContain('teamId=joined-b');
  expect(host.textContent).toContain('加入乙团队');
  expect(readTeam.mock.calls.every(([q]) => q.teamId === 'joined-b')).toBe(true);
});
it('团队关系尚未加载时保留目标，加载后再校验，不提前清空入口', async () => {
  useReportAgentStore.setState({ teams: [], teamsLoaded: false });
  await mount('teamId=joined-b');
  expect(host.querySelector('output')?.textContent).toContain('teamId=joined-b');
  expect(readTeam).not.toHaveBeenCalled();
  await act(async () => useReportAgentStore.setState({ teams: [joined], teamsLoaded: true }));
  expect(host.querySelector('output')?.textContent).toContain('teamId=joined-b');
  expect(host.textContent).toContain('加入乙团队');
});
it('目标已不可访问时明确失败，不静默跳到另一个团队', async () => {
  await mount('teamId=unavailable-team');
  expect(host.querySelector('output')?.textContent).toContain('teamId=unavailable-team');
  expect(host.textContent).toContain('该团队不可用');
  expect(readTeam).not.toHaveBeenCalled();
});
