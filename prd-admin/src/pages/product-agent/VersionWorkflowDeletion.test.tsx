// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionWorkflowTab } from './VersionWorkflowTab';
import type { ProductInitiation } from './types';
import detailSource from './InitiationWorkflowDetail.tsx?raw';
import releaseDetailSource from './ReleaseWorkflowDetail.tsx?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getWorkflowInitiations: vi.fn(), getWorkflowReleases: vi.fn() }));
vi.mock('@/services/real/productAgent', async (original) => ({
  ...await original<typeof import('@/services/real/productAgent')>(),
  getWorkflowInitiations: api.getWorkflowInitiations,
  getWorkflowReleases: api.getWorkflowReleases,
  listProductVersionReviewSources: async () => ({ success: true, data: { items: [], canUseAllReviews: false } }),
  getInitiationPlanDefaults: async () => ({ success: true, data: { meetingDraftCount: 1 } }),
  listVersionApplicationProducts: async () => ({ success: true, data: { items: [{ id: 'a', name: '应用甲' }, { id: 'b', name: '应用乙' }] } }),
}));
vi.mock('@/services/real/teams', () => ({ getUserCards: async () => ({ success: true, data: { items: [] } }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'me' }, permissions: ['product-agent.use'], isRoot: false }) }));
vi.mock('@/services/real/reviewAgent', async (original) => ({ ...await original<typeof import('@/services/real/reviewAgent')>(), getDimensions: async () => ({ success: true, data: { dimensions: [] } }) }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, content, actions }: { title: ReactNode; content: ReactNode; actions: ReactNode }) => <div role="dialog"><h3>{title}</h3>{content}{actions}</div> }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: () => null }));

let root: Root;
let host: HTMLDivElement;
function record(id: string, productId: string, tCode: string, canDelete: boolean): ProductInitiation {
  return { id, productId, tCode, canDelete, planName: `方案-${id}`, projectType: 'standard', versionType: 'minor',
    status: 'approved', developmentStatus: '待开发', requirementIds: [], createdBy: 'me', sourceType: 'system',
    createdAt: '2026-10-21', updatedAt: '2026-10-21' };
}
const buttons = () => [...host.querySelectorAll('button')].filter((button) => button.textContent === '删除');
async function mount(scope = '', isAdmin = false) {
  await act(async () => root.render(<MemoryRouter initialEntries={[`/product-agent?section=versions&versionTab=initiation${scope}`]}><VersionWorkflowTab isAdmin={isAdmin} /></MemoryRouter>));
}
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.getWorkflowInitiations.mockResolvedValue({ success: true, data: { items: [
    { record: record('latest', 'a', 'T6.19.0', true) }, { record: record('old', 'b', 'T6.18.13', false) },
  ], requirementNames: {} } });
  api.getWorkflowReleases.mockResolvedValue({ success: true, data: { items: [], requirementNames: {} } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

describe('末尾操作列只保留编辑与删除', () => {
  it('普通用户不显示调试清空入口，管理员在T/V各页签仅看到对应按钮', async () => {
    await mount();
    expect(host.textContent).not.toContain('调试清空');
    await act(async () => root.unmount()); root = createRoot(host);
    await mount('', true);
    expect(host.textContent).toContain('调试清空T记录');
    expect(host.textContent).not.toContain('调试清空V记录');
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === '正式版本')?.click());
    expect(host.textContent).toContain('调试清空V记录');
    expect(host.textContent).not.toContain('调试清空T记录');
  });
  it('操作列仅有编辑及有资格的删除，始终位于最末尾', async () => {
    await mount();
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].closest('tr')?.textContent).toContain('T6.19.0');
    expect(buttons()[0].closest('td')).toBe(buttons()[0].closest('tr')?.lastElementChild);
    expect([...host.querySelectorAll('tbody tr')].map((row) => [...row.lastElementChild!.querySelectorAll('button')].map((button) => button.textContent))).toEqual([['编辑', '删除'], ['编辑']]);
    expect(host.querySelector('thead tr')?.lastElementChild?.textContent).toBe('操作');
    expect([...host.querySelectorAll('button')].filter((button) => ['作废', '会议结果', '继续申领', '修改资料', '历史详情', '修改并重新评审'].includes(button.textContent ?? ''))).toHaveLength(0);
  });
  it('筛选到旧记录所属产品时不把它当成最新记录', async () => {
    await mount('&productId=b');
    expect(host.textContent).toContain('T6.18.13');
    expect(host.textContent).not.toContain('T6.19.0');
    expect(buttons()).toHaveLength(0);
  });
  it('最新记录已有下游关联时所有行均无删除入口', async () => {
    api.getWorkflowInitiations.mockResolvedValue({ success: true, data: { items: [
      { record: record('latest', 'a', 'T6.19.0', false) }, { record: record('old', 'b', 'T6.18.13', false) },
    ], requirementNames: {} } });
    await mount();
    expect(buttons()).toHaveLength(0);
    expect([...host.querySelectorAll('tbody tr')].flatMap((row) => [...row.lastElementChild!.querySelectorAll('button')].map((button) => button.textContent))).toEqual(['编辑', '编辑']);
  });
  it('详情也使用后端资格，不凭有无 T 号自行开放删除', () => {
    expect(detailSource).toContain('canDelete={initiation.canDelete}');
  });
  it('正式版本移除作废，只读资料保持原范围，删除仍由后端资格控制', async () => {
    const release = (id: string, productId: string, canDelete: boolean) => ({ id, productId, vCode: id === 'v-latest' ? 'V1.2.4' : 'V1.2.3', canDelete, createdBy: 'me', planName: id, status: 'released', versionType: 'minor', projectType: 'standard', teamMemberIds: [], requirementIds: [], openBrandScope: '', createdAt: '2026-10-27', updatedAt: '2026-10-27' });
    api.getWorkflowReleases.mockResolvedValue({ success: true, data: { items: [{ record: release('v-latest', 'a', true) }, { record: release('v-old', 'b', false) }], requirementNames: {} } });
    await act(async () => root.render(<MemoryRouter initialEntries={['/product-agent?section=versions&versionTab=release']}><VersionWorkflowTab /></MemoryRouter>));
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].closest('tr')?.textContent).toContain('V1.2.4');
    expect(buttons()[0].closest('td')).toBe(buttons()[0].closest('tr')?.lastElementChild);
    expect([...host.querySelectorAll('tbody tr')].map((row) => [...row.lastElementChild!.querySelectorAll('button')].map((button) => button.textContent))).toEqual([['删除'], []]);
    expect(host.querySelector('thead tr')?.lastElementChild?.textContent).toBe('操作');
    expect(releaseDetailSource).toContain('canDelete={release.canDelete}');
  });
  it('点击已发号记录编辑打开原编辑弹窗，不执行删除或进入行详情', async () => {
    await mount();
    await act(async () => [...host.querySelectorAll('tbody tr')][0].lastElementChild!.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('[role=dialog] h3')?.textContent).toBe('修改内部版本资料');
  });
  it('待处理立项只显示统一编辑入口，仍可进入原续办表单', async () => {
    api.getWorkflowInitiations.mockResolvedValue({ success: true, data: { items: [{ record: { ...record('draft', 'a', '', false), status: 'review_failed' } }], requirementNames: {} } });
    await mount();
    expect([...host.querySelector('tbody tr')!.lastElementChild!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['编辑']);
    await act(async () => host.querySelector('tbody tr')!.lastElementChild!.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('[role=dialog] h3')?.textContent).toBe('重新发起立项');
  });
});
