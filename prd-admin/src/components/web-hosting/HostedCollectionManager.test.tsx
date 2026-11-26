// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostedCollectionEditor } from './HostedCollectionManager';
import * as api from '@/services/real/hostedCollections';

vi.mock('@/services/real/hostedCollections', () => ({ getCollectionCandidates: vi.fn(), getCollection: vi.fn(), getCollectionByShare: vi.fn(), createCollection: vi.fn(), updateCollection: vi.fn(), adoptCollection: vi.fn(), dissolveCollection: vi.fn(), stopCollectionSharing: vi.fn(), previewCollectionSharing: vi.fn(), createCollectionShare: vi.fn(), suggestCollectionNames: vi.fn() }));
vi.mock('@/services/real/webPages', () => ({ revokeShare: vi.fn(), getSitesPrivateSources: vi.fn() }));
vi.mock('./RelatedDocumentsBar', () => ({ RelatedPermissionsDialog: () => null }));
vi.mock('./PrivateSourceConfirmHost', () => ({ default: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在加载</span> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, content, actions }: { title: string; content: React.ReactNode; actions: React.ReactNode }) => <section role="dialog" aria-label={title}>{content}{actions}</section> }));

let element: HTMLDivElement;
let root: Root;
const sites = [{ id: 'a', title: '方案' }, { id: 'b', title: '交付' }, { id: 'c', title: '附录' }];
const collection = { id: 'col', ownerUserId: 'owner', title: '发布资料', siteIds: ['a', 'b', 'c'], mainSiteId: 'a', version: 4, shareGeneration: 1, isDissolved: false, updatedAt: '' };
const details = { collection, sites, shares: [] };
async function click(text: string) {
  const button = [...element.querySelectorAll('button')].find(x => x.textContent === text)!;
  expect(button, text).toBeDefined();
  await act(async () => button.click());
}
async function input(value: string) {
  const field = element.querySelector<HTMLInputElement>('[aria-label="合集名称"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  vi.mocked(api.getCollectionCandidates).mockResolvedValue({ success: true, data: { items: sites, total: 3 }, error: null });
  vi.mocked(api.getCollection).mockResolvedValue({ success: true, data: details, error: null });
  vi.mocked(api.suggestCollectionNames).mockResolvedValue({ success: true, data: { names: ['发布资料合集'] }, error: null });
});
afterEach(() => { act(() => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it.each(['collection', 'share'] as const)('打开已有 %s 目标失败时不切换为创建，重试后仍更新原合集', async target => {
  const load = target === 'collection' ? vi.mocked(api.getCollection) : vi.mocked(api.getCollectionByShare);
  load.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ success: true, data: details, error: null });
  vi.mocked(api.updateCollection).mockResolvedValue({ success: true, data: details, error: null });
  await act(async () => root.render(<HostedCollectionEditor {...(target === 'collection' ? { collectionId: 'col' } : { shareToken: 'old-token' })} initialSites={sites} onClose={vi.fn()} />));
  expect(element.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('管理合集');
  expect(element.querySelector('[aria-label="合集名称"]')).toBeNull();
  expect([...element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存合集')?.disabled).toBe(true);
  await click('保存合集');
  expect(api.createCollection).not.toHaveBeenCalled();
  expect(api.adoptCollection).not.toHaveBeenCalled();
  await click('刷新实际状态');
  expect(element.querySelector<HTMLInputElement>('[aria-label="合集名称"]')?.value).toBe(collection.title);
  await input('更新原合集');
  await click('保存合集');
  expect(api.updateCollection).toHaveBeenCalledWith('col', expect.objectContaining({ title: '更新原合集', version: 4 }));
  expect(api.createCollection).not.toHaveBeenCalled();
});

it('批量创建默认选择首份主文档，直接保存后才出现生成分享入口', async () => {
  vi.mocked(api.createCollection).mockResolvedValue({ success: true, data: details, error: null });
  await act(async () => root.render(<HostedCollectionEditor initialSites={sites} onClose={vi.fn()} />));
  expect(element.querySelector('[data-main="true"]')?.textContent).toContain('方案');
  await input('发布资料');
  await click('保存合集');
  expect(api.createCollection).toHaveBeenCalledWith({ title: '发布资料', siteIds: ['a', 'b', 'c'], mainSiteId: 'a', version: 0 });
  expect(api.createCollectionShare).not.toHaveBeenCalled();
  expect(element.textContent).toContain('生成分享链接');
});

it('创建时仍可显式更换主文档并保存顺序', async () => {
  vi.mocked(api.createCollection).mockResolvedValue({ success: true, data: details, error: null });
  await act(async () => root.render(<HostedCollectionEditor initialSites={sites} onClose={vi.fn()} />));
  await input('发布资料');
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="设为主文档：交付"]')!.click());
  await click('保存合集');
  expect(api.createCollection).toHaveBeenCalledWith({ title: '发布资料', siteIds: ['b', 'a', 'c'], mainSiteId: 'b', version: 0 });
  expect(api.createCollectionShare).not.toHaveBeenCalled();
});

it('在新截止时间内接收网关结果并且只请求一次', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.suggestCollectionNames).mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ success: true, data: { names: ['发布资料合集'] }, error: null }), 1850);
    }));
    await act(async () => root.render(<HostedCollectionEditor initialSites={sites} onClose={vi.fn()} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1851); });
    expect(element.querySelector<HTMLInputElement>('[aria-label="合集名称"]')?.value).toBe('发布资料合集');
    expect(element.querySelector('.collection-naming-status')).toBeNull();
    expect(api.suggestCollectionNames).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('模型超时保留用户已输入的名称且不重复请求', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.suggestCollectionNames).mockImplementation((_ids, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ success: true, data: { names: [] }, error: null }), { once: true });
    }));
    await act(async () => root.render(<HostedCollectionEditor initialSites={sites} onClose={vi.fn()} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.suggestCollectionNames).toHaveBeenCalledOnce();
    await input('我的自定义名称');
    await act(async () => { await vi.advanceTimersByTimeAsync(1975); });
    expect(element.querySelector<HTMLInputElement>('[aria-label="合集名称"]')?.value).toBe('我的自定义名称');
    expect(element.querySelector('.collection-naming-status')).toBeNull();
    expect(api.suggestCollectionNames).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('版本冲突保留编辑内容并禁止将未保存成员生成分享', async () => {
  vi.mocked(api.updateCollection).mockResolvedValue({ success: false, data: null as never, error: { code: 'COLLECTION_CHANGED', message: '合集已变化，请刷新后重新确认' } });
  await act(async () => root.render(<HostedCollectionEditor collectionId="col" onClose={vi.fn()} />));
  await input('新的资料名');
  await click('保存合集');
  expect(api.updateCollection).toHaveBeenCalledWith('col', expect.objectContaining({ version: 4, title: '新的资料名' }));
  expect(element.querySelector('[role="alert"]')!.textContent).toContain('合集已变化');
  expect(element.querySelector<HTMLInputElement>('[aria-label="合集名称"]')!.value).toBe('新的资料名');
  expect([...element.querySelectorAll('button')].some(x => x.textContent === '生成分享链接')).toBe(false);
});

it('解散须确认并只调用合集接口，不触发原文档删除', async () => {
  const close = vi.fn();
  vi.mocked(api.dissolveCollection).mockResolvedValue({ success: true, data: {}, error: null });
  await act(async () => root.render(<HostedCollectionEditor collectionId="col" onClose={close} />));
  await click('解散合集');
  expect(api.dissolveCollection).not.toHaveBeenCalled();
  expect(element.textContent).toContain('原文档及其独立分享保留');
  await click('确认解散合集');
  expect(api.dissolveCollection).toHaveBeenCalledWith('col', 4);
  expect(close).toHaveBeenCalledOnce();
});


it('设计 Demo 保存与分享在本地演示，不调用真实合集服务', async () => {
  await act(async () => root.render(<HostedCollectionEditor initialSites={sites} demo onClose={vi.fn()} />));
  await input('演示资料');
  await click('保存合集');
  expect(api.createCollection).not.toHaveBeenCalled();
  expect(api.updateCollection).not.toHaveBeenCalled();
  await click('生成分享链接');
  await click('确认范围并生成链接');
  expect(api.previewCollectionSharing).not.toHaveBeenCalled();
  expect(api.createCollectionShare).not.toHaveBeenCalled();
  expect(element.textContent).toContain('/_dev/web-hosting-share');
});
