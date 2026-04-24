import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MessageSquareText,
  X,
  Send,
  Trash2,
  AlertTriangle,
  UserCircle2,
  CornerDownLeft,
} from 'lucide-react';
import {
  createInlineComment,
  deleteInlineComment,
  listInlineComments,
} from '@/services';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';

export type PendingSelection = {
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  startOffset: number;
  endOffset: number;
};

function formatRelative(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso).getTime();
  const diff = Date.now() - date;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export type InlineCommentDrawerProps = {
  entryId: string;
  entryTitle: string;
  pendingSelection: PendingSelection | null;
  onClearPending: () => void;
  /** 点击某条评论时：尝试 scroll 到其 selectedText 在 DOM 中的位置 */
  onLocate?: (selectedText: string) => void;
  onClose: () => void;
};

export function InlineCommentDrawer({
  entryId,
  entryTitle,
  pendingSelection,
  onClearPending,
  onLocate,
  onClose,
}: InlineCommentDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<DocumentInlineComment[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listInlineComments(entryId);
    if (res.success) {
      setComments(res.data.items);
      setCanCreate(res.data.canCreate);
    } else {
      toast.error('加载评论失败', res.error?.message);
    }
    setLoading(false);
  }, [entryId]);

  useEffect(() => {
    load();
  }, [load]);

  // 选中新内容时自动聚焦 textarea
  useEffect(() => {
    if (pendingSelection && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [pendingSelection]);

  const handleSubmit = useCallback(async () => {
    if (!pendingSelection) {
      toast.warning('请先选中正文', '在文档内用鼠标选中一段文字，再填写评论');
      return;
    }
    if (!draft.trim()) {
      toast.warning('请填写评论内容');
      return;
    }
    setSubmitting(true);
    const res = await createInlineComment(entryId, {
      selectedText: pendingSelection.selectedText,
      contextBefore: pendingSelection.contextBefore,
      contextAfter: pendingSelection.contextAfter,
      startOffset: pendingSelection.startOffset,
      endOffset: pendingSelection.endOffset,
      content: draft.trim(),
    });
    setSubmitting(false);
    if (res.success) {
      toast.success('已添加评论');
      setDraft('');
      onClearPending();
      await load();
    } else {
      toast.error('添加失败', res.error?.message);
    }
  }, [pendingSelection, draft, entryId, onClearPending, load]);

  const handleDelete = useCallback(async (comment: DocumentInlineComment) => {
    const ok = await systemDialog.confirm({
      title: '删除评论',
      message: `确认删除这条评论吗？\n\n"${comment.content.slice(0, 80)}"`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteInlineComment(comment.id);
    if (res.success) {
      toast.success('已删除');
      setComments(prev => prev.filter(c => c.id !== comment.id));
    } else {
      toast.error('删除失败', res.error?.message);
    }
  }, []);

  const activeComments = comments.filter(c => c.status === 'active');
  const orphanedComments = comments.filter(c => c.status === 'orphaned');

  return (
    <div className="fixed inset-0 z-50 flex justify-end"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[460px] max-w-[92vw] h-full flex flex-col"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '-24px 0 48px -12px rgba(0,0,0,0.5)',
        }}>

        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)' }}>
              <MessageSquareText size={15} style={{ color: 'rgba(216,180,254,0.95)' }} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                划词评论
              </p>
              <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                {entryTitle}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200 flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 创建区（仅 owner 可见） */}
        {canCreate && (
          <div className="px-5 pt-4 pb-3"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {pendingSelection ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                    选中内容
                  </span>
                  <button onClick={onClearPending}
                    className="text-[10px] cursor-pointer hover:underline"
                    style={{ color: 'var(--text-muted)' }}>
                    清除
                  </button>
                </div>
                <div className="px-3 py-2 rounded-[8px] text-[11px] mb-2 max-h-24 overflow-y-auto"
                  style={{
                    background: 'rgba(168,85,247,0.08)',
                    border: '1px solid rgba(168,85,247,0.18)',
                    color: 'var(--text-secondary, rgba(255,255,255,0.78))',
                  }}>
                  {pendingSelection.selectedText}
                </div>
              </>
            ) : (
              <div className="px-3 py-2.5 rounded-[8px] text-[11px] mb-2"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px dashed rgba(255,255,255,0.08)',
                  color: 'var(--text-muted)',
                }}>
                在文档正文里选中一段文字，再在下方写评论
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="写下你的批注…（⌘/Ctrl + Enter 发送）"
              rows={3}
              className="w-full px-3 py-2 rounded-[8px] text-[12px] outline-none resize-none"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-primary)',
              }}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <CornerDownLeft size={9} className="inline mr-1" />
                ⌘/Ctrl + Enter 发送
              </span>
              <button
                onClick={handleSubmit}
                disabled={submitting || !pendingSelection || !draft.trim()}
                className="h-7 px-3 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: 'rgba(168,85,247,0.12)',
                  border: '1px solid rgba(168,85,247,0.25)',
                  color: 'rgba(216,180,254,0.95)',
                }}>
                {submitting ? <MapSpinner size={11} /> : <Send size={11} />}
                添加评论
              </button>
            </div>
          </div>
        )}

        {/* 评论列表 */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <MapSectionLoader text="加载评论…" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {comments.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <MessageSquareText size={22} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.2)' }} />
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  还没有评论
                </p>
                {!canCreate && (
                  <p className="text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                    只有知识库所有者可以添加评论
                  </p>
                )}
              </div>
            ) : (
              <div className="p-5 space-y-3">
                {activeComments.map(c => (
                  <CommentCard
                    key={c.id}
                    comment={c}
                    canDelete={canCreate}
                    onDelete={() => handleDelete(c)}
                    onLocate={onLocate}
                  />
                ))}
                {orphanedComments.length > 0 && (
                  <div className="mt-5 pt-4"
                    style={{ borderTop: '1px dashed rgba(255,255,255,0.08)' }}>
                    <div className="flex items-center gap-1.5 mb-3">
                      <AlertTriangle size={11} style={{ color: 'rgba(245,158,11,0.9)' }} />
                      <span className="text-[11px] font-semibold" style={{ color: 'rgba(245,158,11,0.9)' }}>
                        {orphanedComments.length} 条失锚评论
                      </span>
                    </div>
                    <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                      文档内容更新后，以下评论原文已不存在
                    </p>
                    {orphanedComments.map(c => (
                      <CommentCard
                        key={c.id}
                        comment={c}
                        canDelete={canCreate}
                        onDelete={() => handleDelete(c)}
                        orphaned
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  canDelete,
  orphaned,
  onDelete,
  onLocate,
}: {
  comment: DocumentInlineComment;
  canDelete: boolean;
  orphaned?: boolean;
  onDelete: () => void;
  onLocate?: (selectedText: string) => void;
}) {
  return (
    <div className="p-3 rounded-[10px]"
      style={{
        background: orphaned ? 'rgba(245,158,11,0.04)' : 'rgba(255,255,255,0.03)',
        border: orphaned ? '1px solid rgba(245,158,11,0.15)' : '1px solid rgba(255,255,255,0.06)',
      }}>
      {/* 引用块（被评论的原文） */}
      <div className="mb-2 pl-2 py-1 text-[11px]"
        style={{
          borderLeft: orphaned ? '2px dashed rgba(245,158,11,0.5)' : '2px solid rgba(168,85,247,0.4)',
          color: 'var(--text-muted)',
          cursor: onLocate && !orphaned ? 'pointer' : 'default',
        }}
        onClick={() => { if (onLocate && !orphaned) onLocate(comment.selectedText); }}
        title={onLocate && !orphaned ? '点击定位到正文位置' : undefined}>
        {comment.selectedText.length > 140
          ? comment.selectedText.slice(0, 140) + '…'
          : comment.selectedText}
      </div>
      {/* 评论内容 */}
      <div className="flex items-start gap-2 mb-2">
        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(59,130,246,0.1)' }}>
          <UserCircle2 size={13} style={{ color: 'rgba(96,165,250,0.95)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {comment.authorDisplayName}
            </span>
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
              {formatRelative(comment.createdAt)}
            </span>
          </div>
          <p className="text-[12px] whitespace-pre-wrap break-words"
            style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>
            {comment.content}
          </p>
        </div>
      </div>
      {canDelete && (
        <div className="flex justify-end">
          <button onClick={onDelete}
            className="text-[10px] cursor-pointer flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: 'rgba(239,68,68,0.85)' }}>
            <Trash2 size={10} /> 删除
          </button>
        </div>
      )}
    </div>
  );
}
