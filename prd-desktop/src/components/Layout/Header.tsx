import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import RoleSelector from '../Role/RoleSelector';
import ModeToggle from '../Role/ModeToggle';
import { invoke } from '../../lib/tauri';
import type { ApiResponse, DocumentContent } from '../../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

interface HeaderProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Header({ isDark, onToggleTheme }: HeaderProps) {
  const { user, logout } = useAuthStore();
  const { documentLoaded, document, sessionId, activeGroupId } = useSessionStore();
  const { groups } = useGroupListStore();

  const [prdPreviewOpen, setPrdPreviewOpen] = useState(false);
  const [prdPreviewLoading, setPrdPreviewLoading] = useState(false);
  const [prdPreviewError, setPrdPreviewError] = useState('');
  const [prdPreview, setPrdPreview] = useState<null | { documentId: string; title: string; content: string }>(null);

  const canPreview = useMemo(() => {
    return Boolean(documentLoaded && document && activeGroupId);
  }, [activeGroupId, document, documentLoaded]);

  useEffect(() => {
    if (!prdPreviewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPrdPreviewOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [prdPreviewOpen]);

  const openPrdPreview = async () => {
    if (!canPreview || !document || !activeGroupId) return;
    setPrdPreviewOpen(true);
    setPrdPreviewError('');

    if (prdPreview?.documentId === document.id && prdPreview.content) return;

    try {
      setPrdPreviewLoading(true);
      const resp = await invoke<ApiResponse<DocumentContent>>('get_document_content', {
        documentId: document.id,
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

  return (
    <>
      <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-surface-light dark:bg-surface-dark">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">P</span>
          </div>
          <h1 className="text-lg font-semibold">PRD Agent</h1>
          {groups.length > 0 && (
            documentLoaded && document ? (
              <div className="ml-4 flex items-center gap-2 min-w-0">
                <span className="text-sm text-text-secondary truncate max-w-[300px]">
                  {document.title}
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

      {prdPreviewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setPrdPreviewOpen(false)}
          />
          <div className="relative w-full max-w-4xl mx-4 bg-surface-light dark:bg-surface-dark rounded-2xl shadow-2xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">PRD 预览</div>
                <div className="text-xs text-text-secondary truncate">
                  {prdPreview?.title || document?.title || ''}
                </div>
              </div>
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

            <div className="max-h-[72vh] overflow-auto p-5">
              {prdPreviewLoading ? (
                <div className="text-sm text-text-secondary">加载中...</div>
              ) : prdPreviewError ? (
                <div className="text-sm text-red-600 dark:text-red-400">{prdPreviewError}</div>
              ) : (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {prdPreview?.content || ''}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
