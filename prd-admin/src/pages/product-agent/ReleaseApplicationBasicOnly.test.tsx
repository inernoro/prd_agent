// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseWorkflowDetail } from './ReleaseWorkflowDetail';
import type { ProductInitiation, ProductRelease } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => Object.fromEntries(['listInitiations', 'listProductMembers', 'listRequirements', 'listFeatures', 'listTracedDefects', 'getInheritReleaseManifest', 'getRelease', 'getInitiation', 'checkReleaseHistory', 'createRelease', 'parseProductVersionMessage'].map((name) => [name, vi.fn()])));
vi.mock('@/services/real/productAgent', async (original) => ({ ...await original<typeof import('@/services/real/productAgent')>(), ...api }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'me', displayName: '申请人' }, permissions: ['product-agent.use'], isRoot: false }) }));
vi.mock('@/services/real/teams', () => ({ getUserCards: async () => ({ success: true, data: { items: [{ userId: 'me', displayName: '申请人' }] } }) }));
vi.mock('./DynamicForm', async (original) => ({ ...await original<typeof import('./DynamicForm')>(), useEffectiveWorkflow: () => ({ workflow: null }) }));
vi.mock('./useReleasePastedMembers', () => ({ useReleasePastedMembers: () => ({ matches: [], pendingCount: 0, identify: () => {}, choose: () => {} }) }));
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
  api.createRelease.mockResolvedValue({ success: true, data: release });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

const otherSource: ProductInitiation = { ...source, id: 'other-source', productId: 'other-app', tCode: 'T2.0.1', planName: '另一个应用方案' };
function PasteApplication() {
  const [application, setApplication] = useState('app');
  return <><output aria-label="已回填应用">{application}</output><ReleaseWorkflowDetail productId={application} releaseId="new" isNew temporary={false}
    availableInitiations={[source, otherSource]} onApplicationProductChange={setApplication} /></>;
}
const parsed = (item: ProductInitiation) => ({ success: true, data: { result: {
  planName: item.planName, tCode: item.tCode, matchedApplicationId: item.productId,
  matchedInitiationId: item.id, candidateInitiationIds: [item.id], initiationCandidates: [item], matchedFields: ['planName', 'tCode'],
} } });
async function pasteNotice(text: string) {
  const area = host.querySelector('textarea[id="version-message-formal"]')!;
  await act(async () => {
    // jsdom does not perform the native clipboard insertion; set its resulting value explicitly.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('paste', { bubbles: true }));
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
}

describe('正式申领只填写基础信息', () => {
  it('相同通知重新粘贴会再次识别，并重新回填已改选的T号和应用', async () => {
    vi.useFakeTimers();
    api.parseProductVersionMessage.mockResolvedValue(parsed(source));
    await act(async () => root.render(<MemoryRouter><PasteApplication /></MemoryRouter>));
    expect(button('手工填写 T 号')).toBeUndefined();
    const notice = '产品方案名称：测试应用（测试方案）';
    await pasteNotice(notice);
    expect(field('立项号 *').value).toBe(source.id);
    await change('立项号 *', otherSource.id);
    await change('产品方案名称 *', '上一次手工修改');
    expect(host.querySelector('output')?.value).toBe('other-app');
    await pasteNotice(notice);
    expect(api.parseProductVersionMessage).toHaveBeenCalledTimes(2);
    expect(button('手工填写 T 号')).toBeUndefined();
    expect(field('立项号 *').value).toBe(source.id);
    expect(host.querySelector('output')?.value).toBe('app');
    expect(field('产品方案名称 *').value).toBe(source.planName);
  });

  it('改粘贴另一通知后按最新结果回填，较慢的旧结果不能覆盖T号和应用', async () => {
    vi.useFakeTimers();
    let finishOld!: (value: unknown) => void;
    api.parseProductVersionMessage.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(parsed(otherSource));
    await act(async () => root.render(<MemoryRouter><PasteApplication /></MemoryRouter>));
    await pasteNotice('产品方案名称：旧通知（测试方案）');
    await pasteNotice('产品方案名称：新通知（另一个应用方案）');
    expect(field('立项号 *').value).toBe(otherSource.id);
    expect(host.querySelector('output')?.value).toBe('other-app');
    await act(async () => finishOld(parsed(source)));
    expect(field('立项号 *').value).toBe(otherSource.id);
    expect(host.querySelector('output')?.value).toBe('other-app');
    expect(field('产品方案名称 *').value).toBe(otherSource.planName);
  });

  it('选择已有T后空功能可确认并发起申领', async () => {
    // Hidden feature dependencies must not block this path, even when unavailable.
    api.getInheritReleaseManifest.mockRejectedValue(new Error('不应读取隐藏功能清单'));
    await mount();
    expect(button('需求')).toBeUndefined(); expect(button('功能')).toBeUndefined();
    expect(button('确认并获取正式版本号')?.disabled).toBe(true);
    expect(button('手工填写 T 号')).toBeUndefined();
    await change('立项号 *', 'source');
    expect(host.textContent).not.toContain('在「需求」标签页查看与追加');
    await change('上线日期 *', '2026-10-26'); await change('预计培训时长（分钟）*', '0');
    expect(button('确认并获取正式版本号')?.disabled).toBe(false);
    await act(async () => button('确认并获取正式版本号')?.click());
    expect(api.createRelease).toHaveBeenCalledWith('app', expect.objectContaining({ ownerId: 'me', teamMemberIds: ['me'], plannedTrainingMinutes: 0 }));
    const request = api.createRelease.mock.calls[0][1];
    expect(request.initiationId).toBe('source'); expect(request.manualTCode).toBeUndefined();
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

  it('米多总后台按服务端规则隐藏培训时长，切换方案后不带入之前的培训分钟', async () => {
    const exempt = { ...source, appName: '米多总后台', releaseTrainingRequired: false };
    const ordinary = { ...source, id: 'ordinary', releaseTrainingRequired: true };
    api.listInitiations.mockResolvedValue({ success: true, data: { items: [exempt, ordinary] } });
    await mount();
    await change('立项号 *', 'ordinary');
    await change('上线日期 *', '2026-10-26');
    expect(button('确认并获取正式版本号')?.disabled).toBe(true);
    await change('预计培训时长（分钟）*', '30');
    await change('立项号 *', source.id);
    expect(host.textContent).not.toContain('预计培训时长（分钟）*');
    expect(button('确认并获取正式版本号')?.disabled).toBe(false);
    await act(async () => button('确认并获取正式版本号')?.click());
    expect(api.createRelease).toHaveBeenCalledWith('app', expect.objectContaining({ initiationId: source.id, plannedTrainingMinutes: undefined }));
  });

  it('已发号详情保留需求功能及缺陷页签，不删除历史入口', async () => {
    await mount(false);
    expect(button('需求')).toBeDefined(); expect(button('功能')).toBeDefined(); expect(button('缺陷')).toBeDefined();
    expect(button('确认并获取正式版本号')).toBeUndefined();
  });
});
