// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewAgentPage } from './ReviewAgentPage';
import { ReviewAgentPage as StandaloneReviewPage } from '@/pages/review-agent/ReviewAgentPage';
import { PRODUCT_REVIEW_NAVIGATION as nav } from './reviewNavigation';
import overview from '../OverviewShell.tsx?raw';
import routes from '@/app/navRegistry.tsx?raw';

vi.mock('@/services', () => ({
  getMyReviewSubmissions: vi.fn(async () => ({ success: true, data: { total: 1, items: [
    { id: 'existing-review', title: '已有方案', fileName: '已有方案.md', status: 'Done', isPassed: true, createdAt: '2026-10-20T00:00:00Z' },
  ] } })),
}));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: { permissions: string[] }) => unknown) => select({ permissions: ['review-agent.use', 'review-agent.view-all', 'review-agent.manage'] }) }));
vi.mock('@/components/daily-tips/TipsEntryButton', () => ({ TipsEntryButton: () => null }));
vi.mock('@/pages/review-agent/ReviewAgentDimensionsModal', () => ({ ReviewAgentDimensionsModal: () => null }));
vi.mock('@/pages/review-agent/ReviewAgentWebhookModal', () => ({ ReviewAgentWebhookModal: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: () => <span>加载中</span> }));

let root: Root | undefined;
let host: HTMLDivElement;
function Location() { const loc = useLocation(); return <output>{loc.pathname}{loc.search}</output>; }
async function mount(page: ReactNode, initial = '/product-agent?section=review') {
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<MemoryRouter initialEntries={[initial]}><Routes><Route path="*" element={page} /></Routes><Location /></MemoryRouter>); });
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('产品管理评审适配与独立智能体隔离', () => {
  it('产品页真实渲染通栏布局，已有方案点击仍停留产品路径', async () => {
    await mount(<ReviewAgentPage />);
    expect(host.querySelector('h1')?.textContent).toBe('方案评审');
    expect(host.querySelector('.max-w-3xl')).toBeNull();
    expect(host.querySelector('h1')?.closest('.h-full')).not.toBeNull();
    const row = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('已有方案'));
    expect(row).toBeDefined();
    await act(async () => row?.click());
    expect(host.querySelector('output')?.textContent).toBe('/product-agent/review/submissions/existing-review');
  });

  it.each([['提交方案', '/product-agent/review/submit'], ['全部提交', '/product-agent/review/all']])('点击%s不跳到独立智能体', async (text, destination) => {
    await mount(<ReviewAgentPage />);
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(host.querySelector('output')?.textContent).toBe(destination);
  });

  it('同一账号进入独立智能体时仍渲染原来的标题、窄版和独立导航', async () => {
    await mount(<StandaloneReviewPage />, '/review-agent');
    expect(host.querySelector('h1')?.textContent).toBe('产品评审智能体');
    expect(host.querySelector('.max-w-3xl')).not.toBeNull();
    const submit = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '提交方案');
    await act(async () => submit?.click());
    expect(host.querySelector('output')?.textContent).toBe('/review-agent/submit');
  });

  it('首页及五种产品内页装配产品专用视图，不再挂载独立页面', () => {
    expect(overview).toContain("from './review/ReviewAgentPage'");
    for (const name of ['ReviewAgentSubmitPage', 'ReviewAgentResultPage', 'ReviewAgentAllPage', 'ReviewAssessmentListPage', 'ReviewAssessmentDetailPage']) {
      expect(routes).toContain(`import('@/pages/product-agent/review/${name}')`);
    }
    expect(nav.reviewHome).toBe('/product-agent?section=review');
    expect(nav.requirementHome).toBe('/product-agent?section=requirements');
    expect(nav.assessment('a/b')).toBe('/product-agent/requirements/assessments/a%2Fb');
    expect(nav.submission('a/b')).toBe('/product-agent/review/submissions/a%2Fb');
  });
});
