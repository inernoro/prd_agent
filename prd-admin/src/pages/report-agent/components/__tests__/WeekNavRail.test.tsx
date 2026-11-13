// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeekNavRail } from '../WeekNavRail';
import type { TeamDashboardMember } from '@/services/contracts/reportAgent';

const screen = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => screen.mobile }));
const member: TeamDashboardMember = { userId: 'author', userName: '报告作者', role: 'leader', reportId: 'report', reportStatus: 'submitted' };

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('团队周导航的成员阅读入口', () => {
  it.each([true, false])('手机=%s：选择成员后手机收起周树，仍可重新打开切换成员', async mobile => {
    screen.mobile = mobile;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const select = vi.fn();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<WeekNavRail selectedYear={2026} selectedWeek={46} selectedMemberUserId={null} currentWeekMembers={[member]} currentWeekLoading={false} hasTeam teamName="完整阅读团队" onSelectWeek={vi.fn()} onSelectMember={select} />));
      const buttons = () => Array.from(container.querySelectorAll('button'));
      const toggle = buttons().find(button => button.textContent?.includes('周列表'));
      const selectMember = () => buttons().find(button => button.textContent?.includes('报告作者'))!;
      if (mobile) {
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => toggle!.click());
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      } else expect(toggle).toBeUndefined();
      await act(async () => selectMember().click());
      expect(select).toHaveBeenCalledWith(member);
      if (mobile) {
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => toggle!.click());
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => selectMember().click());
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        expect(select).toHaveBeenCalledTimes(2);
      } else expect(selectMember()).toBeDefined();
    } finally { await act(async () => root.unmount()); }
  });
});
