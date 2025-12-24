import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import type { ApiResponse, DocumentContent } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import { useSessionStore } from '../../stores/sessionStore';
import { applyHighlights, clearHighlights, focusCitation, resolveHeadingIdForNavFromContainer } from './prdCitationHighlighter';

export default function PrdCitationPreviewDrawer() {
  const isOpen = usePrdCitationPreviewStore((s) => s.isOpen);
  const documentId = usePrdCitationPreviewStore((s) => s.documentId);
  const groupId = usePrdCitationPreviewStore((s) => s.groupId);
  const targetHeadingId = usePrdCitationPreviewStore((s) => s.targetHeadingId);
  const targetHeadingTitle = usePrdCitationPreviewStore((s) => s.targetHeadingTitle);
  const citations = usePrdCitationPreviewStore((s) => s.citations);
  const activeCitationIndex = usePrdCitationPreviewStore((s) => s.activeCitationIndex);
  const close = usePrdCitationPreviewStore((s) => s.close);

  const openWithCitations = usePrdPreviewNavStore((s) => s.openWithCitations);
  const openPrdPreviewPage = useSessionStore((s) => s.openPrdPreviewPage);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [content, setContent] = useState<string>('');
  const contentRef = useRef<HTMLDivElement>(null);

  const canLoad = useMemo(() => Boolean(isOpen && documentId && groupId), [isOpen, documentId, groupId]);

  const resolveHeadingIdForNav = useCallback((opts: { headingId?: string | null; headingTitle?: string | null }) => {
    const container = contentRef.current;
    if (!container) return null;
    return resolveHeadingIdForNavFromContainer({
      container,
      headingId: opts.headingId ?? null,
      headingTitle: opts.headingTitle ?? null,
    });
  }, []);

  const scrollToHeading = useCallback((headingId: string) => {
    const container = contentRef.current;
    if (!container) return;
    const esc = (window as any).CSS?.escape
      ? (window as any).CSS.escape(headingId)
      : headingId.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
    const el = container.querySelector(`#${esc}`) as HTMLElement | null;
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const top = container.scrollTop + (elRect.top - containerRect.top) - 16;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, []);

  const doHighlightAndFocus = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;

    applyHighlights({
      container,
      citations: Array.isArray(citations) ? citations : [],
      resolveHeadingIdForNav,
    });

    requestAnimationFrame(() => {
      focusCitation({
        container,
        citationIdx: activeCitationIndex ?? 0,
        citations: Array.isArray(citations) ? citations : [],
        resolveHeadingIdForNav,
        scrollToHeading,
      });
    });
  }, [citations, activeCitationIndex, resolveHeadingIdForNav, scrollToHeading]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  useEffect(() => {
    if (!canLoad || !documentId || !groupId) return;
    let cancelled = false;

    const run = async () => {
      setError('');
      try {
        setLoading(true);
        const resp = await invoke<ApiResponse<DocumentContent>>('get_document_content', {
          documentId,
          groupId,
        });
        if (cancelled) return;
        if (!resp.success || !resp.data) {
          setError(resp.error?.message || '加载失败');
          setContent('');
          return;
        }
        setContent(resp.data.content || '');
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || '加载失败');
          setContent('');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [canLoad, documentId, groupId]);

  // 内容渲染完成后：跳转并标黄（与全屏一致，但不显示引用浮层）
  useEffect(() => {
    if (!isOpen) return;
    if (!content) return;

    const container = contentRef.current;
    if (!container) return;

    // 等待 Markdown 渲染/图片加载导致的布局稳定，再做定位
    let cancelled = false;
    let attempt = 0;
    const delays = [0, 120, 300, 800, 1500];
    let timer: number | null = null;
    let mo: MutationObserver | null = null;

    const tryRunOnce = () => {
      if (cancelled) return true;
      const resolved = resolveHeadingIdForNav({ headingId: targetHeadingId, headingTitle: targetHeadingTitle });
      if (resolved) scrollToHeading(resolved);
      doHighlightAndFocus();
      return true;
    };

    const run = () => {
      if (tryRunOnce()) return;
      attempt += 1;
      if (attempt >= delays.length) return;
      timer = window.setTimeout(() => run(), delays[attempt]) as unknown as number;
    };

    try {
      mo = new MutationObserver(() => {
        tryRunOnce();
      });
      mo.observe(container, { childList: true, subtree: true });
    } catch {
      mo = null;
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
    };
  }, [
    isOpen,
    content,
    targetHeadingId,
    targetHeadingTitle,
    doHighlightAndFocus,
    resolveHeadingIdForNav,
    scrollToHeading,
  ]);

  // 关闭抽屉时清掉标黄（避免下次打开残留）
  useEffect(() => {
    if (isOpen) return;
    const container = contentRef.current;
    if (!container) return;
    clearHighlights(container);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* 透明遮罩（仅用于捕获点击关闭，不影响底层视觉） */}
      <div className="absolute inset-0 pointer-events-auto" onClick={close} />

      <div className="absolute right-0 top-0 h-full w-[420px] max-w-[92vw] bg-surface-light dark:bg-surface-dark border-l border-border shadow-2xl pointer-events-auto flex flex-col">
        <div className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold truncate">引用预览</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-8 px-2 rounded-md text-xs text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
              onClick={() => {
                if (!documentId || !groupId) return;
                openWithCitations({
                  targetHeadingId,
                  targetHeadingTitle,
                  citations: citations ?? [],
                  activeCitationIndex,
                });
                close();
                openPrdPreviewPage();
              }}
              title="打开完整预览"
            >
              打开完整预览
            </button>
            <button
              type="button"
              className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
              onClick={close}
              title="关闭"
              aria-label="关闭"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div ref={contentRef} className="flex-1 min-h-0 overflow-auto p-4">
          {loading ? (
            <div className="text-sm text-text-secondary">加载中...</div>
          ) : error ? (
            <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
          ) : (
            <MarkdownRenderer content={content} />
          )}
        </div>
      </div>
    </div>
  );
}


