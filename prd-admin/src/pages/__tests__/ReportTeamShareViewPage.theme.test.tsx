// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportTeamShareViewPage from '../ReportTeamShareViewPage';
import { useMobileThemeStore } from '@/stores/mobileThemeStore';

vi.mock('@/services', () => ({ viewTeamWeekShare: vi.fn(async () => ({ success: true, data: {
  team: { id: 'theme-team', name: '独立主题团队' }, weekYear: 2026, weekNumber: 46,
  periodStart: '2026-11-09', periodEnd: '2026-11-15', stats: { totalMembers: 0, submittedCount: 0, pendingCount: 0 },
  items: [], summary: null, shareInfo: { createdBy: 'author', createdByName: '作者', createdAt: '2026-11-13', isTeamMember: true },
}, error: null })) }));
vi.mock('@/components/ui/MermaidDiagram', () => ({ MermaidDiagram: () => null }));

function renderRoute() {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const element = <MemoryRouter initialEntries={['/s/report-team/theme-fixture']}><Routes><Route path="/s/report-team/:token" element={<ReportTeamShareViewPage />} /><Route path="/" element={<div>独立首页</div>} /></Routes></MemoryRouter>;
  return { container, root, element };
}

afterEach(() => {
  useMobileThemeStore.setState({ mode: 'dark' });
  document.documentElement.removeAttribute('data-theme'); document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe('团队分享独立路由沿用全局主题', () => {
  it.each(['light', 'dark'] as const)('没有AppShell时应用%s偏好，返回后恢复原属性', async mode => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const previous = mode === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', previous);
    useMobileThemeStore.getState().setMode(mode);
    const { container, root, element } = renderRoute();
    try {
      await act(async () => root.render(element));
      expect(container.textContent).toContain('独立主题团队');
      expect(document.documentElement.getAttribute('data-theme') || 'dark').toBe(mode);
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="返回上一页"]')!.click());
      expect(container.textContent).toContain('独立首页');
      expect(document.documentElement.getAttribute('data-theme')).toBe(previous);
    } finally { await act(async () => root.unmount()); }
  });

  it('随系统偏好跟随深浅变化，退出路由后清理属性与订阅', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({ get matches() { return dark; }, addEventListener: (_event: string, callback: () => void) => listeners.add(callback), removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback) }));
    useMobileThemeStore.getState().setMode('system');
    const { container, root, element } = renderRoute();
    try {
      await act(async () => root.render(element));
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      for (const next of [true, false]) {
        await act(async () => { dark = next; listeners.forEach(listener => listener()); });
        expect(document.documentElement.getAttribute('data-theme') || 'dark').toBe(next ? 'dark' : 'light');
        expect(useMobileThemeStore.getState().mode).toBe('system');
      }
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="返回上一页"]')!.click());
      expect(container.textContent).toContain('独立首页');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
      expect(listeners.size).toBe(0);
    } finally { await act(async () => root.unmount()); }
  });
});
