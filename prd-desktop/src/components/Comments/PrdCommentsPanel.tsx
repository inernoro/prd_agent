import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { useAuthStore } from '../../stores/authStore';
import type { ApiResponse } from '../../types';

export type PrdCommentsPanelProps = {
  documentId: string;
  groupId: string;
  headingId: string | null;
  headingTitle: string | null;
  onJumpToHeading?: (headingId: string) => void;
};

type PrdComment = {
  id: string;
  documentId: string;
  headingId: string;
  headingTitleSnapshot: string;
  authorUserId: string;
  authorDisplayName: string;
  content: string;
  createdAt: string;
  updatedAt?: string | null;
};

export default function PrdCommentsPanel({ documentId, groupId, headingId, headingTitle, onJumpToHeading }: PrdCommentsPanelProps) {
  const user = useAuthStore((s) => s.user);
  const [items, setItems] = useState<PrdComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  const title = useMemo(() => {
    if (!headingId) return '评论';
    return headingTitle ? `评论 · ${headingTitle}` : `评论 · ${headingId}`;
  }, [headingId, headingTitle]);

  const canLoad = !!documentId && !!groupId;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setError('');
      if (!canLoad) {
        setItems([]);
        return;
      }
      try {
        setLoading(true);
        const resp = await invoke<ApiResponse<PrdComment[]>>('get_prd_comments', {
          documentId,
          groupId,
          // 全量加载：不传 headingId，后端/命令层会返回全量
          headingId: undefined,
          limit: 200,
        });
        if (cancelled) return;
        if (!resp.success || !resp.data) {
          setError(resp.error?.message || '加载评论失败');
          setItems([]);
          return;
        }
        setItems(resp.data);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || '加载评论失败');
        setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [canLoad, documentId, groupId]);

  // 当前章节变化时：自动定位到该章节的第一条评论
  useEffect(() => {
    if (!headingId) return;
    const container = listRef.current;
    if (!container) return;
    const nodes = Array.from(container.querySelectorAll('[data-heading-id]')) as HTMLElement[];
    const target = nodes.find((n) => n.getAttribute('data-heading-id') === headingId) ?? null;
    if (!target) return;
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [headingId, items.length]);

  const submit = async () => {
    if (!canLoad) return;
    if (!headingId) {
      setError('请先在左侧目录中选择章节后再发表评论');
      return;
    }
    const content = draft.trim();
    if (!content) return;
    setError('');
    try {
      const resp = await invoke<ApiResponse<PrdComment>>('create_prd_comment', {
        documentId,
        groupId,
        headingId,
        headingTitleSnapshot: headingTitle || '',
        content,
      });
      if (!resp.success || !resp.data) {
        setError(resp.error?.message || '发送失败');
        return;
      }
      setItems((prev) => [resp.data!, ...prev]);
      setDraft('');
    } catch (e: any) {
      setError(e?.message || '发送失败');
    }
  };

  const canSubmit = canLoad && !!headingId && !!draft.trim() && !loading;

  const removeComment = async (commentId: string) => {
    if (!commentId || !groupId) return;
    if (!confirm('确认删除这条评论？删除后不可恢复。')) return;
    setError('');
    try {
      const resp = await invoke<ApiResponse<any>>('delete_prd_comment', { commentId, groupId });
      if (!resp.success) {
        setError(resp.error?.message || '删除失败');
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== commentId));
    } catch (e: any) {
      setError(e?.message || '删除失败');
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border">
        <div className="text-sm font-semibold truncate" title={title}>{title}</div>
        <div className="text-xs text-text-secondary mt-0.5">
          {headingId ? '滚动正文会自动同步当前章节' : '滚动正文或点击目录选择章节'}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-auto p-3 space-y-3">
        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : null}

        {loading ? (
          <div className="text-sm text-text-secondary">加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-text-secondary">暂无评论，来发表第一条。</div>
        ) : (
          <div className="space-y-2">
            {items.map((c) => (
              <button
                key={c.id}
                type="button"
                data-heading-id={c.headingId}
                onClick={() => {
                  if (c.headingId) onJumpToHeading?.(c.headingId);
                }}
                className={`w-full text-left rounded-lg border p-2 transition-colors ${
                  headingId && c.headingId === headingId
                    ? 'border-primary-200 dark:border-white/10 bg-primary-50 dark:bg-white/5'
                    : 'border-border hover:bg-gray-50 dark:hover:bg-white/5'
                }`}
                title={c.headingTitleSnapshot || c.headingId}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] text-text-secondary truncate">
                    章节：{c.headingTitleSnapshot || c.headingId}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-[11px] text-text-secondary whitespace-nowrap">
                      {c.createdAt ? String(c.createdAt).slice(0, 19).replace('T', ' ') : ''}
                    </div>
                    {user?.userId && c.authorUserId === user.userId ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void removeComment(c.id);
                        }}
                        className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title="删除评论"
                        aria-label="删除评论"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0h8m-8 0V5a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <div className="text-xs text-text-secondary truncate">
                    {c.authorDisplayName || c.authorUserId}
                    {user?.userId && c.authorUserId === user.userId ? '（我）' : ''}
                  </div>
                </div>
                <div className="mt-1 text-sm whitespace-pre-wrap break-words">{c.content}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={headingId ? '写下你的评论...' : '请先选择章节'}
          disabled={!headingId || !documentId || !groupId}
          className="w-full min-h-[64px] px-3 py-2 bg-background-light dark:bg-background-dark border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/40 text-sm"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-text-secondary truncate">
            {headingId ? (headingTitle || headingId) : ''}
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
