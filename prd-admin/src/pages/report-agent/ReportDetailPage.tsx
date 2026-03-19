import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, MessageSquare, CornerDownRight, Trash2, Send, GitCompare, X, CheckCircle2 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { getWeeklyReport, listComments, createComment, deleteComment, reviewWeeklyReport, returnWeeklyReport } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { WeeklyReport, ReportComment } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportInputType } from '@/services/contracts/reportAgent';
import { PlanComparisonPanel } from './components/PlanComparisonPanel';
import { RichTextMarkdownContent } from './components/RichTextMarkdownContent';
import { ReportLikeBar } from './components/ReportLikeBar';

type TabKey = 'content' | 'plan-comparison';

const sectionColors = [
  'rgba(59, 130, 246, 0.9)',
  'rgba(34, 197, 94, 0.9)',
  'rgba(168, 85, 247, 0.9)',
  'rgba(249, 115, 22, 0.9)',
  'rgba(236, 72, 153, 0.9)',
  'rgba(20, 184, 166, 0.9)',
];

export default function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [comments, setComments] = useState<ReportComment[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('content');
  const [replyTo, setReplyTo] = useState<{ sectionIndex: number; parentId?: string } | null>(null);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const currentUserId = useAuthStore((s) => s.user?.userId);

  // Return dialog state
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [returnReason, setReturnReason] = useState('');

  useEffect(() => {
    if (!reportId) return;
    (async () => {
      const res = await getWeeklyReport({ id: reportId });
      if (res.success && res.data) setReport(res.data.report);
    })();
    loadComments();
  }, [reportId]);

  const loadComments = async () => {
    if (!reportId) return;
    const res = await listComments({ reportId });
    if (res.success && res.data) setComments(res.data.items);
  };

  const handleCreateComment = async () => {
    if (!replyTo || !commentText.trim() || !reportId) return;
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
    if (!reportId) return;
    const res = await deleteComment({ reportId, commentId });
    if (res.success) {
      await loadComments();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const handleReview = async () => {
    if (!reportId) return;
    const res = await reviewWeeklyReport({ id: reportId });
    if (res.success) {
      toast.success('已审阅');
      if (res.data) setReport(res.data.report);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleReturn = async () => {
    if (!reportId) return;
    const reason = returnReason.trim();
    if (!reason) {
      toast.error('请填写退回原因');
      return;
    }
    const res = await returnWeeklyReport({ id: reportId, reason });
    if (res.success) {
      toast.success('已退回');
      setShowReturnDialog(false);
      setReturnReason('');
      if (res.data) setReport(res.data.report);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

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
      <div className="h-full flex items-center justify-center">
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      </div>
    );
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'content', label: '内容' },
    { key: 'plan-comparison', label: '计划比对' },
  ];

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Return Dialog */}
      {showReturnDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <GlassCard className="p-6 w-[440px]">
            <div className="text-[16px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>退回周报</div>
            <textarea
              className="w-full text-[13px] px-4 py-3 rounded-xl resize-none"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 100 }}
              placeholder="请输入退回原因（必填）..."
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => { setShowReturnDialog(false); setReturnReason(''); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleReturn} disabled={!returnReason.trim()}>确认退回</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Header */}
      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <div className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {report.userName} 的周报
              </div>
              <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {report.teamName} · {report.weekYear} 年第 {report.weekNumber} 周
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(report.status === WeeklyReportStatus.Submitted || report.status === WeeklyReportStatus.Reviewed) && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setShowReturnDialog(true)}>退回</Button>
                {report.status === WeeklyReportStatus.Submitted && (
                  <Button variant="primary" size="sm" onClick={handleReview}>
                    <CheckCircle2 size={13} className="mr-1" /> 审阅通过
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </GlassCard>

      {/* Return banner */}
      {report.status === WeeklyReportStatus.Returned && report.returnReason && (
        <div className="px-5 py-2.5 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.1)' }}>
          <div className="text-[11px]" style={{ color: 'rgba(239, 68, 68, 0.85)' }}>
            <span className="font-medium">{report.returnedByName || '审阅人'}</span> 退回了此周报
            {report.returnedAt && <span> · {new Date(report.returnedAt).toLocaleDateString()}</span>}
            <div className="mt-0.5">原因：{report.returnReason}</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 px-1" style={{ borderBottom: '1px solid var(--border-primary)' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className="px-4 py-2.5 text-[13px] rounded-t-lg transition-all duration-200"
            style={{
              color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
              background: activeTab === tab.key ? 'var(--bg-secondary)' : 'transparent',
              fontWeight: activeTab === tab.key ? 600 : 400,
              borderBottom: activeTab === tab.key ? '2px solid rgba(59, 130, 246, 0.8)' : '2px solid transparent',
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.key === 'plan-comparison' && <GitCompare size={12} className="inline mr-1.5" />}
            {tab.label}
            {tab.key === 'content' && comments.length > 0 && (
              <span
                className="ml-2 text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'rgba(59, 130, 246, 0.08)', color: 'rgba(59, 130, 246, 0.9)' }}
              >
                {comments.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === 'content' && (
          <GlassCard variant="subtle" className="p-6">
            {report.sections.map((section, idx) => {
              const sectionComments = commentsBySection[idx] || [];
              const topLevel = sectionComments.filter((c) => !c.parentCommentId);
              const accentColor = sectionColors[idx % sectionColors.length];

              return (
                <div key={idx} className="mb-5">
                  <div className="flex items-center gap-2.5 mb-3">
                    <div
                      className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                      style={{ background: accentColor, boxShadow: `0 1px 4px ${accentColor.replace('0.9', '0.25')}` }}
                    >
                      {idx + 1}
                    </div>
                    <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {section.templateSection.title}
                    </span>
                  </div>
                  {section.items.length === 0 ? (
                    <div className="text-[12px] ml-7" style={{ color: 'var(--text-muted)' }}>（未填写）</div>
                  ) : section.templateSection.inputType === ReportInputType.RichText ? (
                    <div className="space-y-2 ml-7">
                      {section.items.map((item, iIdx) => (
                        <RichTextMarkdownContent
                          key={iIdx}
                          content={item.content}
                          imageMaxHeight={260}
                        />
                      ))}
                    </div>
                  ) : (
                    <ul className="space-y-1.5 ml-7">
                      {section.items.map((item, iIdx) => (
                        <li key={iIdx} className="flex items-start gap-2">
                          <span className="text-[13px] mt-0.5 font-medium" style={{ color: accentColor }}>•</span>
                          <span className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {item.content || '（空）'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Section comments */}
                  {topLevel.length > 0 && (
                    <div className="mt-2 ml-7 pl-3" style={{ borderLeft: `2px solid ${accentColor}30` }}>
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

                  <button
                    className="mt-1.5 ml-7 flex items-center gap-1 text-[11px] hover:opacity-80 transition-opacity"
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
              <div className="mt-3 p-3 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  {replyTo.parentId ? '回复评论' : `评论「${report.sections[replyTo.sectionIndex]?.templateSection?.title || ''}」`}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 text-[12px] px-3 py-2 rounded-lg"
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
          </GlassCard>
        )}

        {activeTab === 'plan-comparison' && reportId && (
          <GlassCard variant="subtle" className="p-6">
            <PlanComparisonPanel reportId={reportId} />
          </GlassCard>
        )}
      </div>

      <GlassCard variant="subtle" className="px-5 py-3">
        <ReportLikeBar reportId={report.id} />
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
            style={{ background: 'rgba(99, 102, 241, 0.08)', color: 'rgba(99, 102, 241, 0.82)' }}
          >
            评论
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {new Date(comment.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="text-[12px] leading-relaxed mt-1 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{comment.content}</div>
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
