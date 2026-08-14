import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, MessageSquare, CornerDownRight, Trash2, GitCompare } from 'lucide-react';
import { formatWeekDateRange } from '../utils/weekRange';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { getWeeklyReport, listComments, createComment, deleteComment } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { WeeklyReport, ReportComment } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportInputType } from '@/services/contracts/reportAgent';
import { PlanComparisonPanel } from './PlanComparisonPanel';
import { ReportTableSectionView } from './ReportTableSectionView';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';
import { ReportLikeBar } from './ReportLikeBar';
import { useDataTheme } from '../hooks/useDataTheme';
import { ReportSelectionCommentLayer } from './ReportSelectionCommentLayer';
import { underlineStroke, type ReportCommentAnchor } from './reportCommentAnchor';
import { ReportCommentComposer, ReportCommentAttachmentGrid } from './ReportCommentComposer';

interface Props {
  reportId: string;
  onClose: () => void;
  onReview?: () => void;
  onReturn?: () => void;
}

type TabKey = 'content' | 'plan-comparison';

// Section accent colors
const sectionColors = [
  'rgba(59, 130, 246, 0.9)',
  'rgba(34, 197, 94, 0.9)',
  'rgba(168, 85, 247, 0.9)',
  'rgba(249, 115, 22, 0.9)',
  'rgba(236, 72, 153, 0.9)',
  'rgba(20, 184, 166, 0.9)',
];

