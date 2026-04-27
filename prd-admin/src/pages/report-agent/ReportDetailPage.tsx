import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare, CornerDownRight, Trash2, Send, GitCompare, X, CheckCircle2, AlertCircle, Clock, Pencil } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { getWeeklyReport, listComments, createComment, updateComment, deleteComment, reviewWeeklyReport, returnWeeklyReport, recordReportView, getReportViewsSummary, getTeamReportsView } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import type { WeeklyReport, ReportComment, ReportViewSummary, TeamReportListItem } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportInputType } from '@/services/contracts/reportAgent';
import { PlanComparisonPanel } from './components/PlanComparisonPanel';
import { RichTextMarkdownContent } from './components/RichTextMarkdownContent';
import { RightRailPanel } from './components/RightRailPanel';
import { useDataTheme } from './hooks/useDataTheme';

type TabKey = 'content' | 'plan-comparison';

const sectionColors = [
  'rgba(59, 130, 246, 0.9)',
  'rgba(34, 197, 94, 0.9)',
  'rgba(168, 85, 247, 0.9)',
  'rgba(249, 115, 22, 0.9)',
  'rgba(236, 72, 153, 0.9)',
  'rgba(20, 184, 166, 0.9)',
];

export interface ReportDetailPageProps {
  reportIdOverride?: string;
  teamIdOverride?: string;
  weekYearOverride?: number;
  weekNumberOverride?: number;
  onBack?: () => void;
  onSelectSibling?: (reportId: string, userId: string) => void;
  hideSiblings?: boolean;
}

const COLOR_SCHEME_STORAGE_KEY = 'report-agent:color-scheme';

