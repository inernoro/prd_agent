/**
 * PRD 预览页（Web 版）
 * 从 prd-desktop 移植，invoke() 替换为 apiRequest()，去除 Tauri 依赖。
 * 保留完整功能：三栏布局、目录导航、评论、引用高亮、划词提问。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import GithubSlugger from 'github-slugger';
import PrdCommentsPanel from './PrdCommentsPanel';
import { usePrdPreviewNavStore, type DocCitation } from '@/stores/prdPreviewNavStore';
import { applyHighlights as applyHighlightsHelper, clearHighlights as clearHighlightsHelper, focusCitation } from '@/lib/prdCitationHighlighter';

function childrenToText(children: any): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (typeof children === 'object' && 'props' in children) return childrenToText((children as any).props?.children);
  return '';
}

function normalizeHeadingText(raw: string) {
  let s = String(raw || '');
  s = s.replace(/\s+#+\s*$/, '').trim();
  s = s.replace(/\s+/g, ' ');
  return s;
}

/**
 * Strip inline color styles from <font color="..."> and style="color:..." attributes
 * so elements inherit colors from the dark-mode CSS instead of being hardcoded to light colors.
 */
function walkHast(node: any) {
  if (node.type === 'element') {
    const props = node.properties;
    if (props) {
      if (node.tagName === 'font' && props.color != null) {
        delete props.color;
      }
      const style = props.style;
      if (typeof style === 'string' && style.length > 0) {
        const cleaned = style
          .replace(/\b(?:color|background-color)\s*:\s*[^;]+;?/gi, '')
          .trim();
        if (cleaned) {
          props.style = cleaned;
        } else {
          delete props.style;
        }
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkHast(child);
  }
}

function rehypeStripInlineColors() {
  return (tree: any) => { walkHast(tree); };
}

/**
 * react-markdown v10 默认 urlTransform 只放行 http(s)/mailto/xmpp/irc，
 * Word → Markdown 转出的 `data:image/...;base64` 会被直接抹掉。
 * 这里放行 data:image/ 与 blob:，其余协议仍按默认安全白名单处理。
 */
function safePrdUrlTransform(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^blob:/i.test(raw)) return raw;
  const colon = raw.indexOf(':');
  const question = raw.indexOf('?');
  const hash = raw.indexOf('#');
  const slash = raw.indexOf('/');
  if (
    colon < 0 ||
    (slash > -1 && colon > slash) ||
    (question > -1 && colon > question) ||
    (hash > -1 && colon > hash) ||
    /^(https?|ircs?|mailto|xmpp)$/i.test(raw.slice(0, colon))
  ) {
    return raw;
  }
  return '';
}

type DocumentContent = { id: string; title: string; content: string };

export default function PrdPreviewPage(props: {
  documentId: string | null;
  groupId: string | null;
  sessionId?: string | null;
  onRequestClose?: () => void;
}) {
  const { documentId, groupId, sessionId, onRequestClose } = props;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tocOpen, setTocOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(!!groupId);
  const [prdPreview, setPrdPreview] = useState<null | { documentId: string; title: string; content: string }>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeHeadingTitle, setActiveHeadingTitle] = useState<string | null>(null);
  const [tocItems, setTocItems] = useState<Array<{ id: string; text: string; level: number }>>([]);
  const [highlightReady, setHighlightReady] = useState(false);
  const [isCitationExcerptExpanded, setIsCitationExcerptExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const headingsRef = useRef<Array<{ id: string; el: HTMLElement; title: string; top: number }>>([]);
  const scrollRafRef = useRef<number | null>(null);

  // 三栏拖拽
  const [tocWidth, setTocWidth] = useState(288);
  const [commentsWidth, setCommentsWidth] = useState(320);
  const [isResizing, setIsResizing] = useState<null | 'toc' | 'comments'>(null);
  const resizeRef = useRef<{ startX: number; startToc: number; startComments: number } | null>(null);

  // 引用导航
  const navTargetHeadingId = usePrdPreviewNavStore((s) => s.targetHeadingId);
  const navTargetHeadingTitle = usePrdPreviewNavStore((s) => s.targetHeadingTitle);
  const navCitations = usePrdPreviewNavStore((s) => s.citations);
  const navActiveIndex = usePrdPreviewNavStore((s) => s.activeCitationIndex);
  const setNavActiveIndex = usePrdPreviewNavStore((s) => s.setActiveCitationIndex);
  const consumeNavTarget = usePrdPreviewNavStore((s) => s.consumeTarget);
  const clearNav = usePrdPreviewNavStore((s) => s.clear);

  const canPreview = Boolean(documentId && (groupId || sessionId));

  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

  const beginResize = (kind: 'toc' | 'comments', e: React.PointerEvent<HTMLDivElement>) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(kind);
    resizeRef.current = { startX: e.clientX, startToc: tocWidth, startComments: commentsWidth };
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    try { document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; } catch { /* ignore */ }
  };

  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return;
    const s = resizeRef.current;
    if (!s) return;
    const delta = e.clientX - s.startX;
    const min = 200;
    const max = 520;
    if (isResizing === 'toc') setTocWidth(clamp(s.startToc + delta, min, max));
    else setCommentsWidth(clamp(s.startComments - delta, min, max));
  };

  const endResize = () => {
    if (!isResizing) return;
    setIsResizing(null);
    resizeRef.current = null;
    try { document.body.style.cursor = ''; document.body.style.userSelect = ''; } catch { /* ignore */ }
  };

  // 加载文档内容
  useEffect(() => {
    if (!documentId) return;
    // 至少需要 groupId 或 sessionId
    if (!groupId && !sessionId) return;
    if (prdPreview?.documentId === documentId && prdPreview.content) return;

    let cancelled = false;
    const run = async () => {
      setError('');
      try {
        setLoading(true);
        const qs = new URLSearchParams();
        if (groupId) qs.set('groupId', groupId);
        else if (sessionId) qs.set('sessionId', sessionId);
        const resp = await apiRequest<DocumentContent>(
          `${api.v1.documents.content(documentId)}?${qs.toString()}`
        );
        if (cancelled) return;
        if (!resp.success || !resp.data) {
          setError(resp.error?.message || '获取 PRD 内容失败');
          return;
        }
        setPrdPreview({ documentId: resp.data.id, title: resp.data.title, content: resp.data.content || '' });
      } catch {
        if (cancelled) return;
        setError('获取 PRD 内容失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [documentId, groupId, sessionId, prdPreview?.documentId, prdPreview?.content]);

  // 切换文档时清空引用导航
  const lastDocGroupRef = useRef<{ docId: string | null; groupId: string | null } | null>(null);
  useEffect(() => {
    const cur = { docId: documentId, groupId };
    const prev = lastDocGroupRef.current;
    lastDocGroupRef.current = cur;
    if (!prev) return;
    if (prev.docId !== cur.docId || prev.groupId !== cur.groupId) clearNav();
  }, [documentId, groupId, clearNav]);

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

  const scrollToHeading = useCallback((id: string) => {
    const container = contentRef.current;
    if (!container) return;
    const esc = (window as any).CSS?.escape ? (window as any).CSS.escape(id) : id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
    const tryScroll = (attempt: number) => {
      const el = container.querySelector(`#${esc}`) as HTMLElement | null;
      if (!el) {
        if (attempt < 2) requestAnimationFrame(() => tryScroll(attempt + 1));
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const top = container.scrollTop + (elRect.top - containerRect.top) - 12;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    };
    tryScroll(0);
  }, []);

  const resolveHeadingIdForNav = useCallback((args: { headingId?: string | null; headingTitle?: string | null }) => {
    const container = contentRef.current;
    if (!container) return null;

    const normalizeHeadingTextForMatch = (raw: string) => {
      let s = String(raw || '');
      s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      s = s.replace(/`([^`]+)`/g, '$1');
      for (let i = 0; i < 2; i++) {
        s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1');
      }
      s = s.replace(/<[^>]+>/g, '').replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
      s = s.replace(/\s+#+\s*$/, '').trim().replace(/\s+/g, ' ');
      return s;
    };

    const looseKey = (raw: string) => {
      const s = normalizeHeadingTextForMatch(raw);
      if (!s) return '';
      return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').trim();
    };

    const rawId = (args.headingId || '').trim();
    const rawTitle = (args.headingTitle || '').trim();

    const normalizeId = (id: string) => {
      const s = String(id || '').trim();
      return s.startsWith('#') ? s.slice(1) : s;
    };

    const safeDecode = (id: string) => { try { return decodeURIComponent(id); } catch { return id; } };

    const tryFindId = (id: string) => {
      const norm = normalizeId(id);
      if (!norm) return null;
      const esc = (window as any).CSS?.escape ? (window as any).CSS.escape(norm) : norm.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
      const el = container.querySelector(`#${esc}`) as HTMLElement | null;
      return el ? norm : null;
    };

    // 1) 按 headingId 精确匹配
    if (rawId) {
      const candidates = [rawId, normalizeId(rawId), safeDecode(rawId), normalizeId(safeDecode(rawId)), safeDecode(rawId).toLowerCase(), normalizeId(safeDecode(rawId).toLowerCase())].filter(Boolean);
      for (const c of candidates) { const hit = tryFindId(c); if (hit) return hit; }
    }

    // 2) 按 headingTitle 匹配
    if (rawTitle) {
      const needle = normalizeHeadingTextForMatch(rawTitle);
      if (!needle) return null;
      const needleLoose = looseKey(rawTitle);
      const hs = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];

      for (const h of hs) {
        const text = normalizeHeadingTextForMatch(h.textContent || '');
        if (text && text === needle && h.id) return h.id;
      }
      if (needleLoose) {
        for (const h of hs) {
          const key = looseKey(h.textContent || '');
          if (key && key === needleLoose && h.id) return h.id;
        }
      }
      for (const h of hs) {
        const t2 = normalizeHeadingTextForMatch(h.textContent || '');
        if (!t2 || !h.id) continue;
        if (t2.includes(needle) || needle.includes(t2)) return h.id;
      }
    }

    return null;
  }, []);

  const clearHighlights = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;
    clearHighlightsHelper(container);
  }, []);

  const applyHighlights = useCallback((citations: DocCitation[]) => {
    const container = contentRef.current;
    if (!container) return;
    applyHighlightsHelper({ container, citations, resolveHeadingIdForNav });
    setHighlightReady(true);
  }, [resolveHeadingIdForNav]);

  const pendingNavFallbackHeadingRef = useRef<string | null>(null);
  const pendingNavFocusOnceRef = useRef(false);
  const lastFocusedKeyRef = useRef<string | null>(null);

  const rebuildHeadingsCache = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;
    const hs = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
    const baseTop = container.getBoundingClientRect().top;
    headingsRef.current = hs.map((h) => {
      const id = h.id || '';
      const title = (h.textContent || '').trim();
      if (!id || !title) return null;
      const top = container.scrollTop + (h.getBoundingClientRect().top - baseTop);
      return { id, el: h, title, top };
    }).filter(Boolean) as Array<{ id: string; el: HTMLElement; title: string; top: number }>;
  }, []);

  const updateActiveHeadingFromScroll = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;
    const list = headingsRef.current;
    if (!list || list.length === 0) return;
    const threshold = 24;
    const y = container.scrollTop + threshold;
    let current = list[0];
    for (let i = 0; i < list.length; i++) {
      if (list[i].top <= y) current = list[i];
      else break;
    }
    if (!current?.id) return;
    setActiveHeadingId((prev) => (prev === current.id ? prev : current.id));
    setActiveHeadingTitle((prev) => (prev === current.title ? prev : current.title));
  }, []);

  // slugger 在 content 变化时重建，保证 heading ID 一致性
  const slugger = useMemo(() => new GithubSlugger(), [prdPreview?.content]);

  const headingComponents = useMemo(() => {
    const make = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => {
      return ({ children }: any) => {
        const text = normalizeHeadingText(childrenToText(children));
        const id = text ? slugger.slug(text) : undefined;
        return <Tag id={id}>{children}</Tag>;
      };
    };
    return { h1: make('h1'), h2: make('h2'), h3: make('h3'), h4: make('h4'), h5: make('h5'), h6: make('h6') };
  }, [slugger]);

  const markdownComponents = useMemo(() => ({
    ...headingComponents,
    img: ({ src, alt, ...props }: any) => {
      const safeSrc = typeof src === 'string' ? src.trim() : '';
      if (!safeSrc) {
        return (
          <span
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs align-middle"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            title={alt || ''}
          >
            <span>[图片]</span>
            <span>{alt ? `：${alt}` : '（链接缺失或被清理）'}</span>
          </span>
        );
      }
      return (
        <img
          src={safeSrc}
          alt={alt || ''}
          loading="lazy"
          style={{ maxWidth: '100%', borderRadius: 8 }}
          onError={(e) => {
            const el = e.currentTarget;
            if (el.dataset.fallback === '1') return;
            el.dataset.fallback = '1';
            const span = document.createElement('span');
            span.textContent = alt ? `图片加载失败：${alt}` : '图片加载失败';
            span.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid var(--border,#333);border-radius:4px;font-size:12px;color:var(--text-muted,#888);';
            el.replaceWith(span);
          }}
          {...props}
        />
      );
    },
  }), [headingComponents]);

  const prdPreviewBody = useMemo(() => {
    if (!canPreview) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>请先选择群组并绑定 PRD</div>;
    if (loading) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>;
    if (error) return <div className="text-sm text-red-500">{error}</div>;
    return (
      <div className="prose prose-sm max-w-none prd-preview-content" style={{ color: 'var(--text-primary)' }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          rehypePlugins={[rehypeRaw, rehypeStripInlineColors]}
          urlTransform={safePrdUrlTransform}
          components={markdownComponents}
        >
          {prdPreview?.content || ''}
        </ReactMarkdown>
      </div>
    );
  }, [canPreview, prdPreview?.content, error, loading, markdownComponents]);

  // 从 DOM 抽取 TOC
  useEffect(() => {
    if (!canPreview || loading || error) return;
    const container = contentRef.current;
    if (!container) return;
    const raf = requestAnimationFrame(() => {
      const hs = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
      const items = hs.map((h) => {
        const tag = h.tagName.toLowerCase();
        const level = Number(tag.slice(1));
        const id = h.id || '';
        const text = (h.textContent || '').trim();
        if (!id || !text || !Number.isFinite(level)) return null;
        return { id, text, level };
      }).filter(Boolean) as Array<{ id: string; text: string; level: number }>;
      setTocItems(items);
      if (items.length > 0) {
        setActiveHeadingId((prev) => (prev ? prev : items[0].id));
        setActiveHeadingTitle((prev) => (prev ? prev : items[0].text));
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [canPreview, loading, error, prdPreview?.content]);

  // Scrollspy
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !canPreview || loading || error) return;

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

    lateTimer = window.setTimeout(() => scheduleRebuild(), 800) as unknown as number;

    const mo = new MutationObserver(() => scheduleRebuild());
    try { mo.observe(container, { childList: true, subtree: true }); } catch { /* ignore */ }

    const onLoadCapture = (e: Event) => {
      const t = e.target as any;
      const tag = (t?.tagName || '').toUpperCase();
      if (tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'IFRAME') scheduleRebuild();
    };
    container.addEventListener('load', onLoadCapture, true);

    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        updateActiveHeadingFromScroll();
      });
    };
    const onResize = () => { rebuildHeadingsCache(); updateActiveHeadingFromScroll(); };

    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 != null) cancelAnimationFrame(raf2);
      if (pendingRebuildRaf != null) cancelAnimationFrame(pendingRebuildRaf);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
      if (lateTimer != null) window.clearTimeout(lateTimer);
      try { mo.disconnect(); } catch { /* ignore */ }
      container.removeEventListener('load', onLoadCapture as EventListener, true);
      container.removeEventListener('scroll', onScroll as EventListener);
      window.removeEventListener('resize', onResize);
    };
  }, [canPreview, loading, error, prdPreview?.content, rebuildHeadingsCache, updateActiveHeadingFromScroll]);

  // 引用跳转
  useEffect(() => {
    if (!navTargetHeadingId && !navTargetHeadingTitle) return;
    if (!canPreview || loading || error || !prdPreview?.content) return;

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
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      try { mo?.disconnect(); } catch { /* ignore */ }
      mo = null;

      if (!Array.isArray(navCitations) || navCitations.length === 0) {
        pendingNavFallbackHeadingRef.current = null;
        pendingNavFocusOnceRef.current = false;
        scrollToHeading(resolved);
      } else {
        pendingNavFallbackHeadingRef.current = resolved;
        pendingNavFocusOnceRef.current = true;
        applyHighlights(navCitations);
      }
      consumeNavTarget();
      return true;
    };

    const run = () => {
      if (tryRunOnce()) return;
      attempt += 1;
      if (attempt >= delays.length) return;
      timer = window.setTimeout(() => run(), delays[attempt]) as unknown as number;
    };

    const container = contentRef.current;
    if (container) {
      try {
        mo = new MutationObserver(() => {
          if (tryRunOnce()) { try { mo?.disconnect(); } catch { /* ignore */ } mo = null; }
        });
        mo.observe(container, { childList: true, subtree: true });
      } catch { mo = null; }
    }

    const raf = requestAnimationFrame(() => run());
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer != null) window.clearTimeout(timer);
      try { mo?.disconnect(); } catch { /* ignore */ }
      mo = null;
    };
  }, [navTargetHeadingId, navTargetHeadingTitle, navCitations, canPreview, loading, error, prdPreview?.content, applyHighlights, resolveHeadingIdForNav, consumeNavTarget, scrollToHeading]);

  // 切换引用索引
  useEffect(() => {
    if (!Array.isArray(navCitations) || navCitations.length === 0) return;
    if (!highlightReady) return;
    const idx = navActiveIndex ?? 0;
    const key = `${idx}:${navCitations.length}`;
    if (!pendingNavFocusOnceRef.current && lastFocusedKeyRef.current === key) return;
    lastFocusedKeyRef.current = key;
    const fallbackHeadingId = pendingNavFallbackHeadingRef.current;
    pendingNavFallbackHeadingRef.current = null;
    pendingNavFocusOnceRef.current = false;
    const raf = requestAnimationFrame(() => {
      const container = contentRef.current;
      if (!container) return;
      focusCitation({ container, citationIdx: idx, citations: navCitations, resolveHeadingIdForNav, scrollToHeading, fallbackHeadingId });
    });
    return () => cancelAnimationFrame(raf);
  }, [navActiveIndex, navCitations?.length, highlightReady, resolveHeadingIdForNav, scrollToHeading]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶栏 */}
      <div className="h-12 px-4 flex items-center justify-between border-b ui-glass-bar">
        <div className="flex items-center gap-2 min-w-0">
          {onRequestClose && (
            <button
              type="button"
              onClick={onRequestClose}
              className="h-8 px-2 rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: 'var(--text-secondary)' }}
              title="返回"
              aria-label="返回"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>PRD 预览</div>
            <div className="text-xs truncate" style={{ color: 'var(--text-secondary)' }} title={prdPreview?.title || ''}>
              {prdPreview?.title || ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${tocOpen ? 'text-indigo-400' : ''}`}
            style={tocOpen ? undefined : { color: 'var(--text-secondary)' }}
            onClick={() => setTocOpen((v) => !v)}
            aria-label="章节目录"
            title="章节目录"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
          </button>
          <button
            type="button"
            className={`h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${commentsOpen ? 'text-indigo-400' : ''}`}
            style={commentsOpen ? undefined : { color: 'var(--text-secondary)' }}
            onClick={() => setCommentsOpen((v) => !v)}
            aria-label="评论"
            title="评论"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h6m-6 4h8M5 20l-2 2V6a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H7z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 三栏 */}
      <div className="flex-1 min-h-0">
        <div className="h-full flex min-h-0">
          {/* 左：目录 */}
          {tocOpen && (
            <div
              className="overflow-auto p-3 border-r ui-glass-bar"
              style={{ width: `${tocWidth}px` }}
            >
              <div className="text-xs font-semibold px-2 py-1" style={{ color: 'var(--text-secondary)' }}>目录</div>
              <div className="mt-1 space-y-1">
                {tocItems.length > 0 ? (
                  tocItems.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        rebuildHeadingsCache();
                        setActiveHeadingId(t.id);
                        setActiveHeadingTitle(t.text);
                        scrollToHeading(t.id);
                      }}
                      className={`w-full text-left text-xs rounded-md pr-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${tocIndentClass(t.level)} ${
                        activeHeadingId === t.id ? 'text-indigo-400' : 'hover:text-indigo-300'
                      }`}
                      style={activeHeadingId === t.id ? undefined : { color: 'var(--text-secondary)' }}
                      title={t.text}
                    >
                      <span className="block whitespace-normal break-words">{t.text}</span>
                    </button>
                  ))
                ) : (
                  <div className="mt-2 text-xs px-2" style={{ color: 'var(--text-secondary)' }}>
                    {loading ? '加载中...' : '未识别到章节标题'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 拖拽条：目录/正文 */}
          {tocOpen && (
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
              <div className="h-full w-full hover:bg-indigo-500/10 dark:hover:bg-indigo-500/10" />
            </div>
          )}

          {/* 中：正文 */}
          <div ref={contentRef} className="flex-1 min-w-0 overflow-auto p-5">
            <div className="max-w-[960px] mx-auto">
              {prdPreviewBody}
            </div>
          </div>

          {/* 拖拽条：正文/评论 */}
          {commentsOpen && (
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
              <div className="h-full w-full hover:bg-indigo-500/10 dark:hover:bg-indigo-500/10" />
            </div>
          )}

          {/* 右：评论 */}
          {commentsOpen && (
            <div
              className="overflow-hidden border-l ui-glass-bar"
              style={{ width: `${commentsWidth}px` }}
            >
              <PrdCommentsPanel
                documentId={prdPreview?.documentId || documentId || ''}
                groupId={groupId || ''}
                headingId={activeHeadingId}
                headingTitle={activeHeadingTitle}
                onJumpToHeading={(id) => scrollToHeading(id)}
              />
            </div>
          )}
        </div>
      </div>

      {/* 引用导航浮层 */}
      {Array.isArray(navCitations) && navCitations.length > 0 ? (
        <div className="fixed z-40 right-4 top-16">
          <div className="ui-glass-panel px-3 py-2 w-[320px]">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                引用 {Math.min((navActiveIndex ?? 0) + 1, navCitations.length)}/{navCitations.length}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs hover:text-indigo-400"
                  style={{ color: 'var(--text-secondary)' }}
                  onClick={() => setIsCitationExcerptExpanded((v) => !v)}
                  title={isCitationExcerptExpanded ? '收起' : '展开'}
                >
                  {isCitationExcerptExpanded ? '收起' : '展开'}
                </button>
                <button
                  type="button"
                  className="text-xs hover:text-indigo-400"
                  style={{ color: 'var(--text-secondary)' }}
                  onClick={() => { clearHighlights(); clearNav(); setIsCitationExcerptExpanded(false); }}
                  title="清除高亮"
                >
                  清除
                </button>
              </div>
            </div>
            <div
              className={`mt-2 text-[11px] whitespace-pre-wrap break-words ${isCitationExcerptExpanded ? 'max-h-[220px] overflow-auto pr-1' : 'line-clamp-3'}`}
              style={{ color: 'var(--text-secondary)' }}
              title={navCitations[navActiveIndex]?.excerpt || ''}
            >
              {navCitations[navActiveIndex]?.excerpt || ''}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                className="px-2 py-1 text-xs rounded-md disabled:opacity-50 border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setNavActiveIndex((navActiveIndex ?? 0) - 1)}
                disabled={!highlightReady || (navActiveIndex ?? 0) <= 0}
              >
                上一个
              </button>
              <button
                type="button"
                className="px-2 py-1 text-xs rounded-md disabled:opacity-50 border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                onClick={() => setNavActiveIndex((navActiveIndex ?? 0) + 1)}
                disabled={!highlightReady || (navActiveIndex ?? 0) >= navCitations.length - 1}
              >
                下一个
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* PRD 预览样式 */}
      <style>{`
        .prd-preview-content h1, .prd-preview-content h2, .prd-preview-content h3,
        .prd-preview-content h4, .prd-preview-content h5, .prd-preview-content h6 {
          color: var(--text-primary); font-weight: 700; scroll-margin-top: 12px;
        }
        .prd-preview-content h1 { font-size: 1.5em; margin: 1.2em 0 0.6em; }
        .prd-preview-content h2 { font-size: 1.3em; margin: 1em 0 0.5em; }
        .prd-preview-content h3 { font-size: 1.1em; margin: 0.8em 0 0.4em; }
        .prd-preview-content p { margin: 0.6em 0; line-height: 1.7; }
        .prd-preview-content ul, .prd-preview-content ol { margin: 0.6em 0; padding-left: 1.5em; }
        .prd-preview-content li { margin: 0.3em 0; }
        .prd-preview-content code { font-size: 0.85em; background: var(--border-subtle); padding: 2px 6px; border-radius: 4px; }
        .prd-preview-content pre { background: var(--nested-block-bg, rgba(0,0,0,0.2)); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px; overflow: auto; margin: 0.8em 0; }
        .prd-preview-content pre code { background: transparent; padding: 0; }
        .prd-preview-content blockquote { border-left: 3px solid rgba(99, 102, 241, 0.4); background: rgba(99, 102, 241, 0.06); padding: 8px 12px; margin: 0.8em 0; border-radius: 6px; }
        .prd-preview-content table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
        .prd-preview-content th, .prd-preview-content td { border: 1px solid var(--border-default); padding: 6px 10px; text-align: left; }
        .prd-preview-content th { background: var(--bg-input); font-weight: 600; }
        .prd-preview-content a { color: var(--accent-gold, #818CF8); text-decoration: underline; text-underline-offset: 2px; }
        .prd-preview-content img { max-width: 100%; border-radius: 8px; }
        .prd-preview-content hr { border: 0; border-top: 1px solid var(--border-default); margin: 1.2em 0; }
      `}</style>
    </div>
  );
}
