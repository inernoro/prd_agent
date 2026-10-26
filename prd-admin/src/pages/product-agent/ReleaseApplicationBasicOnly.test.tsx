// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseWorkflowDetail } from './ReleaseWorkflowDetail';
import type { ProductInitiation, ProductRelease } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => Object.fromEntries(['listInitiations', 'listProductMembers', 'listRequirements', 'listFeatures', 'listTracedDefects', 'getInheritReleaseManifest', 'getRelease', 'getInitiation', 'checkReleaseHistory', 'createRelease'].map((name) => [name, vi.fn()])));
vi.mock('@/services/real/productAgent', async (original) => ({ ...await original<typeof import('@/services/real/productAgent')>(), ...api }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'me', displayName: '申请人' }, permissions: ['product-agent.use'], isRoot: false }) }));
vi.mock('@/services/real/teams', () => ({ getUserCards: async () => ({ success: true, data: { items: [{ userId: 'me', displayName: '申请人' }] } }) }));
vi.mock('./DynamicForm', async (original) => ({ ...await original<typeof import('./DynamicForm')>(), useEffectiveWorkflow: () => ({ workflow: null }) }));
vi.mock('./useReleasePastedMembers', () => ({ useReleasePastedMembers: () => ({ matches: [], pendingCount: 0, identify: () => {}, choose: () => {} }) }));
vi.mock('./ProductVersionMessagePaste', () => ({ ProductVersionMessagePaste: () => null }));
vi.mock('./VersionCopyActions', () => ({ VersionCopyActions: () => null }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: () => null }));

let root: Root;
let host: HTMLDivElement;
const onCreated = vi.fn();
const source: ProductInitiation = { id: 'source', productId: 'app', tCode: 'T1.2.3', planName: '测试方案', status: 'approved', developmentStatus: '待开发', projectType: 'standard', versionType: 'minor', createdBy: 'me', sourceType: 'system', createdAt: '', updatedAt: '', requirementIds: [] };
const release: ProductRelease = { id: 'release', productId: 'app', vCode: 'V1.2.4', planName: '测试方案', status: 'released', projectType: 'standard', versionType: 'minor', createdBy: 'me', sourceType: 'system', createdAt: '', updatedAt: '', requirementIds: [], teamMemberIds: ['me'], isTemporaryOptimization: false, openBrandScope: '上线全域开放' };
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text);
function field(label: string) {
  const wrapper = [...host.querySelectorAll('label')].find((item) => item.querySelector('span')?.textContent === label);
  const control = wrapper?.querySelector<HTMLInputElement | HTMLSelectElement>('input,select');
  if (!control) throw new Error(`未找到字段：${label}`);
  return control;
}
async function change(label: string, value: string) {
  const control = field(label);
  await act(async () => {
    const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function mount(isNew = true, temporary = false) {
  await act(async () => root.render(<MemoryRouter><ReleaseWorkflowDetail productId="app" releaseId={isNew ? 'new' : 'release'} isNew={isNew} temporary={temporary} onCreated={onCreated} /></MemoryRouter>));
}
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.listInitiations.mockResolvedValue({ success: true, data: { items: [source] } });
  api.listProductMembers.mockResolvedValue({ success: true, data: { members: [] } });
  for (const name of ['listRequirements', 'listFeatures', 'listTracedDefects']) api[name].mockResolvedValue({ success: true, data: { items: [] } });
  api.getInheritReleaseManifest.mockResolvedValue({ success: true, data: { previousReleaseId: null, items: [] } });
  api.getRelease.mockResolvedValue({ success: true, data: release });
  api.checkReleaseHistory.mockResolvedValue({ success: true, data: { blocked: false, needsConfirmation: false } });
  api.createRelease.mockResolvedValue({ success: true, data: { ...release, status: 'announcement_pending' } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('正式申领只填写基础信息', () => {
  it.each([false, true])('空功能可确认并发起申领，手工T=%s', async (manual) => {
    // Hidden feature dependencies must not block this path, even when unavailable.
    api.getInheritReleaseManifest.mockRejectedValue(new Error('不应读取隐藏功能清单'));
    await mount();
    expect(button('需求')).toBeUndefined(); expect(button('功能')).toBeUndefined();
    expect(button('确认并获取正式版本号')?.disabled).toBe(true);
    if (manual) {
      await change('内部 T 来源 *', 'manual_t');
      await change('手工 T 号 *', 'T9.0.0'); await change('产品方案名称 *', '手工方案');
    } else await change('立项号 *', 'source');
    expect(host.textContent).not.toContain('在「需求」标签页查看与追加');
    await change('上线日期 *', '2026-10-26'); await change('预计培训时长（分钟）*', '0');
    expect(button('确认并获取正式版本号')?.disabled).toBe(false);
    await act(async () => button('确认并获取正式版本号')?.click());
    expect(api.createRelease).toHaveBeenCalledWith('app', expect.objectContaining({ ownerId: 'me', teamMemberIds: ['me'], plannedTrainingMinutes: 0 }));
    const request = api.createRelease.mock.calls[0][1];
    expect(request.featureManifest).toBeUndefined(); expect(request.additionalRequirementIds).toBeUndefined();
    expect(onCreated).toHaveBeenCalled();
    for (const name of ['listRequirements', 'listFeatures', 'listTracedDefects', 'getInheritReleaseManifest']) expect(api[name]).not.toHaveBeenCalled();
  });

  it('临时优化保留需求功能页签及空功能阻止确认', async () => {
    await mount(true, true);
    expect(button('需求')).toBeDefined(); expect(button('功能')).toBeDefined();
    expect(button('确认并获取正式版本号')?.disabled).toBe(true);
    expect(api.getInheritReleaseManifest).toHaveBeenCalled();
  });

  it('已发号详情保留需求功能及缺陷页签，不删除历史入口', async () => {
    await mount(false);
    expect(button('需求')).toBeDefined(); expect(button('功能')).toBeDefined(); expect(button('缺陷')).toBeDefined();
    expect(button('确认并获取正式版本号')).toBeUndefined();
  });
});
