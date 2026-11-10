// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostedCollectionEditor } from './HostedCollectionManager';
import * as api from '@/services/real/hostedCollections';

vi.mock('@/services/real/hostedCollections', () => ({ getCollectionCandidates: vi.fn(), getCollection: vi.fn(), getCollectionByShare: vi.fn(), createCollection: vi.fn(), updateCollection: vi.fn(), adoptCollection: vi.fn(), dissolveCollection: vi.fn(), stopCollectionSharing: vi.fn(), previewCollectionSharing: vi.fn(), createCollectionShare: vi.fn() }));
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
});
afterEach(() => { act(() => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it('创建时明确名称和主文档，保存顺序且不会自动创建外部分享', async () => {
  vi.mocked(api.createCollection).mockResolvedValue({ success: true, data: details, error: null });
  await act(async () => root.render(<HostedCollectionEditor initialSites={sites} onClose={vi.fn()} />));
  expect([...element.querySelectorAll('button')].find(x => x.textContent === '保存合集')!.disabled).toBe(true);
  await input('发布资料');
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="设为主文档：交付"]')!.click());
  await click('保存合集');
  expect(api.createCollection).toHaveBeenCalledWith({ title: '发布资料', siteIds: ['b', 'a', 'c'], mainSiteId: 'b', version: 0 });
  expect(api.createCollectionShare).not.toHaveBeenCalled();
});

it('版本冲突保留编辑内容并禁止将未保存成员生成分享', async () => {
  vi.mocked(api.updateCollection).mockResolvedValue({ success: false, data: null as never, error: { code: 'COLLECTION_CHANGED', message: '合集已变化，请刷新后重新确认' } });
  await act(async () => root.render(<HostedCollectionEditor collectionId="col" onClose={vi.fn()} />));
  await input('新的资料名');
  await click('保存合集');
  expect(api.updateCollection).toHaveBeenCalledWith('col', expect.objectContaining({ version: 4, title: '新的资料名' }));
  expect(element.querySelector('[role="alert"]')!.textContent).toContain('合集已变化');
  expect(element.querySelector<HTMLInputElement>('[aria-label="合集名称"]')!.value).toBe('新的资料名');
  expect([...element.querySelectorAll('button')].find(x => x.textContent === '生成分享链接')!.disabled).toBe(true);
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
