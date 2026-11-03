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
