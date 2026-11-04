// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskMarkdown } from './AskMarkdown';

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('问答原文脚注', () => {
  it('长引文默认折叠，点击上标只显示短摘录，完整片段由读者主动展开', () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const quote = '原文开头。' + '用于核对的原文内容。'.repeat(70) + '仅适用于已审核订单。';
    act(() => root?.render(<AskMarkdown content={`结论[^1]。\n\n[^1]: ${quote}`} />));
    const citations = container.querySelector<HTMLDetailsElement>('.ask-citations')!;
    expect(citations.open).toBe(false);
    expect(citations.querySelector('summary')?.textContent).toBe('引用 · 1');
    const ref = container.querySelector<HTMLAnchorElement>('sup a')!;
    expect(ref.textContent).toBe('[1]');
    const note = citations.querySelector<HTMLElement>('.ask-citation-note')!;
    const preview = note.querySelector<HTMLElement>('.ask-citation-preview')!;
    const full = note.querySelector<HTMLElement>('.ask-citation-full')!;
    expect(Array.from(preview.textContent ?? '').length).toBeLessThanOrEqual(161);
    expect(preview.textContent).toMatch(/…$/);
    expect(full.hidden).toBe(true);
    act(() => ref.click());
    expect(citations.open).toBe(true);
    expect(document.activeElement).toBe(note);
    expect(full.hidden).toBe(true);
    act(() => note.querySelector('button')!.click());
    expect(full.hidden).toBe(false);
    expect(preview.hidden).toBe(true);
    expect(full.textContent?.trim()).toBe(quote);
    act(() => note.querySelector('button')!.click());
    expect(full.hidden).toBe(true);
    expect(preview.hidden).toBe(false);
  });

  it('多来源定位到指定条目，重复引用可分别返回各个位置', () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    act(() => root?.render(<AskMarkdown content={'第一条[^1]。第二条[^2]。再次引用[^2]。\n\n[^1]: 第一处原文。\n\n[^2]: 第二处原文。'} />));
    const refs = container.querySelectorAll<HTMLAnchorElement>('sup a');
    const citations = container.querySelector<HTMLDetailsElement>('.ask-citations')!;
    expect(citations.querySelector('summary')?.textContent).toBe('引用 · 2');
    act(() => refs[2].click());
    const notes = citations.querySelectorAll<HTMLElement>('.ask-citation-note');
    expect(document.activeElement).toBe(notes[1]);
    const back = notes[1].querySelectorAll<HTMLAnchorElement>('.ask-citation-actions a');
    expect(back.length).toBe(2);
    act(() => back[1].click());
    expect(document.activeElement).toBe(refs[2]);
    act(() => citations.querySelector('summary')!.click());
    expect(citations.open).toBe(false);
    act(() => refs[0].click());
    expect(citations.open).toBe(true);
    expect(document.activeElement).toBe(notes[0]);
  });

  it('普通答案和未引用的定义不出现空引用栏，正文列表保持展开', () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    act(() => root?.render(<AskMarkdown content={'1. 风险分\n2. 置信度\n3. 业务价值\n\n[^unused]: 未使用的原文。'} />));
    expect(container.querySelector('.ask-citations')).toBeNull();
    expect(container.querySelectorAll('ol li')).toHaveLength(3);
    expect(container.textContent).toContain('业务价值');
    expect(container.textContent).not.toContain('未使用的原文');
  });

  it('多条回答的同号脚注各自跳转和返回，不改变应用路由', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const content = '结论[^1]。再次引用[^1]。\n\n[^1]: 原文条件。';
    act(() => root?.render(<><AskMarkdown content={content} /><AskMarkdown content={content} /></>));
    const answers = container.querySelectorAll('.ask-md');
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hash = window.location.hash;
    for (const answer of answers) {
      const ref = answer.querySelector<HTMLAnchorElement>('sup a')!;
      const target = answer.querySelector<HTMLElement>(`[id="${ref.hash.slice(1)}"]`)!;
      expect(target.textContent).toContain('原文条件。');
      expect(ref.target).toBe('');
      act(() => ref.click());
      expect(document.activeElement).toBe(target);
      expect(window.location.hash).toBe(hash);
      const back = target.querySelector<HTMLAnchorElement>('a')!;
      act(() => back.click());
      expect(document.activeElement).toBe(ref);
      expect(answer.querySelector('[id$="footnote-label"]')?.textContent).toBe('引用原文');
    }
    expect(scroll).toHaveBeenCalledTimes(4);
  });

  it('脚注不能执行原始HTML或危险链接，外链仍在新窗口打开', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<AskMarkdown content={'结论[^1]。[来源](https://example.com)\n\n[^1]: 引文 [危险](javascript:alert(1)) <script>alert(1)</script>'} />));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    const external = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!;
    expect(external.target).toBe('_blank');
    expect(external.rel).toBe('noopener noreferrer');
  });
});
