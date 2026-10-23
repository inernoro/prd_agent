// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionWorkflowTab } from './VersionWorkflowTab';
import type { ProductInitiation, ProductRelease } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getWorkflowInitiations: vi.fn(), getWorkflowReleases: vi.fn() }));
vi.mock('@/services/real/productAgent', async (original) => ({
  ...await original<typeof import('@/services/real/productAgent')>(),
  ...api,
  listVersionApplicationProducts: async () => ({ success: true, data: { items: [] } }),
}));
vi.mock('@/services/real/teams', () => ({ getUserCards: async () => ({ success: true, data: { items: [] } }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'me' }, permissions: ['product-agent.use'], isRoot: false }) }));

let root: Root;
let host: HTMLDivElement;
function initiation(id: string, tCode?: string): ProductInitiation {
  return { id, productId: 'app', tCode, planName: id, projectType: 'standard', versionType: 'minor',
    status: tCode?.trim() ? 'approved' : 'draft', developmentStatus: '待开发', requirementIds: [],
    createdBy: 'me', sourceType: 'system', createdAt: '2026-10-23', updatedAt: '2026-10-23' };
}
function release(id: string, vCode: string): ProductRelease {
  return { ...initiation(id, 'T1.0.0'), vCode, status: 'released', isTemporaryOptimization: false, openBrandScope: '', teamMemberIds: [] };
}
const headers = () => [...host.querySelectorAll('th')].map((cell) => cell.textContent);
async function mount(tab = 'initiation') {
  await act(async () => root.render(<MemoryRouter initialEntries={[`/product-agent?section=versions&versionTab=${tab}`]}><VersionWorkflowTab /></MemoryRouter>));
}
async function click(label: string) {
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === label)?.click());
}
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.getWorkflowInitiations.mockResolvedValue({ success: true, data: { items: [
    { record: initiation('已发号甲', 'T1.0.0') }, { record: initiation('已发号乙', 'T1.0.1') },
    { record: initiation('空号草稿') }, { record: initiation('空白号草稿', '  ') },
  ] } });
  api.getWorkflowReleases.mockResolvedValue({ success: true, data: { items: [
    { record: release('正式甲', 'V1.0.0') }, { record: release('正式空号', '') },
  ], requirementNames: {} } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

describe('版本号表头数量', () => {
  it('内部只计非空T号，正式只给V号列加数量，切换页签互不混用', async () => {
    await mount();
    expect(headers()).toContain('立项号（2）');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(4);
    await click('正式版本');
    expect(headers()).toContain('正式版本号（1）');
    expect(headers()).toContain('内部版本号');
    expect(headers().some((header) => header?.startsWith('内部版本号（'))).toBe(false);
    await click('内部版本');
    expect(headers()).toContain('立项号（2）');
  });

  it('搜索后只统计当前结果，空号匹配结果仍显示零，清空搜索恢复数量', async () => {
    await mount();
    const input = host.querySelector<HTMLInputElement>('input[placeholder="搜索版本号、方案名称等"]')!;
    const search = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await search('已发号甲'); expect(headers()).toContain('立项号（1）');
    await search('草稿'); expect(headers()).toContain('立项号（0）');
    await search('不存在'); expect(headers()).toContain('立项号（0）');
    await search(''); expect(headers()).toContain('立项号（2）');
  });

  it('重读数据后使用新记录数量，不保留旧数量', async () => {
    await mount();
    api.getWorkflowInitiations.mockResolvedValue({ success: true, data: { items: [{ record: initiation('重新导入', 'T2.0.0') }] } });
    await click('正式版本'); await click('内部版本');
    expect(headers()).toContain('立项号（1）');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it.each(['initiation', 'release'])('%s无数据时表头数量为零', async (tab) => {
    api.getWorkflowInitiations.mockResolvedValue({ success: true, data: { items: [] } });
    api.getWorkflowReleases.mockResolvedValue({ success: true, data: { items: [], requirementNames: {} } });
    await mount(tab);
    expect(headers()).toContain(tab === 'initiation' ? '立项号（0）' : '正式版本号（0）');
  });
});
