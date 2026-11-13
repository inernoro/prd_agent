// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostedTemplatePage from '../HostedTemplatePage';
import type { HostedCollectionCandidates } from '@/services/contracts/hostedCollections';

const api = vi.hoisted(() => ({ candidates: vi.fn(), publish: vi.fn() }));
vi.mock('@/services/real/hostedCollections', () => ({ getHostedCollectionCandidates: api.candidates }));
vi.mock('@/services/real/webPages', () => ({ createFromContent: api.publish }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'author', displayName: '当前作者' } }) }));
vi.mock('../../document-store/writing/WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('../../document-store/writing/WritingWorkspacePage', () => ({ WritingThemeButton: () => <button>切换主题</button> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const fixture = (): HostedCollectionCandidates => ({ templates: [
  { id: 'overview', name: '总览模版', type: '总览', version: '1.0', role: 'primary', useWhen: '先读结论', headings: [{ title: '结论摘要', hint: '总览提示' }] },
  { id: 'tech', name: '技术方案模版', type: '技术方案', version: '1.0', role: 'member', useWhen: '方案评审', headings: [{ title: '方案设计', hint: '技术提示' }] },
], items: [
  { id: 'hidden', title: '不可用文档', canEdit: false, canShare: false, unavailable: true },
  { id: 'visible', title: '真实候选资料', author: '候选作者', type: '复盘', updatedAt: '2026-10-29T00:00:00Z', canEdit: false, canShare: false },
], legacy: [] });
let root: Root, container: HTMLDivElement;
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><HostedTemplatePage /></MemoryRouter>));
}
async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); api.candidates.mockResolvedValue({ success: true, data: fixture() }); });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('模版来源、字段映射与真实相邻预览', () => {
  it('只改文档类型不改来源模版、小标题或提示，刷新仍恢复独立状态', async () => {
    await mount(); await input('标题', '我写的总览');
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.ht-editor .ht-types button')].find(b => b.textContent === '技术方案')!.click());
    expect(container.querySelector('[aria-label="模版"] button[aria-pressed="true"]')?.textContent).toBe('总览');
    expect(container.querySelector('.ht-editor-heading')?.textContent).toContain('总览模版');
    expect(container.querySelector('.hh')?.textContent).toBe('总览提示');
    expect(JSON.parse(localStorage.getItem('hosted-template-draft:author')!)).toMatchObject({ templateId: 'overview', type: '技术方案', title: '我写的总览', headings: ['结论摘要'] });
    await act(async () => root.unmount()); container.remove(); await mount();
    expect(container.querySelector('[aria-label="模版"] button[aria-pressed="true"]')?.textContent).toBe('总览');
    expect(container.querySelector('.ht-editor button[aria-pressed="true"]')?.textContent).toBe('技术方案');
  });
  it('行内类型、自动字段和目录标题使用对应的行内编号锚点', async () => {
    await mount();
    for (const selector of ['.ht-primary [data-k="1"]', '.ht-primary .ht-types [data-k="5"]', '.ht-directory [data-k="2"]', '.ht-read-meta [data-k="1"]']) expect(container.querySelector(selector)?.classList.contains('in'), selector).toBe(true);
  });
  it('相邻行只使用可见真实候选，编辑当前标题不会改写相邻资料', async () => {
    await mount(); const neighbor = container.querySelector('[aria-label="相邻文档预览"]');
    expect(neighbor?.textContent).toContain('真实候选资料'); expect(neighbor?.textContent).toContain('候选作者'); expect(neighbor?.textContent).toContain('复盘'); expect(neighbor?.textContent).toContain('10-29');
    expect(neighbor?.textContent).not.toContain('不可用文档');
    await input('标题', '当前新标题'); expect(neighbor?.textContent).toContain('真实候选资料'); expect(neighbor?.textContent).not.toContain('当前新标题');
  });
  it('没有可见候选时显示相邻预览空态，不写死设计稿文章', async () => {
    const data = fixture(); data.items = data.items.filter(item => item.unavailable); api.candidates.mockResolvedValue({ success: true, data });
    await mount(); expect(container.querySelector('[aria-label="相邻文档预览"]')?.textContent).toContain('暂无可用于相邻预览的可见文档'); expect(container.textContent).not.toContain('合规审查 数据周报');
  });
  it('候选尚未返回时不能先声称没有相邻资料', async () => {
    let resolve!: (value: unknown) => void; api.candidates.mockReturnValue(new Promise(r => { resolve = r; }));
    await mount(); expect(container.querySelector('[aria-label="相邻文档预览"]')?.textContent).toContain('正在读取相邻资料');
    expect(container.textContent).not.toContain('暂无可用于相邻预览');
    await act(async () => resolve({ success: true, data: fixture() }));
    expect(container.querySelector('[aria-label="相邻文档预览"]')?.textContent).toContain('真实候选资料');
  });
  it('候选读取失败时显示读取失败，不冒充真实空集合', async () => {
    api.candidates.mockResolvedValue({ success: false, error: { message: '暂时无法读取' } }); await mount();
    expect(container.querySelector('[aria-label="相邻文档预览"]')?.textContent).toContain('相邻资料暂时无法读取'); expect(container.textContent).not.toContain('暂无可用于相邻预览');
  });
  it('候选缺少元信息时明确缺失，不借用当前作者或生成日期', async () => {
    const data = fixture(); data.items = [{ id: 'partial', title: '元信息不全的真实资料', canEdit: false, canShare: false }]; api.candidates.mockResolvedValue({ success: true, data });
    await mount(); const text = container.querySelector('[aria-label="相邻文档预览"]')?.textContent;
    expect(text).toContain('作者未提供'); expect(text).toContain('类型未提供'); expect(text).toContain('更新时间未提供'); expect(text).not.toContain('当前作者');
  });
  it('发布分别传递原始模版来源与作者修改后的文档类型', async () => {
    localStorage.setItem('hosted-template-draft:author', JSON.stringify({ templateId: 'overview', type: '技术方案', title: '独立类型文档', summary: '', headings: ['结论摘要'], body: '真实正文' }));
    api.publish.mockResolvedValue({ success: true, data: { id: 'saved' } }); await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('.ht-publish')!.click());
    expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({ writingTemplateId: 'overview', documentType: '技术方案', title: '独立类型文档' }));
  });
  it('手机主卡只预览前三节，剩余数准确且阅读按钮切到现有阅读预览', async () => {
    localStorage.setItem('hosted-template-draft:author', JSON.stringify({ templateId: 'overview', type: '总览', title: '真实标题', summary: '摘要', headings: ['一', '二', '三', '四', '五'], body: '真实正文' }));
    await mount(); const outline = container.querySelector('.ht-mobile-outline');
    expect(outline?.querySelectorAll('.ht-toc-row')).toHaveLength(3); expect(outline?.textContent).toContain('还有 2 节');
    await act(async () => container.querySelector<HTMLButtonElement>('.ht-start-reading')!.click());
    expect(container.querySelector('.ht-layout')?.classList.contains('show-preview')).toBe(true);
    expect(container.querySelector('.ht-preview-block.current .ht-read')?.textContent).toContain('真实正文');
    expect(api.publish).not.toHaveBeenCalled(); expect(JSON.parse(localStorage.getItem('hosted-template-draft:author')!).headings).toHaveLength(5);
  });
  it.each([0, 1, 3])('小标题%d节时不生成负数或零剩余，空目录仍可阅读正文', async count => {
    localStorage.setItem('hosted-template-draft:author', JSON.stringify({ templateId: 'overview', type: '总览', title: '边界标题', summary: '', headings: Array.from({ length: count }, (_, i) => `第${i + 1}节`), body: '保留原文' }));
    await mount(); expect(container.querySelector('.ht-mobile-outline .ht-toc-more')).toBeNull();
    expect(container.querySelectorAll('.ht-mobile-outline .ht-toc-row')).toHaveLength(count);
    expect(container.querySelector('.ht-start-reading')).not.toBeNull();
  });
  it('主文档长标题裁切仅作用于内部文字，不裁掉外层字段标记', async () => {
    await mount(); expect(container.querySelector('.ht-primary [data-k="2"]')?.classList.contains('cl2')).toBe(false);
    expect(container.querySelector('.ht-primary [data-k="2"] .cl2')).not.toBeNull();
  });

  it('主卡元信息使用柔和等宽小字，只显示真实类型与待发布状态', async () => {
    await mount(); const metadata = container.querySelector('.ht-primary-meta');
    expect(metadata?.textContent).toBe('总览 · 待发布');
    expect(metadata?.classList.contains('mono')).toBe(true); expect(metadata?.classList.contains('hint')).toBe(true);
    expect(metadata?.textContent).not.toMatch(/v3|分钟|发布后生成/);
  });

  it('桌面字段规则包含原稿五项，保留自动字段及完整显示和缺失规则', async () => {
    await mount(); const rows = [...container.querySelectorAll('.ht-desktop-rules .ht-rule-row:not(.mono)')];
    expect(rows.map(row => row.children[1].textContent)).toEqual(['文档类型', '标题', '摘要', '正文小标题', '自动字段']);
    expect(rows[4].textContent).toContain('版本、作者、更新时间、批注与讨论数、阅读时长');
    expect(rows[2].textContent).toContain('取正文开头 60 字并标注「正文开头」；小合集列表不显示');
  });
  it('手机规则完整呈现五张字段卡及限制/显示在/缺失时，关闭不会改写作者字段', async () => {
    await mount(); await input('标题', '规则不改我的标题');
    await act(async () => container.querySelector<HTMLButtonElement>('.ht-mobile-footer button')!.click());
    const cards = [...container.querySelectorAll('[role="dialog"] .ht-rule-card')];
    expect(cards).toHaveLength(5);
    for (const card of cards) expect([...card.querySelectorAll('.ht-rule-key')].map(e => e.textContent)).toEqual(['限制', '显示在', '缺失时']);
    expect(cards[0].textContent).toContain('类型标签、目录副标题、按类型筛选'); expect(cards[4].textContent).toContain('自动字段');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭字段规则"]')!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(JSON.parse(localStorage.getItem('hosted-template-draft:author')!).title).toBe('规则不改我的标题'); expect(api.publish).not.toHaveBeenCalled();
  });

  it('桌面阅读目录无编号，首项选中，点击定位真实小节且不修改正文', async () => {
    localStorage.setItem('hosted-template-draft:author', JSON.stringify({ templateId: 'overview', type: '总览', title: '阅读目录', summary: '摘要', headings: ['甲', '乙', '丙'], body: '作者的完整正文' }));
    await mount(); const links = [...container.querySelectorAll<HTMLAnchorElement>('.ht-read-toc a')];
    expect(links.map(e => e.textContent)).toEqual(['甲', '乙', '丙']); expect(links[0].getAttribute('aria-current')).toBe('location');
    const section = container.querySelector<HTMLElement>('#template-read-section-2')!; const scroll = vi.fn(); section.scrollIntoView = scroll;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    await act(async () => links[2].click()); vi.unstubAllGlobals();
    expect(scroll).toHaveBeenCalledWith({ block: 'start' }); expect(links[2].getAttribute('aria-current')).toBe('location');
    expect(JSON.parse(localStorage.getItem('hosted-template-draft:author')!).body).toBe('作者的完整正文');
  });
  it.each([0, 1, 3, 5])('手机阅读预览%d节时提供真实折叠目录，0节不留空目录列', async count => {
    const draft = { templateId: 'overview', type: '总览', title: '真实阅读标题', summary: '', headings: Array.from({ length: count }, (_, i) => `真实第${i+1}节`), body: '正文原文不能被目录改写' };
    localStorage.setItem('hosted-template-draft:author', JSON.stringify(draft)); await mount();
    const toc = container.querySelector('.ht-read-mobile-toc');
    if (!count) { expect(toc).toBeNull(); expect(container.querySelector('.ht-read aside')).toBeNull(); expect(container.querySelector('.ht-read-no-toc')).not.toBeNull(); }
    else {
      const toggle = toc!.querySelector<HTMLButtonElement>('button')!; expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(toggle.textContent).toContain(`本文目录 · ${count} 节`);
      await act(async () => toggle.click()); expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const links = [...toc!.querySelectorAll<HTMLAnchorElement>('a')]; expect(links).toHaveLength(count);
      for (const link of links) expect(link.classList.contains('cur')).toBe(false);
      const target = container.querySelector<HTMLElement>(`#template-read-section-${count-1}`)!; const scroll = vi.fn(); target.scrollIntoView = scroll;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
      await act(async () => links[count-1].click()); vi.unstubAllGlobals(); expect(scroll).toHaveBeenCalledWith({ block: 'start' }); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    expect(JSON.parse(localStorage.getItem('hosted-template-draft:author')!)).toEqual(draft);
  });

});
