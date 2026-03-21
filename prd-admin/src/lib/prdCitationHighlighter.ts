/**
 * PRD 引用高亮工具：在 PRD 预览内容中标记 AI 引用的文本片段。
 * 从 prd-desktop 移植，去除 Tauri 依赖。
 */
import type { DocCitation } from '@/stores/prdPreviewNavStore';

const normalizeExcerptForMatch = (t: string) => {
  const s = String(t || '').replace(/…/g, '').trim();
  return s.length > 0 ? s : '';
};

export function clearHighlights(container: HTMLElement) {
  const marks = Array.from(container.querySelectorAll('mark[data-prd-citation="1"]'));
  marks.forEach((m) => {
    const el = m as HTMLElement;
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });

  const blocks = Array.from(container.querySelectorAll('[data-prd-citation-block="1"]')) as HTMLElement[];
  blocks.forEach((b) => {
    b.removeAttribute('data-prd-citation-block');
    b.removeAttribute('data-citation-idx');
    b.style.backgroundColor = '';
    b.style.borderRadius = '';
    b.style.padding = '';
    b.style.outline = '';
    b.style.outlineOffset = '';
  });
}

const highlightOne = (container: HTMLElement, excerpt: string, citationIdx: number) => {
  const needle = normalizeExcerptForMatch(excerpt);
  if (!needle) return false;

  const key = needle.length > 36 ? needle.slice(0, 36) : needle;
  const blocks = Array.from(container.querySelectorAll('p,li,blockquote,td,th')) as HTMLElement[];
  for (const block of blocks) {
    if (block.closest('pre,code')) continue;
    const keyLower = key.toLowerCase();
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (!n.nodeValue) continue;
      if ((n.parentElement as HTMLElement | null)?.closest('mark[data-prd-citation="1"]')) continue;

      const v = n.nodeValue;
      const idx = v.toLowerCase().indexOf(keyLower);
      if (idx < 0) continue;

      const before = v.slice(0, idx);
      const mid = v.slice(idx, idx + key.length);
      const after = v.slice(idx + key.length);

      const mark = document.createElement('mark');
      mark.setAttribute('data-prd-citation', '1');
      mark.setAttribute('data-citation-idx', String(citationIdx));
      mark.style.backgroundColor = 'rgba(250, 204, 21, 0.55)';
      mark.style.borderRadius = '6px';
      mark.style.padding = '0 2px';
      mark.textContent = mid;

      const parent = n.parentNode;
      if (!parent) break;
      if (before) parent.insertBefore(document.createTextNode(before), n);
      parent.insertBefore(mark, n);
      if (after) parent.insertBefore(document.createTextNode(after), n);
      parent.removeChild(n);
      return true;
    }
  }
  return false;
};

export function applyHighlights(args: {
  container: HTMLElement;
  citations: DocCitation[];
  resolveHeadingIdForNav: (a: { headingId?: string | null; headingTitle?: string | null }) => string | null;
}) {
  const { container, citations } = args;
  clearHighlights(container);
  if (!citations || citations.length === 0) return;

  for (let i = 0; i < citations.length; i++) {
    const c = citations[i];
    if (c.excerpt) {
      highlightOne(container, c.excerpt, i);
    }
  }
}

export function focusCitation(args: {
  container: HTMLElement;
  citationIdx: number;
  citations: DocCitation[];
  resolveHeadingIdForNav: (a: { headingId?: string | null; headingTitle?: string | null }) => string | null;
  scrollToHeading: (id: string) => void;
  fallbackHeadingId?: string | null;
}) {
  const { container, citationIdx, citations, resolveHeadingIdForNav, scrollToHeading, fallbackHeadingId } = args;

  // 先尝试 scroll 到 mark 元素
  const mark = container.querySelector(`mark[data-citation-idx="${citationIdx}"]`) as HTMLElement | null;
  if (mark) {
    const containerRect = container.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const top = container.scrollTop + (markRect.top - containerRect.top) - 60;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });

    // 闪烁效果
    mark.style.backgroundColor = 'rgba(250, 204, 21, 0.85)';
    setTimeout(() => {
      mark.style.backgroundColor = 'rgba(250, 204, 21, 0.55)';
    }, 600);
    return;
  }

  // 没有 mark，尝试 scroll 到 heading
  const c = citations[citationIdx];
  if (c) {
    const resolved = resolveHeadingIdForNav({ headingId: c.headingId, headingTitle: c.headingTitle });
    if (resolved) {
      scrollToHeading(resolved);
      return;
    }
  }

  if (fallbackHeadingId) {
    scrollToHeading(fallbackHeadingId);
  }
}
