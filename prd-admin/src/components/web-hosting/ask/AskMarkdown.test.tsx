// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskMarkdown } from './AskMarkdown';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
const badge = () => container.querySelector<HTMLAnchorElement>('.ask-citation-badge')!;
const popup = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="引用原文"]')!;
const content = '结论[^1]。再次引用[^1]。\n\n[^1]: 原文条件。';

describe('问答来源小标', () => {
  it('句末显示真实网页名称，点击就地查看短摘录，完整片段按需展开', () => {
    const quote = '原文开头。' + '用于核对的原文内容。'.repeat(70) + '仅适用于已审核订单。';
    act(() => root.render(<AskMarkdown sourceTitle="扫码风控架构设计演示文稿" content={`结论[^1]。\n\n[^1]: ${quote}`} />));
    const citations = container.querySelector<HTMLDetailsElement>('.ask-citations')!;
    expect(citations.open).toBe(false);
    expect(badge().textContent).toBe('扫码风控架构设计演示文稿');
    expect(container.querySelector('sup')).toBeNull();
    expect(popup()).toBeNull();
    const hash = window.location.hash;
    act(() => badge().click());
    expect(popup()).not.toBeNull();
    expect(citations.open).toBe(false);
    expect(Array.from(popup().querySelector('p')!.textContent ?? '').length).toBeLessThanOrEqual(161);
    expect(popup().textContent).not.toContain('仅适用于已审核订单。');
    act(() => popup().querySelector<HTMLButtonElement>('.ask-citation-card > button')!.click());
    expect(popup().querySelector('p')!.textContent).toBe(quote);
    act(() => popup().querySelector<HTMLButtonElement>('.ask-citation-card > button')!.click());
    expect(popup().querySelector('p')!.textContent).toMatch(/…$/);
    act(() => popup().querySelector<HTMLButtonElement>('[aria-label="关闭引用"]')!.click());
    expect(popup()).toBeNull(); expect(document.activeElement).toBe(badge());
    expect(window.location.hash).toBe(hash);
  });

  it('同一句相邻引用合并为来源 +N，非相邻引用保留在各自句末', () => {
    act(() => root.render(<AskMarkdown sourceTitle="本页标题" content={'合并结论[^1] [^2]。另一句[^1]。\n\n[^1]: 第一处原文。\n\n[^2]: 第二处原文。'} />));
    expect(container.querySelectorAll('.ask-citation-badge')).toHaveLength(2);
    expect(badge().textContent).toBe('本页标题+1');
    act(() => badge().click());
    expect(popup().querySelectorAll('.ask-citation-card')).toHaveLength(2);
    expect(popup().textContent).toContain('第一处原文。');
    expect(popup().textContent).toContain('第二处原文。');
    act(() => popup().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(popup()).toBeNull(); expect(document.activeElement).toBe(badge());
    act(() => root.render(<AskMarkdown content={'重复[^1][^1]。\n\n[^1]: 相同原文。'} />));
    expect(container.querySelectorAll('.ask-citation-badge')).toHaveLength(1);
    expect(container.querySelector('.ask-citation-badge-count')).toBeNull();
  });

  it('多条回答的引用独立，重复及合并引用返回正确的小标而不改变路由', () => {
    act(() => root.render(<><AskMarkdown content={content} /><AskMarkdown content={content} /></>));
    const answers = container.querySelectorAll('.ask-md');
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hash = window.location.hash;
    for (const answer of answers) {
      const citations = answer.querySelector<HTMLDetailsElement>('.ask-citations')!;
      act(() => citations.querySelector('summary')!.click());
      const refs = answer.querySelectorAll<HTMLAnchorElement>('.ask-citation-badge');
      const backs = answer.querySelectorAll<HTMLAnchorElement>('.ask-citation-actions a');
      expect(backs).toHaveLength(2);
      act(() => backs[1].click());
      expect(document.activeElement).toBe(refs[1]);
      expect(window.location.hash).toBe(hash);
      expect(answer.querySelector('[id$="footnote-label"]')?.textContent).toBe('引用原文');
    }
    act(() => root.render(<AskMarkdown content={'结论[^1][^2]。\n\n[^1]: 原文一。\n\n[^2]: 原文二。'} />));
    act(() => container.querySelector('summary')!.click());
    act(() => container.querySelectorAll<HTMLAnchorElement>('.ask-citation-actions a')[1].click());
    expect(document.activeElement).toBe(badge());
  });

  it('末尾引用栏仍可按需展开，压缩预览不丢弃原文尾部条件', () => {
    const quote = '正文内容。'.repeat(50) + '不适用于已开票订单。';
    act(() => root.render(<AskMarkdown content={`结论[^1]。\n\n[^1]: ${quote}`} />));
    const citations = container.querySelector<HTMLDetailsElement>('.ask-citations')!;
    expect(citations.querySelector('summary')?.textContent).toBe('引用 · 1');
    const full = citations.querySelector<HTMLElement>('.ask-citation-full')!;
    expect(full.hidden).toBe(true);
    act(() => citations.querySelector('summary')!.click());
    act(() => citations.querySelector('button')!.click());
    expect(full.hidden).toBe(false);
    expect(full.textContent?.trim()).toBe(quote);
  });

  it('小标和浮层不执行原始HTML或危险链接，正常外链仍安全打开', () => {
    act(() => root.render(<AskMarkdown sourceTitle={'<img src=x onerror=alert(1)>'} content={'结论[^1]。[来源](https://example.com)\n\n[^1]: 引文 [危险](javascript:alert(1)) <script>alert(1)</script>'} />));
    act(() => badge().click());
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    const external = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!;
    expect(external.target).toBe('_blank'); expect(external.rel).toBe('noopener noreferrer');
    act(() => window.dispatchEvent(new Event('blur')));
    expect(popup()).toBeNull();
  });

  it('普通答案和未引用的定义不出现空小标或引用栏', () => {
    act(() => root.render(<AskMarkdown content={'1. 风险分\n2. 置信度\n3. 业务价值\n\n[^unused]: 未使用的原文。'} />));
    expect(container.querySelector('.ask-citations')).toBeNull();
    expect(container.querySelector('.ask-citation-badge')).toBeNull();
    expect(container.querySelectorAll('ol li')).toHaveLength(3);
    expect(container.textContent).toContain('业务价值');
    expect(container.textContent).not.toContain('未使用的原文');
  });
});
