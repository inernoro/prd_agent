// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { ReleaseApplicationDialog } from './ReleaseWorkflowDetail';
import type { ProductInitiation } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => Object.fromEntries(['listInitiations', 'listProductMembers', 'parseProductVersionMessage'].map((name) => [name, vi.fn()])));
const directory = vi.hoisted(() => vi.fn());
vi.mock('@/services/real/productAgent', async (original) => ({ ...await original<typeof import('@/services/real/productAgent')>(), ...api }));
vi.mock('@/services', () => ({ searchDirectoryUsers: directory }));
vi.mock('@/services/real/directory', () => ({ searchDirectoryUsers: directory }));
vi.mock('@/services/real/teams', () => ({ getUserCards: async () => ({ success: true, data: { items: [
  { userId: 'me', displayName: '陈雅珊' }, { userId: 'lin', displayName: '吴林坤' }, { userId: 'shi', displayName: '欧石玲' },
] } }) }));
vi.mock('./DynamicForm', async (original) => ({ ...await original<typeof import('./DynamicForm')>(), useEffectiveWorkflow: () => ({ workflow: null }) }));
vi.mock('./VersionCopyActions', () => ({ VersionCopyActions: () => null }));

const notice = '【版本上线】\n项目类别：非定制\n版本类别：小版本\n需求来源：内部\n产品方案名称：米多星球T3.14.1(IMP配套方案)AI文档1-3稿\n方案地址：https://miduo1031.yuque.com/rsaesz/oqbs8t/aeoyfh53233d5ssu\n项目组成员：林坤、石玲\n计划上线时间：2026.10.26';
const source: ProductInitiation = { id: 'imp-plan', productId: 'platform', tCode: 'T3.14.1', planName: '米多总平台（IMP配套方案）', planUrl: 'https://miduo1031.yuque.com/rsaesz/oqbs8t/aeoyfh53233d5ssu', demandSource: '内部', status: 'approved', developmentStatus: '待开发', projectType: 'standard', versionType: 'minor', createdBy: 'me', sourceType: 'system', createdAt: '', updatedAt: '', requirementIds: [] };
const products = [{ id: 'platform', name: '米多总平台', productNo: 'platform' }];
const people = [{ userId: 'lin', username: 'lin', displayName: '吴林坤' }, { userId: 'shi', username: 'shi', displayName: '欧石玲' }];
let root: Root;
let host: HTMLDivElement;
const input = (placeholder: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
async function settle(ms = 30) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function paste() {
  const area = document.querySelector<HTMLTextAreaElement>('#version-message-formal')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, notice);
    area.dispatchEvent(new Event('paste', { bubbles: true }));
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(650);
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { userId: 'me', username: 'recorder', displayName: '陈雅珊', role: 'PM' }, permissions: ['product-agent.use'], isRoot: false });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.listInitiations.mockResolvedValue({ success: true, data: { items: [source] } });
  api.listProductMembers.mockResolvedValue({ success: true, data: { members: [] } });
  // The recorder is deliberately absent from directory pages, including the first 200 users.
  directory.mockImplementation(async (query: string) => ({ success: true, data: { items: query ? people.filter((person) => person.displayName.includes(query)) : people } }));
  api.parseProductVersionMessage.mockResolvedValue({ success: true, data: { result: {
    planName: source.planName, tCode: source.tCode, matchedApplicationId: 'platform', matchedInitiationId: source.id,
    candidateInitiationIds: [source.id], initiationCandidates: [source], projectType: 'standard', versionType: 'minor', demandSource: '内部',
    planUrl: source.planUrl, projectMemberNames: ['林坤', '石玲'], plannedReleaseAt: '2026-10-26T00:00:00',
    matchedFields: ['projectType', 'versionType', 'demandSource', 'planName', 'planUrl', 'projectMemberNames', 'plannedReleaseAt', 'tCode'],
  } } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useAuthStore.setState(useAuthStore.getInitialState(), true); });

describe('完整正式申领弹窗的原文回填', () => {
  it('真实人员和方案选择器显示默认记录人，回填T及应用，支持改选负责人后再次粘贴', async () => {
    await act(async () => root.render(<MemoryRouter><ReleaseApplicationDialog productId="" applicationProducts={products} onClose={() => {}} /></MemoryRouter>));
    const owner = input('搜索并选择产品负责人');
    expect(owner.value).toBe('陈雅珊');
    await paste();
    expect(api.parseProductVersionMessage).toHaveBeenCalledWith('formal', notice);
    expect(input('搜索方案名称或 T 号').value).toContain('T3.14.1');
    expect(input('搜索方案名称或 T 号').title).toBe(`T3.14.1 · 米多总平台 · ${source.planName}`);
    expect(document.body.textContent).toContain('已匹配立项 T3.14.1');
    expect([...document.querySelectorAll('[role="status"]')].some((item) => item.textContent === '米多总平台')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-10-26');
    expect(document.body.textContent).toContain('企微成员已匹配 2/2 人');
    expect(document.body.textContent).not.toContain('请选择正确立项');
    expect(document.body.textContent).toContain('已识别 8 项，请核对回填内容。');
    await act(async () => { owner.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(owner, '石玲'); owner.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(240);
    const candidate = [...document.querySelectorAll('div.cursor-pointer')].find((item) => item.textContent?.includes('欧石玲')) as HTMLElement;
    expect(candidate.closest('[role="dialog"]')).not.toBeNull();
    await act(async () => { candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); candidate.click(); });
    expect(owner.value).toBe('欧石玲');
    await paste();
    expect(api.parseProductVersionMessage).toHaveBeenCalledTimes(2);
    expect(owner.value).toBe('欧石玲');
    expect(input('搜索方案名称或 T 号').title).toBe(`T3.14.1 · 米多总平台 · ${source.planName}`);
    expect(document.body.textContent).toContain('已匹配立项 T3.14.1');
  });
});
