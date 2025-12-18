import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import RoleSelector from '../Role/RoleSelector';
import ModeToggle from '../Role/ModeToggle';
import { invoke } from '../../lib/tauri';
import type { ApiResponse, DocumentContent } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';
import PrdCommentsPanel from '../Comments/PrdCommentsPanel';

interface HeaderProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Header({ isDark, onToggleTheme }: HeaderProps) {
  const { user, logout } = useAuthStore();
  const { documentLoaded, document: prdDocument, sessionId, activeGroupId } = useSessionStore();
  const { groups } = useGroupListStore();

  const [prdPreviewOpen, setPrdPreviewOpen] = useState(false);
  const [prdPreviewMounted, setPrdPreviewMounted] = useState(false);
  const [prdPreviewLoading, setPrdPreviewLoading] = useState(false);
  const [prdPreviewError, setPrdPreviewError] = useState('');
  const [prdPreview, setPrdPreview] = useState<null | { documentId: string; title: string; content: string }>(null);
  const [prdPreviewMaximized, setPrdPreviewMaximized] = useState(false);
  const [prdPreviewTocOpen, setPrdPreviewTocOpen] = useState(true);
  const [prdPreviewCommentsOpen, setPrdPreviewCommentsOpen] = useState(true);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeHeadingTitle, setActiveHeadingTitle] = useState<string | null>(null);
  const [tocItems, setTocItems] = useState<Array<{ id: string; text: string; level: number }>>([]);
  const prdPreviewContentRef = useRef<HTMLDivElement>(null);

  const canPreview = useMemo(() => {
    return Boolean(documentLoaded && prdDocument && activeGroupId);
  }, [activeGroupId, prdDocument, documentLoaded]);

  useEffect(() => {
    if (!prdPreviewOpen) return;
    setPrdPreviewMounted(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPrdPreviewOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [prdPreviewOpen]);

  // 锁定背景滚动，避免“滚动穿透”
  useEffect(() => {
    if (!prdPreviewOpen) return;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;

    // 避免出现滚动条消失导致的页面横向抖动
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [prdPreviewOpen]);

  useEffect(() => {
    if (!prdPreviewOpen) {
      setPrdPreviewMaximized(false);
      setPrdPreviewTocOpen(true);
      setPrdPreviewCommentsOpen(true);
      setActiveHeadingId(null);
      setActiveHeadingTitle(null);
    }
  }, [prdPreviewOpen]);

  const openPrdPreview = async () => {
    if (!canPreview || !prdDocument || !activeGroupId) return;
    setPrdPreviewOpen(true);
    setPrdPreviewError('');

    if (prdPreview?.documentId === prdDocument.id && prdPreview.content) return;

    try {
      setPrdPreviewLoading(true);
      const resp = await invoke<ApiResponse<DocumentContent>>('get_document_content', {
        documentId: prdDocument.id,
        groupId: activeGroupId,
      });
      if (!resp.success || !resp.data) {
        setPrdPreviewError(resp.error?.message || '获取 PRD 内容失败');
        return;
      }
      setPrdPreview({ documentId: resp.data.id, title: resp.data.title, content: resp.data.content || '' });
    } catch {
      setPrdPreviewError('获取 PRD 内容失败');
    } finally {
      setPrdPreviewLoading(false);
    }
  };

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
    const el = container.querySelector(`#${esc}`) as HTMLElement | null;
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const top = container.scrollTop + (elRect.top - containerRect.top) - 12;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  const prdPreviewBody = useMemo(() => {
    if (prdPreviewLoading) return <div className="text-sm text-text-secondary">加载中...</div>;
    if (prdPreviewError) return <div className="text-sm text-red-600 dark:text-red-400">{prdPreviewError}</div>;
    return (
      <MarkdownRenderer
        className="prose prose-sm dark:prose-invert max-w-none"
        content={prdPreview?.content || ''}
      />
    );
  }, [prdPreview?.content, prdPreviewError, prdPreviewLoading]);

  // 从实际渲染出来的 DOM 中抽取 TOC，保证与 headingId 生成完全一致（避免跳错）
  useEffect(() => {
    if (!prdPreviewOpen) return;
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

      // 默认选中第一个章节
      if (!activeHeadingId && items.length > 0) {
        setActiveHeadingId(items[0].id);
        setActiveHeadingTitle(items[0].text);
      }
    });

    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prdPreviewOpen, prdPreviewLoading, prdPreviewError, prdPreview?.content]);

  return (
    <>
      <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-surface-light dark:bg-surface-dark">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">P</span>
          </div>
          <h1 className="text-lg font-semibold">PRD Agent</h1>
          {groups.length > 0 && (
            documentLoaded && prdDocument ? (
              <div className="ml-4 flex items-center gap-2 min-w-0">
                <span className="text-sm text-text-secondary truncate max-w-[300px]">
                  {prdDocument.title}
                </span>
                <button
                  type="button"
                  onClick={openPrdPreview}
                  disabled={!canPreview}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                  title="预览 PRD"
                  aria-label="预览 PRD"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event('prdAgent:openBindPrdPicker'))}
                className="text-sm text-text-secondary ml-4 truncate max-w-[300px] hover:text-primary-500"
                title="上传并绑定 PRD"
              >
                待上传
              </button>
            )
          )}
        </div>

        <div className="flex items-center gap-4">
          {groups.length > 0 && (
            <>
              {sessionId ? <RoleSelector /> : null}
              <ModeToggle />
            </>
          )}

          <button
            onClick={onToggleTheme}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {isDark ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>

          <div className="flex items-center gap-2">
            <span className="text-sm text-text-secondary">{user?.displayName}</span>
            <button
              onClick={logout}
              className="text-sm text-primary-500 hover:text-primary-600"
            >
              退出
            </button>
          </div>
        </div>
      </header>

      {prdPreviewMounted ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-hidden={!prdPreviewOpen}
          className={`fixed inset-0 z-50 flex transition-opacity duration-150 ${
            prdPreviewOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          } ${prdPreviewMaximized ? 'items-stretch justify-stretch p-4' : 'items-center justify-center'}`}
        >
          <div
            // backdrop blur 在部分 WebView 上全屏时容易出现严重卡顿/卡死，这里禁用以换取稳定性
            className="absolute inset-0 bg-black/60 z-0"
            onClick={() => setPrdPreviewOpen(false)}
          />
          <div
            className={`relative z-10 w-full bg-surface-light dark:bg-surface-dark shadow-2xl border border-border overflow-hidden flex flex-col ${
              prdPreviewMaximized ? 'max-w-none h-full rounded-xl' : 'max-w-4xl mx-4 rounded-2xl h-[80vh] max-h-[80vh]'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">PRD 预览</div>
                <div className="text-xs text-text-secondary truncate">
                  {prdPreview?.title || prdDocument?.title || ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
                  onClick={() => {
                    setPrdPreviewTocOpen((v) => !v);
                  }}
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
                  onClick={() => setPrdPreviewMaximized((v) => !v)}
                  aria-label={prdPreviewMaximized ? '还原' : '最大化'}
                  title={prdPreviewMaximized ? '还原' : '最大化'}
                >
                  {prdPreviewMaximized ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 8V6a2 2 0 00-2-2h-2M6 16v2a2 2 0 002 2h2M8 6H6a2 2 0 00-2 2v2M16 18h2a2 2 0 002-2v-2" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v16H4z" />
                    </svg>
                  )}
                </button>

                <button
                  type="button"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
                  onClick={() => setPrdPreviewOpen(false)}
                  aria-label="关闭"
                  title="关闭"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              <div className="h-full flex min-h-0">
                {/* 左：目录 */}
                {prdPreviewTocOpen ? (
                  <div className="w-72 border-r border-border bg-surface-light dark:bg-surface-dark overflow-auto p-3">
                    <div className="text-xs font-semibold text-text-secondary px-2 py-1">目录</div>
                    <div className="mt-1 space-y-1">
                      {tocItems.length > 0 ? (
                        tocItems.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => {
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

                {/* 中：正文 */}
                <div ref={prdPreviewContentRef} className="flex-1 min-w-0 overflow-auto p-5">
                  {prdPreviewBody}
                </div>

                {/* 右：评论 */}
                {prdPreviewCommentsOpen ? (
                  <div className="w-80 border-l border-border bg-surface-light dark:bg-surface-dark overflow-hidden">
                    <PrdCommentsPanel
                      documentId={prdPreview?.documentId || prdDocument?.id || ''}
                      groupId={activeGroupId || ''}
                      headingId={activeHeadingId}
                      headingTitle={activeHeadingTitle}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