export function ReportDetailPanel({ reportId, onClose, onReview, onReturn }: Props) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [comments, setComments] = useState<ReportComment[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('content');
  const [replyTo, setReplyTo] = useState<{ sectionIndex: number; parentId?: string; anchor?: ReportCommentAnchor } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const currentUserId = useAuthStore((s) => s.user?.userId);
  /** 正文容器（划词评论层的定位坐标系） */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 点击下划线角标后短暂标亮的目标评论 */
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);

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

  const handleCreateComment = async (content: string, attachmentIds: string[]) => {
    if (!replyTo || (!content && attachmentIds.length === 0)) return;
    setSubmitting(true);
    const anchor = !replyTo.parentId ? replyTo.anchor : undefined;
    const res = await createComment({
      reportId,
      sectionIndex: replyTo.sectionIndex,
      content,
      parentCommentId: replyTo.parentId,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      selectedText: anchor?.selectedText,
      contextBefore: anchor?.contextBefore,
      contextAfter: anchor?.contextAfter,
      startOffset: anchor?.startOffset,
      endOffset: anchor?.endOffset,
    });
    setSubmitting(false);
    if (res.success) {
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

  // 切换评论目标时依赖 composer 的 key 变化自动重置草稿（文本 + 待发图片）
  const openCommentInput = (sectionIndex: number, parentId?: string) => {
    setReplyTo({ sectionIndex, parentId });
  };

  /** 划词后点「评论」：带锚点打开该段落的评论输入框 */
  const handleSelectionComment = useCallback((sectionIndex: number, anchor: ReportCommentAnchor) => {
    setReplyTo({ sectionIndex, anchor });
  }, []);

  /** 点击正文黄色下划线角标 → 滚动并短暂标亮对应评论 */
  const handleActivateThread = useCallback((comment: ReportComment) => {
    setFlashCommentId(comment.id);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashCommentId(null), 2400);
    requestAnimationFrame(() => {
      document.getElementById(`report-panel-comment-${comment.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

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
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--modal-overlay)' }}>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--modal-overlay)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
      <GlassCard className="p-0 w-[720px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <div>
            <div
              className="text-[19px] font-semibold"
              style={{
                color: 'var(--text-primary)',
                fontFamily: isLight ? 'var(--font-serif)' : undefined,
                letterSpacing: isLight ? '-0.01em' : undefined,
                lineHeight: 1.2,
              }}
            >
              {report.userName} 的周报
            </div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {report.teamName} · {formatWeekDateRange({ weekYear: report.weekYear, weekNumber: report.weekNumber })} · W{String(report.weekNumber).padStart(2, '0')}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* Return banner */}
        {report.status === WeeklyReportStatus.Returned && report.returnReason && (
          <div className="px-5 py-2.5" style={{ background: 'rgba(239, 68, 68, 0.06)', borderBottom: '1px solid rgba(239, 68, 68, 0.1)' }}>
            <div className="text-[11px]" style={{ color: 'var(--accent-fg-danger)' }}>
              <span className="font-medium">{report.returnedByName || '审阅人'}</span> 退回了此周报
              {report.returnedAt && <span> · {new Date(report.returnedAt).toLocaleDateString()}</span>}
              <div className="mt-0.5">原因：{report.returnReason}</div>
            </div>
          </div>
        )}

        {/* Tabs — 选中态仅靠 加粗 + Claude 橙下划线两层信号(去掉背景填充,避免 3 层视觉冗余) */}
        <div className="flex items-center gap-1 px-6 pt-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          {tabs.map((tab) => {
            const activeUnderline = isLight ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.8)';
            return (
              <button
                key={tab.key}
                className="px-4 py-2.5 text-[13px] rounded-t-lg transition-all duration-200"
                style={{
                  color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: 'transparent',
                  fontWeight: activeTab === tab.key ? 600 : 400,
                  borderBottom: activeTab === tab.key ? `2px solid ${activeUnderline}` : '2px solid transparent',
                }}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.key === 'plan-comparison' && <GitCompare size={12} className="inline mr-1.5" />}
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          {activeTab === 'content' && (
            // relative：划词评论层（下划线/角标/评论按钮）的定位坐标系
            <div ref={contentRef} className="relative">
              {report.sections.map((section, idx) => {
                const sectionComments = commentsBySection[idx] || [];
                const topLevel = sectionComments.filter((c) => !c.parentCommentId);
                const accentColor = sectionColors[idx % sectionColors.length];

                return (
                  <div key={idx} className="mb-5">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div
                        className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold text-token-primary flex-shrink-0"
                        style={{
                          background: isLight ? accentColor.replace('0.9', '1') : accentColor,
                          boxShadow: isLight
                            ? `0 2px 6px ${accentColor.replace('0.9', '0.18')}`
                            : `0 1px 4px ${accentColor.replace('0.9', '0.25')}`,
                        }}
                      >
                        {idx + 1}
                      </div>
                      <span
                        className="text-[15px] font-semibold"
                        style={{
                          color: 'var(--text-primary)',
                          fontFamily: isLight ? 'var(--font-serif)' : undefined,
                          letterSpacing: isLight ? '-0.005em' : undefined,
                        }}
                      >
                        {section.templateSection.title}
                      </span>
                    </div>
                    {/* data-report-section：划词评论的段落锚定根（选区必须完整落在同一块内） */}
                    <div data-report-section={idx}>
                    {section.items.length === 0 ? (
                      <div className="text-[12px] ml-7" style={{ color: 'var(--text-muted)' }}>（未填写）</div>
                    ) : section.templateSection.inputType === ReportInputType.IssueList ? (
                      <div className="space-y-2.5 ml-7">
                        {section.items.map((item, iIdx) => {
                          const cat = section.templateSection.issueCategories?.find((c) => c.key === item.issueCategoryKey);
                          const st  = section.templateSection.issueStatuses?.find((s) => s.key === item.issueStatusKey);
                          return (
                            <div
                              key={iIdx}
                              className="rounded-lg p-3"
                              style={{
                                background: isLight ? 'var(--bg-nested)' : 'var(--bg-secondary)',
                                border: '1px solid var(--hairline)',
                              }}
                            >
                              {(cat || st) && (
                                <div className="flex items-center gap-2 mb-2">
                                  {cat && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                                      style={{
                                        color: cat.color || 'var(--text-secondary)',
                                        background: 'rgba(51,65,85,0.08)',
                                        border: '1px solid rgba(51,65,85,0.18)',
                                      }}
                                    >
                                      {cat.label}
                                    </span>
                                  )}
                                  {st && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                                      style={{
                                        color: st.color || 'var(--accent-claude)',
                                        background: 'var(--accent-claude-soft)',
                                        border: '1px solid var(--accent-claude-border)',
                                      }}
                                    >
                                      {st.label}
                                    </span>
                                  )}
                                </div>
                              )}
                              <RichTextMarkdownContent content={item.content} imageMaxHeight={220} />
                            </div>
                          );
                        })}
                      </div>
                    ) : section.templateSection.inputType === ReportInputType.Table ? (
                      <div className="ml-7">
                        <ReportTableSectionView section={section} isLight={isLight} />
                      </div>
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
                    </div>

                    {/* Section comments */}
                    {topLevel.length > 0 && (
                      <div className="mt-2 ml-7 pl-3" style={{ borderLeft: `2px solid ${accentColor}30` }}>
                        {topLevel.map((comment) => {
                          const replies = sectionComments.filter((c) => c.parentCommentId === comment.id);
                          return (
                            <div
                              key={comment.id}
                              id={`report-panel-comment-${comment.id}`}
                              className="mb-2"
                              style={{
                                borderRadius: 10,
                                transition: 'box-shadow 0.3s',
                                boxShadow: flashCommentId === comment.id ? `0 0 0 2px ${underlineStroke(isLight, true)}` : undefined,
                              }}
                            >
                              <CommentItem
                                comment={comment}
                                isMine={comment.authorUserId === currentUserId}
                                onDelete={() => handleDeleteComment(comment.id)}
                                onReply={() => openCommentInput(idx, comment.id)}
                                quoteUnderline={underlineStroke(isLight)}
                              />
                              {replies.map((reply) => (
                                <div key={reply.id} className="ml-4 mt-1">
                                  <CommentItem
                                    comment={reply}
                                    isMine={reply.authorUserId === currentUserId}
                                    onDelete={() => handleDeleteComment(reply.id)}
                                    onReply={() => openCommentInput(idx, comment.id)}
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
                      className="mt-1.5 ml-7 flex items-center gap-1 px-1.5 py-0.5 rounded hover-bg-soft text-[11px]"
                      style={{ color: 'var(--text-muted)' }}
                      onClick={() => openCommentInput(idx)}
                    >
                      <MessageSquare size={10} /> 评论
                    </button>

                    {replyTo?.sectionIndex === idx && (
                      <div className="mt-2 ml-7 p-3 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
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
                              : `评论「${report.sections[replyTo.sectionIndex]?.templateSection?.title || ''}」`}
                        </div>
                        <ReportCommentComposer
                          key={`${replyTo.sectionIndex}:${replyTo.parentId ?? ''}:${replyTo.anchor?.selectedText ?? ''}`}
                          reportId={reportId}
                          submitting={submitting}
                          onSubmit={handleCreateComment}
                          onCancel={() => setReplyTo(null)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              <ReportSelectionCommentLayer
                containerRef={contentRef}
                comments={comments}
                isLight={isLight}
                reflowKey={`${report.id}:${report.sections.length}`}
                onCreateFromSelection={handleSelectionComment}
                onActivateThread={handleActivateThread}
              />
            </div>
          )}

          {activeTab === 'plan-comparison' && <PlanComparisonPanel reportId={reportId} />}
        </div>

        <div className="px-6 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <ReportLikeBar reportId={report.id} compact />
        </div>

        {/* Footer */}
        {(report.status === WeeklyReportStatus.Submitted || report.status === WeeklyReportStatus.Reviewed) && (onReview || onReturn) && (
          <div className="flex items-center justify-end gap-2 px-6 py-4">
            {onReturn && (
              <Button variant="secondary" size="sm" onClick={onReturn}>退回</Button>
            )}
            {report.status === WeeklyReportStatus.Submitted && onReview && (
              <Button variant="primary" size="sm" onClick={onReview}>审阅通过</Button>
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
  quoteUnderline,
}: {
  comment: ReportComment;
  isMine: boolean;
  onDelete: () => void;
  onReply: () => void;
  isReply?: boolean;
  /** 划词评论引用片段的下划线颜色（与正文黄色下划线同色） */
  quoteUnderline?: string;
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
            style={{ background: 'rgba(99, 102, 241, 0.08)', color: 'var(--accent-fg-violet)' }}
          >
            评论
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {new Date(comment.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        {comment.selectedText && (
          <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--text-muted)' }} title={comment.selectedText}>
            引用：
            <span style={{ borderBottom: `2px solid ${quoteUnderline ?? 'rgba(234, 179, 8, 0.75)'}`, paddingBottom: 1 }}>
              {comment.selectedText.length > 60 ? `${comment.selectedText.slice(0, 60)}…` : comment.selectedText}
            </span>
          </div>
        )}
        {comment.content && (
          <div className="text-[12px] leading-relaxed mt-1 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{comment.content}</div>
        )}
        <ReportCommentAttachmentGrid attachments={comment.attachments} />
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
