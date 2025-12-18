import { useEffect, useMemo, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { useAuthStore } from '../../stores/authStore';
import type { ApiResponse } from '../../types';

export type PrdCommentsPanelProps = {
  documentId: string;
  groupId: string;
  headingId: string | null;
  headingTitle: string | null;
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

export default function PrdCommentsPanel({ documentId, groupId, headingId, headingTitle }: PrdCommentsPanelProps) {
  const user = useAuthStore((s) => s.user);
  const [items, setItems] = useState<PrdComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');

  const title = useMemo(() => {
    if (!headingId) return '评论';
    return headingTitle ? `评论 · ${headingTitle}` : `评论 · ${headingId}`;
  }, [headingId, headingTitle]);

  const canLoad = !!documentId && !!groupId && !!headingId;

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
          headingId,
          limit: 50,
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
  }, [canLoad, documentId, groupId, headingId]);

  const submit = async () => {
    if (!canLoad) return;
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

  const canSubmit = canLoad && !!draft.trim() && !loading;

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border">
        <div className="text-sm font-semibold truncate" title={title}>{title}</div>
        <div className="text-xs text-text-secondary mt-0.5">
          {headingId ? '该章节的评论' : '请选择章节查看评论'}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : null}

        {loading ? (
          <div className="text-sm text-text-secondary">加载中...</div>
        ) : !headingId ? (
          <div className="text-sm text-text-secondary">请选择左侧目录中的章节查看评论。</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-text-secondary">暂无评论，来发表第一条。</div>
        ) : (
          <div className="space-y-2">
            {items.map((c) => (
              <div key={c.id} className="rounded-lg border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-text-secondary truncate">
                    {c.authorDisplayName || c.authorUserId}
                    {user?.userId && c.authorUserId === user.userId ? '（我）' : ''}
                  </div>
                  <div className="text-[11px] text-text-secondary whitespace-nowrap">
                    {c.createdAt ? String(c.createdAt).slice(0, 19).replace('T', ' ') : ''}
                  </div>
                </div>
                <div className="mt-1 text-sm whitespace-pre-wrap break-words">{c.content}</div>
              </div>
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
