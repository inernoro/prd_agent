import { useState } from 'react';
import { MessageSquare, CornerDownRight, Trash2, Pencil } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { ReportComment } from '@/services/contracts/reportAgent';
import type { ReportKind } from '../reportInteractionApi';
import { underlineStroke, type ReportCommentAnchor } from './reportCommentAnchor';
import { ReportCommentComposer, ReportCommentAttachmentGrid } from './ReportCommentComposer';

/** 当前打开的评论输入目标（段落评论 / 回复 / 划词评论） */
export interface ReportReplyTarget {
  sectionIndex: number;
  parentId?: string;
  anchor?: ReportCommentAnchor;
}

/**
 * 单个章节下的评论区：顶级评论 + 回复 + 「评论」按钮 + 输入框。
 * 周报详情与月报详情共用；接口差异由 kind 决定（见 reportInteractionApi）。
 */
export function ReportSectionComments({
  reportId,
  kind = 'weekly',
  sectionIndex,
  sectionTitle,
  sectionComments,
  currentUserId,
  isLight,
  accentBorder,
  flashCommentId,
  replyTo,
  submitting,
  indent = true,
  onOpenInput,
  onCancel,
  onSubmit,
  onDelete,
  onEdit,
}: {
  reportId: string;
  kind?: ReportKind;
  sectionIndex: number;
  sectionTitle: string;
  sectionComments: ReportComment[];
  currentUserId?: string;
  isLight: boolean;
  /** 评论列表左侧竖线颜色 */
  accentBorder: string;
  flashCommentId: string | null;
  replyTo: ReportReplyTarget | null;
  submitting: boolean;
  /** 周报详情正文有序号缩进，评论区跟随缩进；月报章节卡片内不缩进 */
  indent?: boolean;
  onOpenInput: (sectionIndex: number, parentId?: string) => void;
  onCancel: () => void;
  onSubmit: (content: string, attachmentIds: string[]) => void | Promise<void>;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, content: string) => Promise<boolean>;
}) {
  const topLevel = sectionComments.filter((c) => !c.parentCommentId);
  const idx = sectionIndex;
  return (
    <>
      {/* Section comments */}
      {topLevel.length > 0 && (
        <div
          className={`mt-2 pl-3 ${indent ? 'ml-10' : ''}`}
          style={{ borderLeft: `2px solid ${accentBorder}` }}
        >
          {topLevel.map((comment) => {
            const replies = sectionComments.filter((c) => c.parentCommentId === comment.id);
            return (
              <div
                key={comment.id}
                id={`report-comment-${comment.id}`}
                className="mb-2"
                style={{
                  borderRadius: 10,
                  transition: 'box-shadow 0.3s',
                  boxShadow: flashCommentId === comment.id ? `0 0 0 2px ${underlineStroke(isLight, true)}` : undefined,
                }}
              >
                <CommentItem
                  comment={comment}
                  isMine={!!currentUserId && comment.authorUserId === currentUserId}
                  onDelete={() => onDelete(comment.id)}
                  onReply={() => onOpenInput(idx, comment.id)}
                  onEdit={(newContent) => onEdit(comment.id, newContent)}
                  quoteUnderline={underlineStroke(isLight)}
                />
                {replies.map((reply) => (
                  <div key={reply.id} className="ml-4 mt-1">
                    <CommentItem
                      comment={reply}
                      isMine={!!currentUserId && reply.authorUserId === currentUserId}
                      onDelete={() => onDelete(reply.id)}
                      onReply={() => onOpenInput(idx, comment.id)}
                      onEdit={(newContent) => onEdit(reply.id, newContent)}
                      isReply
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <button
        className={`mt-1.5 ${indent ? 'ml-7' : '-ml-1.5'} flex items-center gap-1 px-1.5 py-0.5 rounded hover-bg-soft text-[11px]`}
        style={{ color: 'var(--text-muted)' }}
        onClick={() => onOpenInput(idx)}
      >
        <MessageSquare size={10} /> 评论
      </button>

      {replyTo?.sectionIndex === idx && (
        <div className={`mt-2 ${indent ? 'ml-7' : ''} p-3 rounded-xl`} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
            {replyTo.parentId
              ? '回复评论'
              : replyTo.anchor
                ? (
                  <>
                    评论选中内容：
                    <span style={{ borderBottom: `2px solid ${underlineStroke(isLight)}`, paddingBottom: 1 }}>
                      「{replyTo.anchor.selectedText.length > 40 ? `${replyTo.anchor.selectedText.slice(0, 40)}…` : replyTo.anchor.selectedText}」
                    </span>
                  </>
                )
                : `评论「${sectionTitle}」`}
          </div>
          <ReportCommentComposer
            key={`${replyTo.sectionIndex}:${replyTo.parentId ?? ''}:${replyTo.anchor?.selectedText ?? ''}`}
            reportId={reportId}
                kind={kind}
            submitting={submitting}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </div>
      )}
    </>
  );
}

export function CommentItem({
  comment,
  isMine,
  onDelete,
  onReply,
  onEdit,
  isReply,
  quoteUnderline,
}: {
  comment: ReportComment;
  isMine: boolean;
  onDelete: () => void;
  onReply: () => void;
  onEdit: (newContent: string) => Promise<boolean>;
  isReply?: boolean;
  /** 划词评论引用片段的下划线颜色（与正文黄色下划线同色，视觉上连成一体） */
  quoteUnderline?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(comment.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(comment.content);
  };

  const saveEdit = async () => {
    if (saving) return;
    setSaving(true);
    const ok = await onEdit(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  const isEdited = !!comment.updatedAt && comment.updatedAt !== comment.createdAt;

  return (
    <div className="group flex items-start gap-1.5">
      {isReply && <CornerDownRight size={10} style={{ color: 'var(--text-muted)', marginTop: 2 }} />}
      <div
        className="flex-1 min-w-0 rounded-lg px-2.5 py-2 border"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {comment.authorDisplayName}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-md"
            style={{ background: 'rgba(99, 102, 241, 0.08)', color: 'var(--accent-fg-violet)' }}
          >
            评论
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {new Date(comment.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
          {isEdited && (
            <span
              className="text-[10px]"
              style={{ color: 'var(--text-muted)' }}
              title={`编辑于 ${new Date(comment.updatedAt!).toLocaleString('zh-CN')}`}
            >
              · 已编辑
            </span>
          )}
        </div>
        {comment.selectedText && (
          <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--text-muted)' }} title={comment.selectedText}>
            引用：
            <span style={{ borderBottom: `2px solid ${quoteUnderline ?? 'rgba(234, 179, 8, 0.75)'}`, paddingBottom: 1 }}>
              {comment.selectedText.length > 60 ? `${comment.selectedText.slice(0, 60)}…` : comment.selectedText}
            </span>
          </div>
        )}
        {editing ? (
          <div className="mt-1.5">
            <textarea
              className="w-full text-[12px] px-2.5 py-1.5 rounded-md resize-none"
              style={{
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-primary)',
                minHeight: 60,
              }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              autoFocus
              disabled={saving}
            />
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={saveEdit}
                disabled={saving || !draft.trim() || draft.trim() === comment.content}
              >
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {comment.content && (
              <div className="text-[12px] leading-relaxed mt-1 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
                {comment.content}
              </div>
            )}
            <ReportCommentAttachmentGrid attachments={comment.attachments} />
          </>
        )}
      </div>
      {!editing && (
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
          <button className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" onClick={onReply} title="回复">
            <CornerDownRight size={10} style={{ color: 'var(--text-muted)' }} />
          </button>
          {isMine && (
            <>
              <button className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" onClick={startEdit} title="编辑">
                <Pencil size={10} style={{ color: 'var(--text-muted)' }} />
              </button>
              <button className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" onClick={onDelete} title="删除">
                <Trash2 size={10} style={{ color: 'rgba(239, 68, 68, 0.7)' }} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
