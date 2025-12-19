import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { listen } from '../../lib/tauri';
import type { ApiResponse, DocCitation, DocumentContent } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';
import PrdCommentsPanel from '../Comments/PrdCommentsPanel';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import PrdSectionAskPanel from './PrdSectionAskPanel';

export default function PrdPreviewPage() {
  const { documentLoaded, document: prdDocument, activeGroupId, backFromPrdPreview, sessionId, setRole, currentRole } = useSessionStore();
  const { addMessage } = useMessageStore();

  const [prdPreviewLoading, setPrdPreviewLoading] = useState(false);
  const [prdPreviewError, setPrdPreviewError] = useState('');
  const [prdPreviewTocOpen, setPrdPreviewTocOpen] = useState(true);
  const [prdPreviewCommentsOpen, setPrdPreviewCommentsOpen] = useState(true);
  const [prdPreview, setPrdPreview] = useState<null | { documentId: string; title: string; content: string }>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeHeadingTitle, setActiveHeadingTitle] = useState<string | null>(null);
  const [tocItems, setTocItems] = useState<Array<{ id: string; text: string; level: number }>>([]);
  const [highlightReady, setHighlightReady] = useState(false);
  const [isCitationExcerptExpanded, setIsCitationExcerptExpanded] = useState(false);
  const prdPreviewContentRef = useRef<HTMLDivElement>(null);
  const headingsRef = useRef<Array<{ id: string; el: HTMLElement; title: string; top: number }>>([]);
  const scrollRafRef = useRef<number | null>(null);
  // 三栏可拖拽
  const [tocWidth, setTocWidth] = useState<number>(288); // w-72
  const [commentsWidth, setCommentsWidth] = useState<number>(320); // w-80
  const [isResizing, setIsResizing] = useState<null | 'toc' | 'comments'>(null);
  const resizeRef = useRef<{ startX: number; startToc: number; startComments: number } | null>(null);

  // 划词提问
  const [selectionToolbar, setSelectionToolbar] = useState<null | { x: number; y: number; text: string }>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askDraft, setAskDraft] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState('');
  const askMessageIdRef = useRef<string | null>(null);

  // 引用跳转与标黄
  const navTargetHeadingId = usePrdPreviewNavStore((s) => s.targetHeadingId);
  const navTargetHeadingTitle = usePrdPreviewNavStore((s) => s.targetHeadingTitle);
  const navCitations = usePrdPreviewNavStore((s) => s.citations);
  const navActiveIndex = usePrdPreviewNavStore((s) => s.activeCitationIndex);
  const setNavActiveIndex = usePrdPreviewNavStore((s) => s.setActiveCitationIndex);
  const consumeNavTarget = usePrdPreviewNavStore((s) => s.consumeTarget);
  const clearNav = usePrdPreviewNavStore((s) => s.clear);

  const canPreview = useMemo(() => {
    return Boolean(documentLoaded && prdDocument && activeGroupId);
  }, [activeGroupId, prdDocument, documentLoaded]);

  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

  const beginResize = (kind: 'toc' | 'comments', e: React.PointerEvent<HTMLDivElement>) => {
    // 仅主键拖拽
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(kind);
    resizeRef.current = { startX: e.clientX, startToc: tocWidth, startComments: commentsWidth };
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    try {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } catch {
      // ignore
    }
  };

  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    const s = resizeRef.current;
    if (!s) return;
    const delta = e.clientX - s.startX;
    // 约束范围：避免过小/过大
    const min = 200;
    const max = 520;
    if (isResizing === 'toc') {
      setTocWidth(clamp(s.startToc + delta, min, max));
    } else {
      // 右侧拖拽：向左拖增大 comments 宽度
      setCommentsWidth(clamp(s.startComments - delta, min, max));
    }
  };

  const endResize = () => {
    if (!isResizing) return;
    setIsResizing(null);
    resizeRef.current = null;
    try {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!canPreview || !prdDocument || !activeGroupId) return;
    if (prdPreview?.documentId === prdDocument.id && prdPreview.content) return;

    let cancelled = false;
    const run = async () => {
      setPrdPreviewError('');
      try {
        setPrdPreviewLoading(true);
        const resp = await invoke<ApiResponse<DocumentContent>>('get_document_content', {
          documentId: prdDocument.id,
          groupId: activeGroupId,
        });
        if (cancelled) return;
        if (!resp.success || !resp.data) {
          setPrdPreviewError(resp.error?.message || '获取 PRD 内容失败');
          return;
        }
        setPrdPreview({ documentId: resp.data.id, title: resp.data.title, content: resp.data.content || '' });
      } catch {
        if (cancelled) return;
        setPrdPreviewError('获取 PRD 内容失败');
      } finally {
        if (!cancelled) setPrdPreviewLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPreview, prdDocument?.id, activeGroupId]);

  // 注意：PrdPreviewPage 在 mode !== 'PrdPreview' 时会卸载（见 App.tsx），所以初始 state 已足够作为“进入页重置”。
  // 若在 mount 后再强制重置，会与用户的首次目录点击产生竞态，表现为“需要点两次/右侧不更新/不滚动”。

  // 切换文档/群组时：清空引用导航，避免跨文档残留高亮
  // 注意：不要在首次 mount 就清空，否则会与“从聊天点击依据 -> 打开预览并跳转”产生竞态，导致永远跳不到目标章节。
  const lastDocGroupRef = useRef<{ docId: string | null; groupId: string | null } | null>(null);
  useEffect(() => {
    const cur = { docId: prdDocument?.id ?? null, groupId: activeGroupId ?? null };
    const prev = lastDocGroupRef.current;
    lastDocGroupRef.current = cur;
    if (!prev) return;
    if (prev.docId !== cur.docId || prev.groupId !== cur.groupId) {
      clearNav();
    }
  }, [prdDocument?.id, activeGroupId, clearNav]);

  const tocIndentClass = (level: number) => {
    switch (level) {
      case 1: return 'pl-2';
      case 2: return 'pl-4';
      case 3: return 'pl-6';
      case 4: return 'pl-8';
      case 5: return 'pl-10';
      default: return 'pl-12';
    }
  };

  const scrollToHeading = (id: string) => {
    const container = prdPreviewContentRef.current;
    if (!container) return;
    const esc = (window as any).CSS?.escape ? (window as any).CSS.escape(id) : id.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
    const tryScroll = (attempt: number) => {
      const el = container.querySelector(`#${esc}`) as HTMLElement | null;
      if (!el) {
        // 首次进入预览页时，markdown 渲染与布局（尤其是代码块/mermaid）可能尚未稳定，
        // 目录点击会出现“要点两次才跳”的错觉；这里做少量 rAF 重试兜底。
        if (attempt < 2) requestAnimationFrame(() => tryScroll(attempt + 1));
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const top = container.scrollTop + (elRect.top - containerRect.top) - 12;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    };
    tryScroll(0);
  };

  const resolveHeadingIdForNav = useCallback((args: { headingId?: string | null; headingTitle?: string | null }) => {
    const container = prdPreviewContentRef.current;
    if (!container) return null;

    const stripInlineMarkdownLike = (raw: string) => {
      let s = String(raw || '');
      if (!s) return '';
      // images: ![alt](url) -> alt
      s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
      // links: [text](url) -> text
      s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      // inline code
      s = s.replace(/`([^`]+)`/g, '$1');
      // emphasis/bold (多轮覆盖简单嵌套)
      for (let i = 0; i < 2; i += 1) {
        s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
        s = s.replace(/__([^_]+)__/g, '$1');
        s = s.replace(/\*([^*]+)\*/g, '$1');
        s = s.replace(/_([^_]+)_/g, '$1');
      }
      // html tags
      s = s.replace(/<[^>]+>/g, '');
      // escaped markdown chars
      s = s.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
      return s;
    };

    const normalizeHeadingTextForMatch = (raw: string) => {
      let s = stripInlineMarkdownLike(raw);
      // 与 MarkdownRenderer 保持一致：去掉尾部 "###" 等
      s = s.replace(/\s+#+\s*$/, '').trim();
      s = s.replace(/\s+/g, ' ');
      return s;
    };

    const looseKey = (raw: string) => {
      // 更宽松的匹配 key：去空白+去常见标点，解决“全角/半角/括号/冒号”等差异
      const s = normalizeHeadingTextForMatch(raw);
      if (!s) return '';
      return s
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '') // 标点/符号
        .trim();
    };

    const rawId = (args.headingId || '').trim();
    const rawTitle = (args.headingTitle || '').trim();

    const normalizeId = (id: string) => {
      const s = String(id || '').trim();
      if (!s) return '';
      return s.startsWith('#') ? s.slice(1) : s;
    };

    const safeDecode = (id: string) => {
      try {
        return decodeURIComponent(id);
      } catch {
        return id;
      }
    };

    const tryFindId = (id: string) => {
      const norm = normalizeId(id);
      if (!norm) return null;
      const esc = (window as any).CSS?.escape
        ? (window as any).CSS.escape(norm)
        : norm.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
      const el = container.querySelector(`#${esc}`) as HTMLElement | null;
      return el ? norm : null;
    };

    // 1) 优先按传入 headingId 精确匹配
    if (rawId) {
      // 尝试多种等价形式（避免 #、编码、大小写、空白等差异）
      const candidates = [
        rawId,
        normalizeId(rawId),
        safeDecode(rawId),
        normalizeId(safeDecode(rawId)),
        safeDecode(rawId).toLowerCase(),
        normalizeId(safeDecode(rawId).toLowerCase()),
      ].filter(Boolean);

      for (const c of candidates) {
        const hit = tryFindId(c);
        if (hit) return hit;
      }
    }

    // 2) 兜底：按 headingTitle 匹配渲染出来的真实标题文本（避免后端 slug 算法不同导致跳转失败）
    if (rawTitle) {
      const needle = normalizeHeadingTextForMatch(rawTitle);
      if (!needle) return null;
      const needleLoose = looseKey(rawTitle);
      const hs = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
      for (const h of hs) {
        const text = normalizeHeadingTextForMatch(h.textContent || '');
        if (text && text === needle) {
          const id = (h.id || '').trim();
          if (id) return id;
        }
      }

      // 3) 宽松匹配：去标点/去空白（适配 “：”“-”“（）” 等差异）
      if (needleLoose) {
        for (const h of hs) {
          const t2 = h.textContent || '';
          const key = looseKey(t2);
          if (key && key === needleLoose) {
            const id = (h.id || '').trim();
            if (id) return id;
          }
        }
      }

      // 4) 退一步：包含匹配（避免标题前后多了编号/前缀）
      for (const h of hs) {
        const t2 = normalizeHeadingTextForMatch(h.textContent || '');
        if (!t2) continue;
        if (t2.includes(needle) || needle.includes(t2)) {
          const id = (h.id || '').trim();
          if (id) return id;
        }
      }
    }

    return null;
  }, []);

  const clearHighlights = useCallback(() => {
    const container = prdPreviewContentRef.current;
    if (!container) return;
    const marks = Array.from(container.querySelectorAll('mark[data-prd-citation="1"]'));
    marks.forEach((m) => {
      const el = m as HTMLElement;
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });

    // 清理“块级高亮”（当无法精确包裹文本时的兜底方案）
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
  }, []);

  const normalizeExcerptForMatch = (t: string) => {
    // 不要折叠空白：我们需要字符偏移与 TextNode 对齐
    const s = String(t || '').replace(/…/g, '').trim();
    return s.length > 0 ? s : '';
  };

  const highlightOne = useCallback((excerpt: string, citationIdx: number) => {
    const container = prdPreviewContentRef.current;
    if (!container) return false;
    const needle = normalizeExcerptForMatch(excerpt);
    if (!needle) return false;

    // 避免超长匹配：截断到 80，减少误跨节点
    // 为了避免跨节点导致包裹失败，这里刻意用更短的 key（允许多标黄/略模糊）
    const key = needle.length > 36 ? needle.slice(0, 36) : needle;

    // 优先在常见文本块内匹配，避免跨段落
    const blocks = Array.from(container.querySelectorAll('p,li,blockquote,td,th')) as HTMLElement[];
    for (const block of blocks) {
      // 跳过代码块内部
      if (block.closest('pre,code')) continue;

      const keyLower = key.toLowerCase();
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode as Text;
        if (!n.nodeValue) continue;
        // 避免重复在已经标黄的内容里再标黄
        if ((n.parentElement as HTMLElement | null)?.closest('mark[data-prd-citation=\"1\"]')) continue;

        const v = n.nodeValue;
        const idx = v.toLowerCase().indexOf(keyLower);
        if (idx < 0) continue;

        const before = v.slice(0, idx);
        const mid = v.slice(idx, idx + key.length);
        const after = v.slice(idx + key.length);

        const mark = document.createElement('mark');
        mark.setAttribute('data-prd-citation', '1');
        mark.setAttribute('data-citation-idx', String(citationIdx));
        mark.style.backgroundColor = 'rgba(250, 204, 21, 0.55)'; // yellow-400-ish
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
  }, [normalizeExcerptForMatch]);

  const normalizeLoose = (raw: string) => {
    const s = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    // 去掉常见标点/符号（提高跨节点/格式差异的命中率）
    return s.replace(/[\p{P}\p{S}]+/gu, '');
  };

  const highlightBlockFallback = useCallback((excerpt: string, citationIdx: number) => {
    const container = prdPreviewContentRef.current;
    if (!container) return false;
    const needle = normalizeExcerptForMatch(excerpt);
    if (!needle) return false;

    // 更短的 key，避免误匹配；同时做“宽松归一化”以跨越 inline markdown 分割节点的问题
    const key = needle.length > 28 ? needle.slice(0, 28) : needle;
    const keyLoose = normalizeLoose(key);
    if (!keyLoose) return false;

    const blocks = Array.from(container.querySelectorAll('p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6')) as HTMLElement[];
    for (const block of blocks) {
      if (block.closest('pre,code')) continue;
      const text = block.textContent || '';
      const tLoose = normalizeLoose(text);
      if (!tLoose) continue;
      if (!tLoose.includes(keyLoose)) continue;

      // 使用块级高亮：不破坏 DOM 结构（避免跨节点包裹的复杂度）
      block.setAttribute('data-prd-citation-block', '1');
      block.setAttribute('data-citation-idx', String(citationIdx));
      block.style.backgroundColor = 'rgba(250, 204, 21, 0.22)'; // 更淡一些，避免影响阅读
      block.style.borderRadius = '10px';
      block.style.padding = '2px 4px';
      return true;
    }

    return false;
  }, [normalizeExcerptForMatch]);

  const highlightFuzzyFallback = useCallback((excerpt: string, citationIdx: number) => {
    const container = prdPreviewContentRef.current;
    if (!container) return false;
    const needle = normalizeExcerptForMatch(excerpt);
    if (!needle) return false;

    const e = normalizeLoose(needle);
    if (!e || e.length < 10) return false;

    // 取多个窗口片段，做“包含计分”，避免必须完整子串
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
      // 快速退出：满分不必继续
      if (best && best.score >= segs.length) break;
    }

    // 至少命中 2 个片段才认为可靠
    if (!best || best.score < 2) return false;

    best.el.setAttribute('data-prd-citation-block', '1');
    best.el.setAttribute('data-citation-idx', String(citationIdx));
    best.el.style.backgroundColor = 'rgba(250, 204, 21, 0.18)';
    best.el.style.borderRadius = '10px';
    best.el.style.padding = '2px 4px';
    return true;
  }, [normalizeExcerptForMatch]);

  const highlightHeadingFallback = useCallback((citation: DocCitation, citationIdx: number) => {
    const container = prdPreviewContentRef.current;
    if (!container) return false;
    const hid = (citation?.headingId || '').trim();
    const htitle = (citation?.headingTitle || '').trim();
    const resolved = resolveHeadingIdForNav({ headingId: hid || null, headingTitle: htitle || null });
    if (!resolved) return false;
    const esc = (window as any).CSS?.escape
      ? (window as any).CSS.escape(resolved)
      : resolved.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
    const el = container.querySelector(`#${esc}`) as HTMLElement | null;
    if (!el) return false;
    // 只高亮 heading 节点（视觉更稳定），并复用 block 高亮属性供 focusActiveCitation 使用
    el.setAttribute('data-prd-citation-block', '1');
    el.setAttribute('data-citation-idx', String(citationIdx));
    el.style.backgroundColor = 'rgba(250, 204, 21, 0.18)';
    el.style.borderRadius = '10px';
    el.style.padding = '2px 4px';
    return true;
  }, [resolveHeadingIdForNav]);

  const applyHighlights = useCallback((citations: DocCitation[]) => {
    clearHighlights();
    const list = (citations ?? []).slice(0, 30);
    let ok = 0;
    let okBlock = 0;
    let okFuzzy = 0;
    let okHeading = 0;
    const failed: number[] = [];
    list.forEach((c, idx) => {
      if (!c?.excerpt) {
        // 没 excerpt 仍然尝试用章节标题兜底标黄
        const hitHeading = highlightHeadingFallback(c, idx);
        if (hitHeading) okHeading += 1;
        else failed.push(idx);
        return;
      }
      const hit = highlightOne(c.excerpt, idx);
      if (hit) {
        ok += 1;
        return;
      }
      const hitBlock = highlightBlockFallback(c.excerpt, idx);
      if (hitBlock) {
        okBlock += 1;
        return;
      }
      const hitFuzzy = highlightFuzzyFallback(c.excerpt, idx);
      if (hitFuzzy) {
        okFuzzy += 1;
        return;
      }
      const hitHeading = highlightHeadingFallback(c, idx);
      if (hitHeading) {
        okHeading += 1;
        return;
      }
      failed.push(idx);
    });
    setHighlightReady(true);
  }, [clearHighlights, highlightOne, highlightBlockFallback, highlightFuzzyFallback, highlightHeadingFallback]);

  const focusActiveCitation = useCallback(() => {
    const container = prdPreviewContentRef.current;
    if (!container) return;
    const idx = navActiveIndex ?? 0;
    const esc = (window as any).CSS?.escape ? (window as any).CSS.escape(String(idx)) : String(idx).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
    const target = container.querySelector(`mark[data-prd-citation="1"][data-citation-idx="${esc}"]`) as HTMLElement | null;
    const blockTarget = container.querySelector(`[data-prd-citation-block="1"][data-citation-idx="${esc}"]`) as HTMLElement | null;
    if (!target && !blockTarget) {
      // 兜底：没找到标黄（多为 excerpt 无法定位），至少跳到该引用所属章节，避免“下一条没反应”的体验
      const c = Array.isArray(navCitations) ? navCitations[idx] : null;
      const hid = (c?.headingId || '').trim();
      const htitle = (c?.headingTitle || '').trim();
      const resolved = resolveHeadingIdForNav({ headingId: hid || null, headingTitle: htitle || null });
      if (resolved) scrollToHeading(resolved);
      return;
    }
    const chosen = target || blockTarget;
    // 高亮当前引用：边框更醒目
    Array.from(container.querySelectorAll('mark[data-prd-citation="1"]')).forEach((m) => {
      (m as HTMLElement).style.outline = '';
    });
    Array.from(container.querySelectorAll('[data-prd-citation-block="1"]')).forEach((m) => {
      (m as HTMLElement).style.outline = '';
    });
    chosen!.style.outline = '2px solid rgba(59,130,246,0.75)';
    chosen!.style.outlineOffset = '2px';
    // 不用 scrollIntoView：在某些 WebView/嵌套滚动容器下会触发“滚动到奇怪位置”的乱跳
    const containerRect = container.getBoundingClientRect();
    const elRect = chosen!.getBoundingClientRect();
    const top = container.scrollTop + (elRect.top - containerRect.top) - Math.max(12, (container.clientHeight / 2 - elRect.height / 2));
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [navActiveIndex, navCitations, resolveHeadingIdForNav]);

  const clearSelectionToolbar = () => setSelectionToolbar(null);

  const normalizeSelectionText = (t: string) => {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    // 防止过长导致 UI/请求过大
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  };

  useEffect(() => {
    const container = prdPreviewContentRef.current;
    if (!container) return;

    const onPointerUp = () => {
      try {
        const sel = window.getSelection();
        const raw = sel?.toString() || '';
        const text = normalizeSelectionText(raw);
        if (!text) {
          clearSelectionToolbar();
          return;
        }
        // 只在正文容器内选中才响应
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        if (!range) {
          clearSelectionToolbar();
          return;
        }
        const rect = range.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
          clearSelectionToolbar();
          return;
        }
        // 点击位置：选区右上角偏移一点
        const x = Math.min(window.innerWidth - 16, Math.max(16, rect.right));
        const y = Math.min(window.innerHeight - 16, Math.max(16, rect.top - 8));
        setSelectionToolbar({ x, y, text });
      } catch {
        // ignore
      }
    };

    const onScroll = () => {
      // 滚动时隐藏，避免漂移
      clearSelectionToolbar();
    };

    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('pointerup', onPointerUp as EventListener);
      container.removeEventListener('scroll', onScroll as EventListener);
    };
  }, []);

  const openAskModal = () => {
    if (!selectionToolbar?.text) return;
    setAskOpen(true);
    setAskError('');
    setAskAnswer('');
    // 默认问题：解释含义
    setAskDraft(`这是什么意思：${selectionToolbar.text}`);
  };

  const closeAskModal = () => {
    if (askBusy) return;
    setAskOpen(false);
    setAskDraft('');
    setAskAnswer('');
    setAskError('');
    askMessageIdRef.current = null;
  };

  const sendAskToAi = async () => {
    if (!sessionId) {
      setAskError('当前群组未绑定 PRD，无法提问');
      return;
    }
    const q = askDraft.trim();
    if (!q) return;
    setAskBusy(true);
    setAskError('');
    setAskAnswer('');
    askMessageIdRef.current = null;

    // 让这次问答落在“产品经理-问答”里：切到 PM 视角发起
    // 注意：这里不调用 switch_role（避免打断用户正在查看的角色），仅用于本地显示与 send_message role 参数
    const prevRole = currentRole;
    setRole('PM');

    const userMsgId = `pm-ask-${Date.now()}`;
    addMessage({
      id: userMsgId,
      role: 'User',
      content: q,
      timestamp: new Date(),
      viewRole: 'PM',
    });

    // 监听本次 message-chunk，抓取回答文本用于模态展示
    const unlisten = await listen<any>('message-chunk', (event) => {
      const p = event.payload || {};
      const type = p.type;
      if (type === 'start') {
        // 记录本次 assistant messageId
        askMessageIdRef.current = p.messageId || null;
        return;
      }
      if (type === 'delta' && p.content) {
        setAskAnswer((prev) => prev + String(p.content));
        return;
      }
      if (type === 'blockDelta' && p.content) {
        setAskAnswer((prev) => prev + String(p.content));
        return;
      }
      if (type === 'error') {
        setAskError(p.errorMessage || '请求失败');
        return;
      }
      if (type === 'done') {
        // ignore
        return;
      }
    });

    try {
      await invoke('send_message', { sessionId, content: q, role: 'pm' });
    } catch (e: any) {
      setAskError(e?.message || '请求失败');
    } finally {
      try {
        unlisten();
      } catch {
        // ignore
      }
      // 恢复用户原角色（仅 UI，本地）
      setRole(prevRole);
      setAskBusy(false);
    }
  };

  const rebuildHeadingsCache = useCallback(() => {
    const container = prdPreviewContentRef.current;
    if (!container) return;
    const hs = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
    const baseTop = container.getBoundingClientRect().top;
    headingsRef.current = hs
      .map((h) => {
        const id = h.id || '';
        const title = (h.textContent || '').trim();
        if (!id || !title) return null;
        const top = container.scrollTop + (h.getBoundingClientRect().top - baseTop);
        return { id, el: h, title, top };
      })
      .filter(Boolean) as Array<{ id: string; el: HTMLElement; title: string; top: number }>;
  }, []);

  const updateActiveHeadingFromScroll = useCallback(() => {
    const container = prdPreviewContentRef.current;
    if (!container) return;
    const list = headingsRef.current;
    if (!list || list.length === 0) return;

    // 以容器顶部+阈值为当前阅读位置
    const threshold = 24;
    const y = container.scrollTop + threshold;

    // 找到最后一个 top <= y 的 heading
    let current = list[0];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].top <= y) current = list[i];
      else break;
    }

    if (!current?.id) return;
    setActiveHeadingId((prev) => (prev === current.id ? prev : current.id));
    setActiveHeadingTitle((prev) => (prev === current.title ? prev : current.title));
  }, []);

  const prdPreviewBody = useMemo(() => {
    if (!canPreview) {
      return <div className="text-sm text-text-secondary">请先选择群组并绑定 PRD</div>;
    }
    if (prdPreviewLoading) return <div className="text-sm text-text-secondary">加载中...</div>;
    if (prdPreviewError) return <div className="text-sm text-red-600 dark:text-red-400">{prdPreviewError}</div>;
    return (
      <MarkdownRenderer
        className="prose prose-sm dark:prose-invert max-w-none"
        content={prdPreview?.content || ''}
      />
    );
  }, [canPreview, prdPreview?.content, prdPreviewError, prdPreviewLoading]);

  // 从实际渲染出来的 DOM 中抽取 TOC，保证与 headingId 生成完全一致（避免跳错）
  useEffect(() => {
    if (!canPreview) return;
    if (prdPreviewLoading || prdPreviewError) return;
    const container = prdPreviewContentRef.current;
    if (!container) return;

    const raf = requestAnimationFrame(() => {
      const hs = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
      const items = hs
        .map((h) => {
          const tag = h.tagName.toLowerCase();
          const level = Number(tag.slice(1));
          const id = h.id || '';
          const text = (h.textContent || '').trim();
          if (!id || !text || !Number.isFinite(level)) return null;
          return { id, text, level };
        })
        .filter(Boolean) as Array<{ id: string; text: string; level: number }>;

      setTocItems(items);

      // 默认选中第一个章节（函数式更新避免竞态：若用户已点击目录，不要被默认逻辑覆盖）
      if (items.length > 0) {
        setActiveHeadingId((prev) => (prev ? prev : items[0].id));
        setActiveHeadingTitle((prev) => (prev ? prev : items[0].text));
      }
    });

    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPreview, prdPreviewLoading, prdPreviewError, prdPreview?.content]);

  // 内容渲染完成后：缓存 headings，并绑定 scrollspy
  useEffect(() => {
    const container = prdPreviewContentRef.current;
    if (!container) return;
    if (!canPreview) return;
    if (prdPreviewLoading || prdPreviewError) return;

    // 缓存 headings（使用两次 rAF，确保 markdown 渲染与图片/代码块布局稳定）
    let raf2: number | null = null;
    let pendingRebuildRaf: number | null = null;
    let lateTimer: number | null = null;

    const scheduleRebuild = () => {
      if (pendingRebuildRaf != null) return;
      pendingRebuildRaf = requestAnimationFrame(() => {
        pendingRebuildRaf = null;
        rebuildHeadingsCache();
        updateActiveHeadingFromScroll();
      });
    };

    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        rebuildHeadingsCache();
        updateActiveHeadingFromScroll();
      });
    });

    // 兜底：mermaid/图片等可能在首次渲染后异步改变布局，导致 heading top 缓存失真
    lateTimer = window.setTimeout(() => scheduleRebuild(), 800) as unknown as number;

    // DOM 结构变化（如 mermaid 注入 SVG）触发布局重算
    const mo = new MutationObserver(() => {
      scheduleRebuild();
    });
    try {
      mo.observe(container, { childList: true, subtree: true });
    } catch {
      // ignore
    }

    // 资源加载（图片等）也会改变布局：用捕获阶段监听 load
    const onLoadCapture = (e: Event) => {
      const t = e.target as any;
      const tag = (t?.tagName || '').toUpperCase();
      if (tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'IFRAME') {
        scheduleRebuild();
      }
    };
    container.addEventListener('load', onLoadCapture, true);

    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        updateActiveHeadingFromScroll();
      });
    };

    const onResize = () => {
      // 尺寸变化会影响 heading top，需重建缓存
      rebuildHeadingsCache();
      updateActiveHeadingFromScroll();
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 != null) cancelAnimationFrame(raf2);
      if (pendingRebuildRaf != null) cancelAnimationFrame(pendingRebuildRaf);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
      if (lateTimer != null) window.clearTimeout(lateTimer);
      try {
        mo.disconnect();
      } catch {
        // ignore
      }
      container.removeEventListener('load', onLoadCapture as EventListener, true);
      container.removeEventListener('scroll', onScroll as EventListener);
      window.removeEventListener('resize', onResize);
    };
  }, [canPreview, prdPreviewLoading, prdPreviewError, prdPreview?.content, rebuildHeadingsCache, updateActiveHeadingFromScroll]);

  // 当从聊天/讲解点击“依据”进入预览：跳转并标黄
  useEffect(() => {
    if (!navTargetHeadingId && !navTargetHeadingTitle) return;
    if (!canPreview) return;
    if (prdPreviewLoading || prdPreviewError) return;
    if (!prdPreview?.content) return;

    let cancelled = false;
    let done = false;
    let timer: number | null = null;
    let attempt = 0;
    const delays = [0, 120, 300, 800, 1500];
    let mo: MutationObserver | null = null;

    const tryRunOnce = () => {
      if (cancelled || done) return true;
      const resolved = resolveHeadingIdForNav({ headingId: navTargetHeadingId, headingTitle: navTargetHeadingTitle });
      if (!resolved) return false;
      done = true;
      // 成功后立刻清掉所有后续触发源，避免“目录点击无效/引用下一页乱跳”
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      try {
        mo?.disconnect();
      } catch {
        // ignore
      }
      mo = null;
      scrollToHeading(resolved);
      applyHighlights(navCitations);
      requestAnimationFrame(() => focusActiveCitation());
      // 关键：只“消费掉一次性跳转目标”，保留 citations/activeIndex，
      // 从而避免该 effect 之后因为任何重渲染/索引变化再次把滚动拉回，导致“目录点不动/引用无效/乱跳”。
      consumeNavTarget();
      return true;
    };

    const run = () => {
      if (tryRunOnce()) return;
      // 内容刚渲染/布局未稳定时兜底重试（尤其是长文档 + mermaid/图片）
      attempt += 1;
      if (attempt >= delays.length) return;
      timer = window.setTimeout(() => run(), delays[attempt]) as unknown as number;
    };

    // DOM 变化兜底：mermaid 注入/图片加载/ReactMarkdown 分批渲染都会影响 headings 是否存在
    const container = prdPreviewContentRef.current;
    if (container) {
      try {
        mo = new MutationObserver(() => {
          if (tryRunOnce()) {
            try {
              mo?.disconnect();
            } catch {
              // ignore
            }
            mo = null;
          }
        });
        mo.observe(container, { childList: true, subtree: true });
      } catch {
        mo = null;
      }
    }

    const raf = requestAnimationFrame(() => run());
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer != null) window.clearTimeout(timer);
      try {
        mo?.disconnect();
      } catch {
        // ignore
      }
      mo = null;
    };
  }, [
    navTargetHeadingId,
    navTargetHeadingTitle,
    navCitations,
    canPreview,
    prdPreviewLoading,
    prdPreviewError,
    prdPreview?.content,
    applyHighlights,
    focusActiveCitation,
    resolveHeadingIdForNav,
    consumeNavTarget,
  ]);

  // 仅切换引用索引：聚焦到对应 mark
  useEffect(() => {
    if (!Array.isArray(navCitations) || navCitations.length === 0) return;
    if (!highlightReady) return;
    const raf = requestAnimationFrame(() => focusActiveCitation());
    return () => cancelAnimationFrame(raf);
  }, [navActiveIndex, navCitations?.length, focusActiveCitation, highlightReady]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-12 px-4 border-b border-border bg-surface-light dark:bg-surface-dark flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={backFromPrdPreview}
            className="h-8 px-2 rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors"
            title="返回"
            aria-label="返回"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">PRD 预览</div>
            <div className="text-xs text-text-secondary truncate" title={prdPreview?.title || prdDocument?.title || ''}>
              {prdPreview?.title || prdDocument?.title || ''}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
            onClick={() => setPrdPreviewTocOpen((v) => !v)}
            aria-label="章节目录"
            title="章节目录"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
          </button>

          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
            onClick={() => setPrdPreviewCommentsOpen((v) => !v)}
            aria-label="评论"
            title="评论"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h6m-6 4h8M5 20l-2 2V6a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H7z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <div className="h-full flex min-h-0">
          {/* 左：目录 */}
          {prdPreviewTocOpen ? (
            <div
              className="border-r border-border bg-surface-light dark:bg-surface-dark overflow-auto p-3"
              style={{ width: `${tocWidth}px` }}
            >
              <div className="text-xs font-semibold text-text-secondary px-2 py-1">目录</div>
              <div className="mt-1 space-y-1">
                {tocItems.length > 0 ? (
                  tocItems.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        // 目录点击时先重建 heading 位置缓存，避免 mermaid/代码块等异步渲染导致 scrollspy 章节识别错位
                        rebuildHeadingsCache();
                        setActiveHeadingId(t.id);
                        setActiveHeadingTitle(t.text);
                        scrollToHeading(t.id);
                      }}
                      className={`w-full text-left text-xs rounded-md pr-2 py-1 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors ${tocIndentClass(t.level)} ${
                        activeHeadingId === t.id ? 'text-primary-600 dark:text-primary-300' : 'text-text-secondary hover:text-primary-500'
                      }`}
                      title={t.text}
                    >
                      <span className="block whitespace-normal break-words">{t.text}</span>
                    </button>
                  ))
                ) : (
                  <div className="mt-2 text-xs text-text-secondary px-2">
                    {prdPreviewLoading ? '加载中...' : '未识别到章节标题'}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {/* 拖拽条：目录/正文 */}
          {prdPreviewTocOpen ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整目录宽度"
              className="w-1 cursor-col-resize select-none"
              onPointerDown={(e) => beginResize('toc', e)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onLostPointerCapture={endResize}
              style={{ touchAction: 'none' }}
            >
              <div className="h-full w-full hover:bg-primary-500/10" />
            </div>
          ) : null}

          {/* 中：正文 */}
          <div ref={prdPreviewContentRef} className="flex-1 min-w-0 overflow-auto p-5">
            {prdPreviewBody}
          </div>

          {/* 拖拽条：正文/评论 */}
          {prdPreviewCommentsOpen ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整评论宽度"
              className="w-1 cursor-col-resize select-none"
              onPointerDown={(e) => beginResize('comments', e)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onLostPointerCapture={endResize}
              style={{ touchAction: 'none' }}
            >
              <div className="h-full w-full hover:bg-primary-500/10" />
            </div>
          ) : null}

          {/* 右：评论 */}
          {prdPreviewCommentsOpen ? (
            <div
              className="border-l border-border bg-surface-light dark:bg-surface-dark overflow-hidden"
              style={{ width: `${commentsWidth}px` }}
            >
              <PrdCommentsPanel
                documentId={prdPreview?.documentId || prdDocument?.id || ''}
                groupId={activeGroupId || ''}
                headingId={activeHeadingId}
                headingTitle={activeHeadingTitle}
                onJumpToHeading={(id) => scrollToHeading(id)}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* 引用导航浮层（仅当存在 citations） */}
      {Array.isArray(navCitations) && navCitations.length > 0 ? (
        <div className="fixed z-40 right-4 top-16">
          <div className="bg-surface-light dark:bg-surface-dark border border-border rounded-xl shadow-lg px-3 py-2 w-[320px]">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">
                引用 {Math.min((navActiveIndex ?? 0) + 1, navCitations.length)}/{navCitations.length}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs text-text-secondary hover:text-primary-500"
                  onClick={() => {
                    setIsCitationExcerptExpanded((v) => !v);
                  }}
                  title={isCitationExcerptExpanded ? '收起' : '展开'}
                >
                  {isCitationExcerptExpanded ? '收起' : '展开'}
                </button>
                <button
                  type="button"
                  className="text-xs text-text-secondary hover:text-primary-500"
                  onClick={() => {
                    clearHighlights();
                    clearNav();
                    setIsCitationExcerptExpanded(false);
                  }}
                  title="清除高亮"
                >
                  清除
                </button>
              </div>
            </div>
            <div
              className={`mt-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words ${
                isCitationExcerptExpanded ? 'max-h-[220px] overflow-auto pr-1' : 'line-clamp-3'
              }`}
              title={navCitations[navActiveIndex]?.excerpt || ''}
            >
              {navCitations[navActiveIndex]?.excerpt || ''}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50"
                onClick={() => {
                  setNavActiveIndex((navActiveIndex ?? 0) - 1);
                }}
                disabled={!highlightReady || (navActiveIndex ?? 0) <= 0}
              >
                上一个
              </button>
              <button
                type="button"
                className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50"
                onClick={() => {
                  setNavActiveIndex((navActiveIndex ?? 0) + 1);
                }}
                disabled={!highlightReady || (navActiveIndex ?? 0) >= navCitations.length - 1}
              >
                下一个
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Figma 式悬浮“本章提问”（一次性回复，不写入消息历史） */}
      <PrdSectionAskPanel
        sessionId={sessionId}
        headingId={activeHeadingId}
        headingTitle={activeHeadingTitle}
        onJumpToHeading={(id) => scrollToHeading(id)}
      />

      {/* 划词悬浮入口 */}
      {selectionToolbar ? (
        <div
          className="fixed z-50"
          style={{ left: selectionToolbar.x, top: selectionToolbar.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={openAskModal}
            className="px-2 py-1.5 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 shadow"
            title="询问 AI"
          >
            询问 AI
          </button>
        </div>
      ) : null}

      {/* 划词问AI模态 */}
      {askOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={closeAskModal} />
          <div className="relative z-10 w-full max-w-2xl mx-4 bg-surface-light dark:bg-surface-dark rounded-2xl shadow-2xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="text-sm font-semibold">询问 AI（搜索全文）</div>
              <button
                type="button"
                onClick={closeAskModal}
                disabled={askBusy}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50"
                title="关闭"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 space-y-3">
              <div className="text-xs text-text-secondary">
                选中文本：<span className="text-text-primary">{selectionToolbar?.text || ''}</span>
              </div>

              <textarea
                value={askDraft}
                onChange={(e) => setAskDraft(e.target.value)}
                disabled={askBusy}
                className="w-full min-h-[88px] px-3 py-2 bg-background-light dark:bg-background-dark border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/40 text-sm"
                placeholder="输入你的问题..."
              />

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeAskModal}
                  disabled={askBusy}
                  className="px-3 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={sendAskToAi}
                  disabled={askBusy || !askDraft.trim()}
                  className="px-3 py-2 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
                >
                  {askBusy ? '提问中...' : '发送'}
                </button>
              </div>

              {askError ? (
                <div className="text-sm text-red-600 dark:text-red-400">{askError}</div>
              ) : null}

              <div className="border-t border-border pt-3">
                <div className="text-xs font-semibold text-text-secondary mb-2">AI 回复</div>
                <div className="max-h-[40vh] overflow-auto text-sm whitespace-pre-wrap break-words">
                  {askAnswer ? askAnswer : (askBusy ? '正在生成...' : '暂无')}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

