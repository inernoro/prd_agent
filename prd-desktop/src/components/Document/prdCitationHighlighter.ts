import type { DocCitation } from '../../types';

const cssEscape = (raw: string) => {
  const w = window as any;
  if (w?.CSS?.escape) return w.CSS.escape(raw);
  return raw.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
};

const normalizeExcerptForMatch = (t: string) => {
  const s = String(t || '').replace(/…/g, '').trim();
  return s.length > 0 ? s : '';
};

const normalizeLoose = (raw: string) => {
  const s = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s.replace(/[\p{P}\p{S}]+/gu, '');
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

const highlightBlockFallback = (container: HTMLElement, excerpt: string, citationIdx: number) => {
  const needle = normalizeExcerptForMatch(excerpt);
  if (!needle) return false;

  const key = needle.length > 28 ? needle.slice(0, 28) : needle;
  const keyLoose = normalizeLoose(key);
  if (!keyLoose) return false;

  const blocks = Array.from(container.querySelectorAll('p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6')) as HTMLElement[];
  for (const block of blocks) {
    if (block.closest('pre,code')) continue;
    const tLoose = normalizeLoose(block.textContent || '');
    if (!tLoose) continue;
    if (!tLoose.includes(keyLoose)) continue;

    block.setAttribute('data-prd-citation-block', '1');
    block.setAttribute('data-citation-idx', String(citationIdx));
    block.style.backgroundColor = 'rgba(250, 204, 21, 0.22)';
    block.style.borderRadius = '10px';
    block.style.padding = '2px 4px';
    return true;
  }

  return false;
};

const highlightFuzzyFallback = (container: HTMLElement, excerpt: string, citationIdx: number) => {
  const needle = normalizeExcerptForMatch(excerpt);
  if (!needle) return false;
  const e = normalizeLoose(needle);
  if (!e || e.length < 10) return false;

  const windowLen = Math.min(16, Math.max(10, Math.floor(e.length / 4)));
  const picks = new Set<string>();
  const steps = Math.min(6, Math.max(2, Math.floor(e.length / windowLen)));
  for (let i = 0; i < steps; i += 1) {
    const start = Math.floor((i * (e.length - windowLen)) / Math.max(1, steps - 1));
    const seg = e.slice(start, start + windowLen);
    if (seg.length >= 10) picks.add(seg);
  }
  const segs = Array.from(picks);
  if (segs.length === 0) return false;

  const blocks = Array.from(container.querySelectorAll('p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6')) as HTMLElement[];
  let best: { el: HTMLElement; score: number } | null = null;
  for (const block of blocks) {
    if (block.closest('pre,code')) continue;
    const t = normalizeLoose(block.textContent || '');
    if (!t || t.length < 10) continue;
    let score = 0;
    for (const seg of segs) {
      if (t.includes(seg)) score += 1;
    }
    if (score <= 0) continue;
    if (!best || score > best.score) best = { el: block, score };
    if (best && best.score >= segs.length) break;
  }

  if (!best || best.score < 2) return false;

  best.el.setAttribute('data-prd-citation-block', '1');
  best.el.setAttribute('data-citation-idx', String(citationIdx));
  best.el.style.backgroundColor = 'rgba(250, 204, 21, 0.18)';
  best.el.style.borderRadius = '10px';
  best.el.style.padding = '2px 4px';
  return true;
};

export function applyHighlights(args: {
  container: HTMLElement;
  citations: DocCitation[];
  resolveHeadingIdForNav: (opts: { headingId?: string | null; headingTitle?: string | null }) => string | null;
}) {
  const { container, citations, resolveHeadingIdForNav } = args;
  clearHighlights(container);

  const list = (citations ?? []).slice(0, 30);
  const failed: number[] = [];

  const highlightHeadingFallback = (citation: DocCitation, citationIdx: number) => {
    const hid = (citation?.headingId || '').trim();
    const htitle = (citation?.headingTitle || '').trim();
    const resolved = resolveHeadingIdForNav({ headingId: hid || null, headingTitle: htitle || null });
    if (!resolved) return false;
    const el = container.querySelector(`#${cssEscape(resolved)}`) as HTMLElement | null;
    if (!el) return false;
    el.setAttribute('data-prd-citation-block', '1');
    el.setAttribute('data-citation-idx', String(citationIdx));
    el.style.backgroundColor = 'rgba(250, 204, 21, 0.18)';
    el.style.borderRadius = '10px';
    el.style.padding = '2px 4px';
    return true;
  };

  list.forEach((c, idx) => {
    if (!c?.excerpt) {
      const hitHeading = highlightHeadingFallback(c, idx);
      if (!hitHeading) failed.push(idx);
      return;
    }
    if (highlightOne(container, c.excerpt, idx)) return;
    if (highlightBlockFallback(container, c.excerpt, idx)) return;
    if (highlightFuzzyFallback(container, c.excerpt, idx)) return;
    if (highlightHeadingFallback(c, idx)) return;
    failed.push(idx);
  });

  return { failed };
}

export function focusCitation(args: {
  container: HTMLElement;
  citationIdx: number;
  citations: DocCitation[];
  resolveHeadingIdForNav: (opts: { headingId?: string | null; headingTitle?: string | null }) => string | null;
  scrollToHeading: (headingId: string) => void;
  /** 当 citation 自身无法定位/解析时，用该 headingId 作为最后兜底（例如“从聊天点击依据”进入预览页）。 */
  fallbackHeadingId?: string | null;
}) {
  const { container, citationIdx, citations, resolveHeadingIdForNav, scrollToHeading, fallbackHeadingId } = args;
  const idx = Math.max(0, citationIdx);
  const esc = cssEscape(String(idx));
  const target = container.querySelector(`mark[data-prd-citation="1"][data-citation-idx="${esc}"]`) as HTMLElement | null;
  const blockTarget = container.querySelector(`[data-prd-citation-block="1"][data-citation-idx="${esc}"]`) as HTMLElement | null;

  if (!target && !blockTarget) {
    const c = Array.isArray(citations) ? citations[idx] : null;
    const hid = (c?.headingId || '').trim();
    const htitle = (c?.headingTitle || '').trim();
    const resolved = resolveHeadingIdForNav({ headingId: hid || null, headingTitle: htitle || null });
    if (resolved) scrollToHeading(resolved);
    else if (fallbackHeadingId) scrollToHeading(fallbackHeadingId);
    return;
  }

  const chosen = (target || blockTarget)!;
  Array.from(container.querySelectorAll('mark[data-prd-citation="1"]')).forEach((m) => {
    (m as HTMLElement).style.outline = '';
  });
  Array.from(container.querySelectorAll('[data-prd-citation-block="1"]')).forEach((m) => {
    (m as HTMLElement).style.outline = '';
  });
  chosen.style.outline = '2px solid rgba(59,130,246,0.75)';
  chosen.style.outlineOffset = '2px';

  const containerRect = container.getBoundingClientRect();
  const elRect = chosen.getBoundingClientRect();
  const top = container.scrollTop + (elRect.top - containerRect.top) - Math.max(12, (container.clientHeight / 2 - elRect.height / 2));
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

export function resolveHeadingIdForNavFromContainer(args: {
  container: HTMLElement;
  headingId?: string | null;
  headingTitle?: string | null;
}) {
  const { container } = args;
  const rawId = (args.headingId || '').trim();
  const rawTitle = (args.headingTitle || '').trim();
  const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];

  const normalizeHeadingTextForMatch = (t: string) => {
    const s = String(t || '')
      .replace(/\s+/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
    return s.replace(/[\p{P}\p{S}]+/gu, '');
  };

  if (rawId) {
    const exact = headings.find((h) => (h.id || '').trim() === rawId);
    if (exact?.id) return exact.id;
  }

  const needle = normalizeHeadingTextForMatch(rawTitle || rawId);
  if (needle) {
    for (const h of headings) {
      const t = normalizeHeadingTextForMatch(h.textContent || '');
      if (!t) continue;
      if (t === needle) return (h.id || '').trim() || null;
    }
    for (const h of headings) {
      const t = normalizeHeadingTextForMatch(h.textContent || '');
      if (!t) continue;
      if (t.includes(needle) || needle.includes(t)) {
        const id = (h.id || '').trim();
        if (id) return id;
      }
    }
  }

  return null;
}


