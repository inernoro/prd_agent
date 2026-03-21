/**
 * PRD 评论面板（Web 版）
 * 从 prd-desktop 移植，invoke() 替换为 apiRequest()。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';

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
        const resp = await apiRequest<PrdComment[]>(api.prdAgent.comments.list(documentId, groupId));
        if (cancelled) return;
        if (!resp.success || !resp.data) {
          setError(resp.error?.message || '加载评论失败');
          setItems([]);
          return;
        }
        setItems(Array.isArray(resp.data) ? resp.data : []);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || '加载评论失败');
        setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
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
      const resp = await apiRequest<PrdComment>(api.prdAgent.comments.create(), {
        method: 'POST',
        body: {
          documentId,
          groupId,
          headingId,
          headingTitleSnapshot: headingTitle || '',
          content,
        },
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
      const resp = await apiRequest(api.prdAgent.comments.delete(commentId), {
        method: 'DELETE',
        headers: { 'X-Group-Id': groupId },
        emptyResponseData: true as any,
      });
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
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border-default)' }}>
        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={title}>{title}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {headingId ? '滚动正文会自动同步当前章节' : '滚动正文或点击目录选择章节'}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-auto p-3 space-y-3">
        {error ? (
          <div className="text-sm" style={{ color: 'var(--status-error)' }}>{error}</div>
        ) : null}

        {loading ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无评论，来发表第一条。</div>
        ) : (
          <div className="space-y-2">
            {items.map((c) => (
              <div
                key={c.id}
                data-heading-id={c.headingId}
                onClick={() => { if (c.headingId) onJumpToHeading?.(c.headingId); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (c.headingId) onJumpToHeading?.(c.headingId);
                  }
                }}
                role="button"
                tabIndex={0}
                className="w-full text-left rounded-lg p-2 transition-colors cursor-pointer"
                style={{
                  border: `1px solid ${headingId && c.headingId === headingId ? 'rgba(99, 102, 241, 0.3)' : 'var(--border-default)'}`,
                  background: headingId && c.headingId === headingId ? 'rgba(99, 102, 241, 0.06)' : 'transparent',
                }}
                title={c.headingTitleSnapshot || c.headingId}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    章节：{c.headingTitleSnapshot || c.headingId}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {c.createdAt ? String(c.createdAt).slice(0, 19).replace('T', ' ') : ''}
                    </div>
                    {user?.userId && c.authorUserId === user.userId ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void removeComment(c.id); }}
                        className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-red-500/10"
                        style={{ color: 'var(--text-muted)' }}
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
                  <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {c.authorDisplayName || c.authorUserId}
                    {user?.userId && c.authorUserId === user.userId ? '（我）' : ''}
                  </div>
                </div>
                <div className="mt-1 text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>{c.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-3" style={{ borderTop: '1px solid var(--border-default)' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={headingId ? '写下你的评论...' : '请先选择章节'}
          disabled={!headingId || !documentId || !groupId}
          className="w-full min-h-[64px] px-3 py-2 rounded-lg resize-none text-sm outline-none"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            {headingId ? (headingTitle || headingId) : ''}
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs rounded-md text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: canSubmit ? 'rgba(99, 102, 241, 0.8)' : 'rgba(99, 102, 241, 0.4)' }}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
