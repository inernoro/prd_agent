import { useState, useEffect, useMemo } from 'react';
import { X, MessageSquare, CornerDownRight, Trash2, Send, GitCompare, Download } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { getWeeklyReport, listComments, createComment, deleteComment, exportReportMarkdown } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { WeeklyReport, ReportComment } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { PlanComparisonPanel } from './PlanComparisonPanel';

interface Props {
  reportId: string;
  onClose: () => void;
  onReview?: () => void;
  onReturn?: () => void;
}

type TabKey = 'content' | 'plan-comparison';

export function ReportDetailPanel({ reportId, onClose, onReview, onReturn }: Props) {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [comments, setComments] = useState<ReportComment[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('content');
  const [replyTo, setReplyTo] = useState<{ sectionIndex: number; parentId?: string } | null>(null);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const currentUserId = useAuthStore((s) => s.user?.userId);

  useEffect(() => {
    (async () => {
      const res = await getWeeklyReport({ id: reportId });
      if (res.success && res.data) setReport(res.data.report);
    })();
    loadComments();
  }, [reportId]);

  const loadComments = async () => {
    const res = await listComments({ reportId });
    if (res.success && res.data) setComments(res.data.items);
  };

  const handleCreateComment = async () => {
    if (!replyTo || !commentText.trim()) return;
    setSubmitting(true);
    const res = await createComment({
      reportId,
      sectionIndex: replyTo.sectionIndex,
      content: commentText.trim(),
      parentCommentId: replyTo.parentId,
    });
    setSubmitting(false);
    if (res.success) {
      setCommentText('');
      setReplyTo(null);
      await loadComments();
    } else {
      toast.error(res.error?.message || '评论失败');
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    const res = await deleteComment({ reportId, commentId });
    if (res.success) {
      await loadComments();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  // Group comments by section
  const commentsBySection = useMemo(() => {
    const map: Record<number, ReportComment[]> = {};
    for (const c of comments) {
      if (!map[c.sectionIndex]) map[c.sectionIndex] = [];
      map[c.sectionIndex].push(c);
    }
    return map;
  }, [comments]);

  if (!report) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
        <GlassCard className="p-6 w-[500px]">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        </GlassCard>
      </div>
    );
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'content', label: '内容' },
    { key: 'plan-comparison', label: '计划比对' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
      <GlassCard className="p-0 w-[650px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <div>
            <div className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {report.userName} 的周报
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {report.teamName} · {report.weekYear} 年第 {report.weekNumber} 周
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={async () => {
              try {
                const blob = await exportReportMarkdown({ id: reportId });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `周报_${report?.userName ?? ''}_${report?.weekYear}W${String(report?.weekNumber ?? 0).padStart(2, '0')}.md`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success('导出成功');
              } catch { toast.error('导出失败'); }
            }}>
              <Download size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* Return banner */}
        {report.status === WeeklyReportStatus.Returned && report.returnReason && (
          <div className="px-4 py-2 flex items-start gap-2" style={{ background: 'rgba(239, 68, 68, 0.08)', borderBottom: '1px solid rgba(239, 68, 68, 0.15)' }}>
            <div className="text-[11px]" style={{ color: 'rgba(239, 68, 68, 0.9)' }}>
              <span className="font-medium">{report.returnedByName || '审阅人'}</span> 退回了此周报
              {report.returnedAt && <span> · {new Date(report.returnedAt).toLocaleDateString()}</span>}
              <div className="mt-0.5" style={{ color: 'rgba(239, 68, 68, 0.75)' }}>
                原因：{report.returnReason}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-2" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className="px-3 py-1.5 text-[12px] rounded-t transition-colors"
              style={{
                color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
                background: activeTab === tab.key ? 'var(--bg-secondary)' : 'transparent',
                fontWeight: activeTab === tab.key ? 500 : 400,
              }}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.key === 'plan-comparison' && <GitCompare size={11} className="inline mr-1" />}
              {tab.label}
              {tab.key === 'content' && comments.length > 0 && (
                <span className="ml-1 text-[10px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)' }}>
                  {comments.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
          {activeTab === 'content' && (
            <>
              {report.sections.map((section, idx) => {
                const sectionComments = commentsBySection[idx] || [];
                const topLevel = sectionComments.filter((c) => !c.parentCommentId);

                return (
                  <div key={idx} className="mb-4">
                    <div className="text-[13px] font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                      {section.templateSection.title}
                    </div>
                    {section.items.length === 0 ? (
                      <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>（未填写）</div>
                    ) : (
                      <ul className="space-y-1">
                        {section.items.map((item, iIdx) => (
                          <li key={iIdx} className="flex items-start gap-2">
                            <span className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>•</span>
                            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                              {item.content || '（空）'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Section comments */}
                    {topLevel.length > 0 && (
                      <div className="mt-2 ml-2 pl-2" style={{ borderLeft: '2px solid var(--border-primary)' }}>
                        {topLevel.map((comment) => {
                          const replies = sectionComments.filter((c) => c.parentCommentId === comment.id);
                          return (
                            <div key={comment.id} className="mb-2">
                              <CommentItem
                                comment={comment}
                                isMine={comment.authorUserId === currentUserId}
                                onDelete={() => handleDeleteComment(comment.id)}
                                onReply={() => setReplyTo({ sectionIndex: idx, parentId: comment.id })}
                              />
                              {replies.map((reply) => (
                                <div key={reply.id} className="ml-4 mt-1">
                                  <CommentItem
                                    comment={reply}
                                    isMine={reply.authorUserId === currentUserId}
                                    onDelete={() => handleDeleteComment(reply.id)}
                                    onReply={() => setReplyTo({ sectionIndex: idx, parentId: comment.id })}
                                    isReply
                                  />
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Add comment button */}
                    <button
                      className="mt-1 flex items-center gap-1 text-[11px] hover:opacity-80 transition-opacity"
                      style={{ color: 'var(--text-muted)' }}
                      onClick={() => setReplyTo({ sectionIndex: idx })}
                    >
                      <MessageSquare size={10} /> 评论
                    </button>
                  </div>
                );
              })}

              {/* Comment input */}
              {replyTo && (
                <div className="mt-3 p-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    {replyTo.parentId ? '回复评论' : `评论「${report.sections[replyTo.sectionIndex]?.templateSection?.title || ''}」`}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 text-[12px] px-2 py-1 rounded"
                      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                      placeholder="输入评论..."
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleCreateComment()}
                      autoFocus
                    />
                    <Button variant="primary" size="sm" onClick={handleCreateComment} disabled={submitting || !commentText.trim()}>
                      <Send size={12} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setReplyTo(null); setCommentText(''); }}>
                      <X size={12} />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'plan-comparison' && <PlanComparisonPanel reportId={reportId} />}
        </div>

        {/* Footer actions */}
        {report.status === WeeklyReportStatus.Submitted && (onReview || onReturn) && (
          <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
            {onReturn && (
              <Button variant="secondary" size="sm" onClick={onReturn}>
                退回
              </Button>
            )}
            {onReview && (
              <Button variant="primary" size="sm" onClick={onReview}>
                审阅通过
              </Button>
            )}
          </div>
        )}
      </GlassCard>
    </div>
  );
}

function CommentItem({
  comment,
  isMine,
  onDelete,
  onReply,
  isReply,
}: {
  comment: ReportComment;
  isMine: boolean;
  onDelete: () => void;
  onReply: () => void;
  isReply?: boolean;
}) {
  return (
    <div className="group flex items-start gap-1.5">
      {isReply && <CornerDownRight size={10} style={{ color: 'var(--text-muted)', marginTop: 2 }} />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {comment.authorDisplayName}
          </span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {new Date(comment.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{comment.content}</div>
      </div>
      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
        <button className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" onClick={onReply} title="回复">
          <CornerDownRight size={10} style={{ color: 'var(--text-muted)' }} />
        </button>
        {isMine && (
          <button className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" onClick={onDelete} title="删除">
            <Trash2 size={10} style={{ color: 'rgba(239, 68, 68, 0.7)' }} />
          </button>
        )}
      </div>
    </div>
  );
}