export default function ReportDetailPage(props: ReportDetailPageProps = {}) {
  const { reportId: paramsReportId } = useParams<{ reportId: string }>();
  const reportId = props.reportIdOverride ?? paramsReportId;
  const isStandaloneRoute = !props.reportIdOverride;

  // 独立路由模式下,ReportAgentPage 没有挂载,需要自己把 sessionStorage 里的
  // 偏好同步到 documentElement,保证从列表点"查看"进入后浅色不丢失
  useEffect(() => {
    if (!isStandaloneRoute || typeof document === 'undefined') return;
    const root = document.documentElement;
    const raw = window.sessionStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
    return () => {
      root.removeAttribute('data-theme');
    };
  }, [isStandaloneRoute]);

  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const ctxTeamId = props.teamIdOverride ?? (searchParams.get('teamId') ?? '');
  const ctxWeekYearRaw = props.weekYearOverride ?? Number.parseInt(searchParams.get('weekYear') ?? '', 10);
  const ctxWeekNumberRaw = props.weekNumberOverride ?? Number.parseInt(searchParams.get('weekNumber') ?? '', 10);
  const ctxWeekYear = Number.isFinite(ctxWeekYearRaw) ? ctxWeekYearRaw : null;
  const ctxWeekNumber = Number.isFinite(ctxWeekNumberRaw) ? ctxWeekNumberRaw : null;
  const hasSiblingCtx = !props.hideSiblings && !!ctxTeamId && ctxWeekYear !== null && ctxWeekNumber !== null;

  const [siblings, setSiblings] = useState<TeamReportListItem[]>([]);
  const siblingsKeyRef = useRef<string>('');

  const [report, setReport] = useState<WeeklyReport | null>(null);
  /** 后端授权:当前用户对该周报是否有审阅权限(Leader/Deputy 或全局 ReportAgentViewAll) */
  const [canReview, setCanReview] = useState(false);
  const [comments, setComments] = useState<ReportComment[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('content');
  const [replyTo, setReplyTo] = useState<{ sectionIndex: number; parentId?: string } | null>(null);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [viewSummary, setViewSummary] = useState<ReportViewSummary>({ count: 0, totalViewCount: 0, users: [] });
  const currentUserId = useAuthStore((s) => s.user?.userId);
  const markReportMutated = useReportAgentStore((s) => s.markReportMutated);
  const lastReportMutation = useReportAgentStore((s) => s.lastReportMutation);

  // 审阅/退回后,左侧「本周周报」侧栏对应一行的状态实时翻面(同 TeamDashboard 行为对齐)。
  // 数据源 siblings 是组件本地 state,不在 store,因此需要订阅 store 事件做局部 mutate。
  useEffect(() => {
    if (!lastReportMutation) return;
    setSiblings((prev) => {
      const idx = prev.findIndex((s) => s.reportId === lastReportMutation.reportId);
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = {
        ...next[idx],
        status: lastReportMutation.status,
        submittedAt: lastReportMutation.submittedAt ?? next[idx].submittedAt,
      };
      return next;
    });
  }, [lastReportMutation]);


  // Return dialog state
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [returnReason, setReturnReason] = useState('');

  const loadComments = useCallback(async () => {
    if (!reportId) return;
    const res = await listComments({ reportId });
    if (res.success && res.data) setComments(res.data.items);
  }, [reportId]);

  const loadViewSummary = useCallback(async () => {
    if (!reportId) return;
    const res = await getReportViewsSummary({ reportId });
    if (res.success && res.data) {
      setViewSummary(res.data);
    }
  }, [reportId]);

  const loadViewSummaryAndTrack = useCallback(async () => {
    if (!reportId) return;
    await recordReportView({ reportId });
    await loadViewSummary();
  }, [reportId, loadViewSummary]);

  useEffect(() => {
    if (!reportId) return;
    (async () => {
      const res = await getWeeklyReport({ id: reportId });
      if (res.success && res.data) {
        setReport(res.data.report);
        setCanReview(!!res.data.canReview);
      }
    })();
    void loadComments();
    void loadViewSummaryAndTrack();
  }, [reportId, loadComments, loadViewSummaryAndTrack]);

  useEffect(() => {
    if (!hasSiblingCtx || ctxWeekYear === null || ctxWeekNumber === null) {
      setSiblings([]);
      siblingsKeyRef.current = '';
      return;
    }
    const key = `${ctxTeamId}|${ctxWeekYear}|${ctxWeekNumber}`;
    if (siblingsKeyRef.current === key) return;
    siblingsKeyRef.current = key;
    (async () => {
      const res = await getTeamReportsView({ teamId: ctxTeamId, weekYear: ctxWeekYear, weekNumber: ctxWeekNumber });
      if (res.success && res.data) {
        setSiblings(res.data.items);
      } else {
        setSiblings([]);
      }
    })();
  }, [hasSiblingCtx, ctxTeamId, ctxWeekYear, ctxWeekNumber]);

  const { onSelectSibling: onSelectSiblingProp } = props;
  const handleSelectSibling = useCallback(
    (id: string) => {
      if (id === reportId) return;
      if (onSelectSiblingProp) {
        const target = siblings.find((s) => s.reportId === id);
        onSelectSiblingProp(id, target?.userId ?? '');
        return;
      }
      navigate(`/report-agent/report/${id}?${searchParams.toString()}`, { replace: true });
    },
    [navigate, onSelectSiblingProp, reportId, searchParams, siblings]
  );

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

  const handleUpdateComment = useCallback(async (commentId: string, content: string): Promise<boolean> => {
    if (!reportId) return false;
    const trimmed = content.trim();
    if (!trimmed) {
      toast.error('评论内容不能为空');
      return false;
    }
    const res = await updateComment({ reportId, commentId, content: trimmed });
    if (res.success) {
      await loadComments();
      return true;
    }
    toast.error(res.error?.message || '修改失败');
    return false;
  }, [reportId, loadComments]);

  const openCommentInput = (sectionIndex: number, parentId?: string) => {
    const isSameTarget = replyTo?.sectionIndex === sectionIndex && replyTo?.parentId === parentId;
    if (!isSameTarget) {
      setCommentText('');
    }
    setReplyTo({ sectionIndex, parentId });
  };

  const handleReview = async () => {
    if (!reportId) return;
    const res = await reviewWeeklyReport({ id: reportId });
    if (res.success) {
      toast.success('已审阅');
      if (res.data) {
        setReport(res.data.report);
        markReportMutated({
          reportId: res.data.report.id,
          status: res.data.report.status,
          submittedAt: res.data.report.submittedAt,
          reviewedAt: res.data.report.reviewedAt,
          reviewedBy: res.data.report.reviewedBy,
          reviewedByName: res.data.report.reviewedByName,
        });
      }
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
      if (res.data) {
        setReport(res.data.report);
        markReportMutated({
          reportId: res.data.report.id,
          status: res.data.report.status,
          returnedAt: res.data.report.returnedAt,
          returnedBy: res.data.report.returnedBy,
          returnedByName: res.data.report.returnedByName,
          returnReason: res.data.report.returnReason,
        });
      }
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
    return <MapSectionLoader />;
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'content', label: '内容' },
    { key: 'plan-comparison', label: '计划比对' },
  ];

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Return Dialog */}
      {showReturnDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--modal-overlay)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
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
            <Button variant="ghost" size="sm" onClick={props.onBack ?? (() => navigate(-1))}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <div
                className="text-[20px] font-semibold"
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
                {report.teamName} · {report.weekYear} 年第 {report.weekNumber} 周
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 审阅/退回按钮权限守卫:
                1. canReview 由后端授权(Leader/Deputy/ReportAgentViewAll)
                2. 不能审自己的周报(防自审) */}
            {canReview && report.userId !== currentUserId
              && (report.status === WeeklyReportStatus.Submitted || report.status === WeeklyReportStatus.Reviewed) && (
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

      {/* Return banner — 横跨三栏容器上方 */}
      {report.status === WeeklyReportStatus.Returned && report.returnReason && (
        <div className="px-5 py-2.5 rounded-xl" style={{ background: isLight ? 'rgba(239, 68, 68, 0.05)' : 'rgba(239, 68, 68, 0.06)', border: `1px solid ${isLight ? 'rgba(239, 68, 68, 0.20)' : 'rgba(239, 68, 68, 0.1)'}` }}>
          <div className="text-[11px]" style={{ color: 'rgba(239, 68, 68, 0.85)' }}>
            <span className="font-medium">{report.returnedByName || '审阅人'}</span> 退回了此周报
            {report.returnedAt && <span> · {new Date(report.returnedAt).toLocaleDateString()}</span>}
            <div className="mt-0.5">原因：{report.returnReason}</div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        {hasSiblingCtx && siblings.length > 0 && (
          <SiblingReportsSidebar
            items={siblings}
            currentId={reportId}
            onSelect={handleSelectSibling}
            weekYear={ctxWeekYear ?? undefined}
            weekNumber={ctxWeekNumber ?? undefined}
          />
        )}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-4">
      {/* Tabs — 浅色下选中态走 Claude 橙下划线 */}
      <div className="flex items-center gap-1 px-1" style={{ borderBottom: '1px solid var(--border-primary)' }}>
        {tabs.map((tab) => {
          const activeUnderline = isLight ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.8)';
          const countBg = isLight ? 'var(--accent-claude-soft)' : 'rgba(59, 130, 246, 0.08)';
          const countColor = isLight ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.9)';
          const countBorder = isLight ? '1px solid var(--accent-claude-border)' : 'none';
          return (
            <button
              key={tab.key}
              className="px-4 py-2.5 text-[13px] rounded-t-lg transition-all duration-200"
              style={{
                color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
                background: activeTab === tab.key ? 'var(--bg-secondary)' : 'transparent',
                fontWeight: activeTab === tab.key ? 600 : 400,
                borderBottom: activeTab === tab.key ? `2px solid ${activeUnderline}` : '2px solid transparent',
              }}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.key === 'plan-comparison' && <GitCompare size={12} className="inline mr-1.5" />}
              {tab.label}
              {tab.key === 'content' && comments.length > 0 && (
                <span
                  className="ml-2 text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: countBg, color: countColor, border: countBorder }}
                >
                  {comments.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === 'content' && (
          <GlassCard variant="subtle" className="p-6">
            {report.sections.map((section, idx) => {
              const sectionComments = commentsBySection[idx] || [];
              const topLevel = sectionComments.filter((c) => !c.parentCommentId);
              const accentColor = sectionColors[idx % sectionColors.length];
              // Editorial 风:浅色下数字徽章改为深色单色 + 左侧 hairline 分层,不用饱和背景
              const badgeBg    = isLight ? '#0F172A' : accentColor;
              const badgeGlow  = isLight ? 'none' : `0 1px 4px ${accentColor.replace('0.9', '0.25')}`;
              const bulletClr  = isLight ? 'rgba(15, 23, 42, 0.7)' : accentColor;

              return (
                <div key={idx} className="mb-6">
                  <div
                    className="flex items-center gap-3 mb-3 pb-2"
                    style={{ borderBottom: isLight ? '1px solid var(--hairline)' : undefined }}
                  >
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center text-[12px] font-semibold flex-shrink-0"
                      style={{
                        background: badgeBg,
                        color: '#FFFFFF',
                        boxShadow: badgeGlow,
                        fontFamily: isLight ? 'var(--font-serif)' : undefined,
                      }}
                    >
                      {idx + 1}
                    </div>
                    <span
                      className="text-[16px] font-semibold"
                      style={{
                        color: 'var(--text-primary)',
                        fontFamily: isLight ? 'var(--font-serif)' : undefined,
                        letterSpacing: isLight ? '-0.005em' : undefined,
                      }}
                    >
                      {section.templateSection.title}
                    </span>
                    {/* 浅色下左侧 3px accent 色条作为章节色 hint */}
                    {isLight && (
                      <div
                        className="ml-auto w-8 h-0.5 rounded-full"
                        style={{ background: accentColor }}
                        aria-hidden
                      />
                    )}
                  </div>
                  {section.items.length === 0 ? (
                    <div className="text-[12px] ml-10" style={{ color: 'var(--text-muted)' }}>（未填写）</div>
                  ) : section.templateSection.inputType === ReportInputType.IssueList ? (
                    <div className="space-y-3 ml-10">
                      {section.items.map((item, iIdx) => {
                        const cat = section.templateSection.issueCategories?.find((c) => c.key === item.issueCategoryKey);
                        const st  = section.templateSection.issueStatuses?.find((s) => s.key === item.issueStatusKey);
                        return (
                          <div
                            key={iIdx}
                            className="rounded-lg p-3"
                            style={{
                              background: isLight ? '#FFFFFF' : 'var(--bg-secondary)',
                              border: '1px solid var(--hairline)',
                            }}
                          >
                            {(cat || st) && (
                              <div className="flex items-center gap-2 mb-2">
                                {cat && (
                                  <span
                                    className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium"
                                    style={{
                                      color: cat.color || (isLight ? 'rgba(51,65,85,1)' : 'rgba(203,213,225,0.9)'),
                                      background: isLight ? 'rgba(51,65,85,0.08)' : 'rgba(148,163,184,0.08)',
                                      border: `1px solid ${isLight ? 'rgba(51,65,85,0.18)' : 'rgba(148,163,184,0.2)'}`,
                                    }}
                                  >
                                    {cat.label}
                                  </span>
                                )}
                                {st && (
                                  <span
                                    className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium"
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
                            <RichTextMarkdownContent content={item.content} imageMaxHeight={240} />
                          </div>
                        );
                      })}
                    </div>
                  ) : section.templateSection.inputType === ReportInputType.RichText ? (
                    <div className="space-y-2 ml-10">
                      {section.items.map((item, iIdx) => (
                        <RichTextMarkdownContent
                          key={iIdx}
                          content={item.content}
                          imageMaxHeight={260}
                        />
                      ))}
                    </div>
                  ) : (
                    <ul className="space-y-1.5 ml-10">
                      {section.items.map((item, iIdx) => (
                        <li key={iIdx} className="flex items-start gap-2.5">
                          <span
                            className="text-[13px] mt-1 flex-shrink-0"
                            style={{ color: bulletClr, fontWeight: 600 }}
                          >
                            ·
                          </span>
                          <span className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {item.content || '（空）'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Section comments */}
                  {topLevel.length > 0 && (
                    <div
                      className="mt-2 ml-10 pl-3"
                      style={{ borderLeft: `2px solid ${isLight ? 'var(--hairline-strong)' : `${accentColor}30`}` }}
                    >
                      {topLevel.map((comment) => {
                        const replies = sectionComments.filter((c) => c.parentCommentId === comment.id);
                        return (
                          <div key={comment.id} className="mb-2">
                            <CommentItem
                              comment={comment}
                              isMine={comment.authorUserId === currentUserId}
                              onDelete={() => handleDeleteComment(comment.id)}
                              onReply={() => openCommentInput(idx, comment.id)}
                              onEdit={(newContent) => handleUpdateComment(comment.id, newContent)}
                            />
                            {replies.map((reply) => (
                              <div key={reply.id} className="ml-4 mt-1">
                                <CommentItem
                                  comment={reply}
                                  isMine={reply.authorUserId === currentUserId}
                                  onDelete={() => handleDeleteComment(reply.id)}
                                  onReply={() => openCommentInput(idx, comment.id)}
                                  onEdit={(newContent) => handleUpdateComment(reply.id, newContent)}
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
                    onClick={() => openCommentInput(idx)}
                  >
                    <MessageSquare size={10} /> 评论
                  </button>

                  {replyTo?.sectionIndex === idx && (
                    <div className="mt-2 ml-7 p-3 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
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
                </div>
              );
            })}
          </GlassCard>
        )}

        {activeTab === 'plan-comparison' && reportId && (
          <GlassCard variant="subtle" className="p-6">
            <PlanComparisonPanel reportId={reportId} />
          </GlassCard>
        )}
      </div>
        </div>
        <div className="flex-none flex flex-col gap-4 min-h-0">
          {/* 不可见占位：高度 = 主列 Tabs 栏高度，让右栏顶部对齐正文 */}
          <div
            aria-hidden="true"
            className="flex items-center gap-1 px-1"
            style={{
              borderBottom: '1px solid var(--border-primary)',
              visibility: 'hidden',
              pointerEvents: 'none',
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              className="px-4 py-2.5 text-[13px] rounded-t-lg"
              style={{ fontWeight: 600 }}
            >
              占位
            </button>
          </div>
          <RightRailPanel reportId={report.id} viewSummary={viewSummary} />
        </div>
      </div>
    </div>
  );
}

const sidebarStatusConfig: Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156,163,175,.82)', bg: 'rgba(156,163,175,.08)', icon: Clock },
  [WeeklyReportStatus.Draft]: { label: '草稿', color: 'rgba(156,163,175,.92)', bg: 'rgba(156,163,175,.08)', icon: Clock },
  [WeeklyReportStatus.Submitted]: { label: '待审阅', color: 'rgba(59,130,246,.9)', bg: 'rgba(59,130,246,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Reviewed]: { label: '已审阅', color: 'rgba(34,197,94,.9)', bg: 'rgba(34,197,94,.08)', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]: { label: '已打回', color: 'rgba(239,68,68,.9)', bg: 'rgba(239,68,68,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Overdue]: { label: '逾期', color: 'rgba(239,68,68,.9)', bg: 'rgba(239,68,68,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Viewed]: { label: '已查看', color: 'rgba(14,165,233,.9)', bg: 'rgba(14,165,233,.08)', icon: CheckCircle2 },
};

function SiblingReportsSidebar({
  items,
  currentId,
  onSelect,
  weekYear,
  weekNumber,
}: {
  items: TeamReportListItem[];
  currentId?: string;
  onSelect: (id: string) => void;
  weekYear?: number;
  weekNumber?: number;
}) {
  return (
    <aside
      className="shrink-0 hidden md:flex flex-col rounded-2xl"
      style={{
        width: 240,
        minHeight: 0,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
      }}
    >
      <div
        className="px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--border-primary)' }}
      >
        <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          本周周报
        </div>
        {weekYear && weekNumber && (
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {weekYear} 年第 {weekNumber} 周 · 共 {items.length} 份
          </div>
        )}
      </div>
      <div
        className="px-2 py-2"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {items.map((item) => {
          const cfg = sidebarStatusConfig[item.status] || sidebarStatusConfig[WeeklyReportStatus.Submitted];
          const isActive = item.reportId === currentId;
          return (
            <button
              key={item.reportId}
              type="button"
              onClick={() => onSelect(item.reportId)}
              className="w-full text-left rounded-lg px-2.5 py-2 mb-1 transition-colors"
              style={{
                background: isActive ? 'rgba(59,130,246,.14)' : 'transparent',
                border: isActive ? '1px solid rgba(59,130,246,.35)' : '1px solid transparent',
                cursor: isActive ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = 'transparent';
              }}
              title={item.userName || item.userId}
            >
              <div
                className="text-[12.5px] font-medium truncate"
                style={{ color: isActive ? 'rgba(59,130,246,.95)' : 'var(--text-primary)' }}
              >
                {item.userName || item.userId}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ color: cfg.color, background: cfg.bg }}
                >
                  {cfg.label}
                </span>
                {item.submittedAt && (
                  <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {new Date(item.submittedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function CommentItem({
  comment,
  isMine,
  onDelete,
  onReply,
  onEdit,
  isReply,
}: {
  comment: ReportComment;
  isMine: boolean;
  onDelete: () => void;
  onReply: () => void;
  onEdit: (newContent: string) => Promise<boolean>;
  isReply?: boolean;
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
            style={{ background: 'rgba(99, 102, 241, 0.08)', color: 'rgba(99, 102, 241, 0.82)' }}
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
          <div className="text-[12px] leading-relaxed mt-1 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
            {comment.content}
          </div>
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
