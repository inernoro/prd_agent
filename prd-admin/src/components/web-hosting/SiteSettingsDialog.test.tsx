// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteSettingsDialog, { PageSettingsForm } from './SiteSettingsDialog';
import { getSite, listFolders, setSiteCommentsEnabled, updateSite, type HostedSite } from '@/services/real/webPages';

vi.mock('@/services/real/webPages', () => ({ getSite: vi.fn(), listFolders: vi.fn(), setSiteCommentsEnabled: vi.fn(), updateSite: vi.fn() }));
vi.mock('./ask/AskConfigDrawer', () => ({ default: () => <textarea aria-label="提问草稿" /> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content }: { content: React.ReactNode }) => <div role="dialog">{content}</div> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <div>读取中</div> }));
const site = { id: 'site-a', title: '原标题', description: '原描述', tags: ['标签'], folder: '分组', commentsEnabled: true, sharedTeamIds: [] } as unknown as HostedSite;
const ok = <T,>(data: T) => ({ success: true as const, data, error: null });
const fail = { success: false as const, data: null, error: { code: 'FAILED', message: '服务暂不可用' } };
let container: HTMLDivElement;
let root: Root;
let onSaved: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
const button = (text: string) => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === text)!;
function input(label: string, value: string) {
  act(() => {
    const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function renderForm() { await act(async () => root.render(<PageSettingsForm siteId="site-a" onSaved={onSaved} onClose={onClose} onBusyChange={vi.fn()} />)); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  onSaved = vi.fn().mockResolvedValue(undefined); onClose = vi.fn();
  vi.mocked(getSite).mockResolvedValue(ok(site));
  vi.mocked(listFolders).mockResolvedValue(ok({ folders: ['分组'] }));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('网页设置', () => {
  it('读取失败时禁止提交默认值', async () => {
    vi.mocked(getSite).mockResolvedValue(fail);
    await renderForm();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('服务暂不可用');
    expect(button('保存网页信息').disabled).toBe(true);
    expect(updateSite).not.toHaveBeenCalled();
  });
  it('只更新改过的元信息，评论失败后重试不会重复更新元信息', async () => {
    vi.mocked(updateSite).mockResolvedValue(ok({ ...site, title: '新标题' }));
    vi.mocked(setSiteCommentsEnabled).mockResolvedValueOnce(fail).mockResolvedValueOnce(ok({ id: site.id, commentsEnabled: false }));
    await renderForm();
    input('网页标题', '新标题');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="允许评论"]')!.click());
    await act(async () => button('保存网页信息').click());
    expect(updateSite).toHaveBeenCalledTimes(1);
    expect(updateSite).toHaveBeenCalledWith('site-a', { title: '新标题' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网页信息已保存；评论设置保存失败');
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => button('保存网页信息').click());
    expect(updateSite).toHaveBeenCalledTimes(1);
    expect(setSiteCommentsEnabled).toHaveBeenLastCalledWith('site-a', false);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已保存');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('切换设置分类保留输入，保存当前分类不关闭另一分类的草稿', async () => {
    await act(async () => root.render(<SiteSettingsDialog siteId="site-a" siteTitle="原标题" onClose={onClose} onSaved={onSaved} />));
    input('网页标题', '尚未保存');
    await act(async () => button('提问设置').click());
    const draft = container.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!;
    draft.value = '未保存的开场内容';
    act(() => button('网页信息').click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="网页标题"]')!.value).toBe('尚未保存');
    vi.mocked(updateSite).mockResolvedValue(ok({ ...site, title: '尚未保存' }));
    await act(async () => button('保存网页信息').click());
    act(() => button('提问设置').click());
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!.value).toBe('未保存的开场内容');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('团队网页不显示个人分组编辑框', async () => {
    vi.mocked(getSite).mockResolvedValue(ok({ ...site, sharedTeamIds: ['team-a'] }));
    await renderForm();
    expect(container.querySelector('[aria-label="网页分组"]')).toBeNull();
    expect(container.textContent).toContain('团队分组可在网页托管列表中调整');
  });
});
