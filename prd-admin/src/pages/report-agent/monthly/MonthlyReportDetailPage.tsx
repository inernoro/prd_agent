import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Pencil } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useSmartBack } from '@/hooks/useSmartBack';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { getMonthlyReport, getMonthlyReportViewsSummary, recordMonthlyReportView } from '@/services';
import type { ReportComment, ReportViewSummary } from '@/services/contracts/reportAgent';
import type { MonthlyReportDetail } from '@/services/contracts/reportAgentMonthly';
import { RichTextMarkdownContent } from '../components/RichTextMarkdownContent';
import { RightRailPanel } from '../components/RightRailPanel';
import { ReportSelectionCommentLayer } from '../components/ReportSelectionCommentLayer';
import { ReportSectionComments, type ReportReplyTarget } from '../components/ReportSectionComments';
import type { ReportCommentAnchor } from '../components/reportCommentAnchor';
import { useDataTheme } from '../hooks/useDataTheme';
import { getReportInteractionApi } from '../reportInteractionApi';
import { formatYearMonth, getMonthlyStatusMeta } from './monthlyMeta';
import { MonthlyChapterShell } from './MonthlyChapterShell';
import { WeeklyLinkChips } from './WeeklyLinkChips';

function EmptyText() {
  return <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>（未填写）</div>;
}

export default function MonthlyReportDetailPage() {
  const { reportId = '' } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const goBack = useSmartBack('/report-agent');

  const [detail, setDetail] = useState<MonthlyReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewSummary, setViewSummary] = useState<ReportViewSummary>({ count: 0, totalViewCount: 0, users: [] });
  const [comments, setComments] = useState<ReportComment[]>([]);
  const [replyTo, setReplyTo] = useState<ReportReplyTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isLight = useDataTheme() === 'light';
  const currentUserId = useAuthStore((s) => s.user?.userId);
  const interactionApi = getReportInteractionApi('monthly');

  const loadComments = useCallback(async () => {
    const res = await interactionApi.listComments({ reportId });
    if (res.success && res.data) setComments(res.data.items);
  }, [reportId, interactionApi]);

  const loadViews = useCallback(async () => {
    const res = await getMonthlyReportViewsSummary({ id: reportId });
    if (res.success && res.data) setViewSummary(res.data);
  }, [reportId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 先记浏览（负责人首次打开会把状态翻成「已查看」），再取详情，保证页面上的状态是翻面之后的
      await recordMonthlyReportView({ id: reportId });
      const res = await getMonthlyReport({ id: reportId });
      if (!alive) return;
      if (res.success && res.data) setDetail(res.data);
      else setLoadError(res.error?.message || '月报加载失败');
      void loadViews();
      void loadComments();
    })();
    return () => {
      alive = false;
    };
  }, [reportId, loadViews, loadComments]);

  const commentsBySection = useMemo(() => {
    const map: Record<number, ReportComment[]> = {};
    for (const c of comments) (map[c.sectionIndex] ??= []).push(c);
    return map;
  }, [comments]);

  const handleCreateComment = async (content: string, attachmentIds: string[]) => {
    if (!replyTo || (!content && attachmentIds.length === 0)) return;
    setSubmitting(true);
    const anchor = !replyTo.parentId ? replyTo.anchor : undefined;
    const res = await interactionApi.createComment({
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
    const res = await interactionApi.deleteComment({ reportId, commentId });
    if (res.success) await loadComments();
    else toast.error(res.error?.message || '删除失败');
  };

  const handleUpdateComment = async (commentId: string, content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed) {
      toast.error('评论内容不能为空');
      return false;
    }
    const res = await interactionApi.updateComment({ reportId, commentId, content: trimmed });
    if (res.success) {
      await loadComments();
      return true;
    }
    toast.error(res.error?.message || '修改失败');
    return false;
  };

  const handleSelectionComment = useCallback((sectionIndex: number, anchor: ReportCommentAnchor) => {
    setReplyTo({ sectionIndex, anchor });
  }, []);

  const handleActivateThread = useCallback((comment: ReportComment) => {
    setFlashCommentId(comment.id);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashCommentId(null), 2400);
    requestAnimationFrame(() => {
      document.getElementById(`report-comment-${comment.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

  if (loadError) {
    return (
      <GlassCard variant="subtle" className="p-8 flex flex-col items-center gap-3 text-center">
        <AlertCircle size={24} style={{ color: 'var(--accent-fg-error)' }} />
        <div className="text-[14px]" style={{ color: 'var(--text-primary)' }} data-testid="monthly-load-error">{loadError}</div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/report-agent')}>回到周报</Button>
      </GlassCard>
    );
  }
  if (!detail) return <MapSectionLoader text="正在打开月报…" />;

  const report = detail.report;
  const titles = detail.chapterTitles;
  const statusMeta = getMonthlyStatusMeta(report.status);
  /** 草稿只有作者可见，评论与点赞在提交后开放 */
  const interactive = report.status !== 'draft';

  return (
    <div className="lg:h-full min-h-0 flex flex-col gap-4" data-testid="monthly-report-detail">
      <GlassCard variant="subtle" className="px-4 sm:px-5 py-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="sm" onClick={goBack} aria-label="返回">
            <ArrowLeft size={16} />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {report.userName} 的 {formatYearMonth(report.year, report.month)}月报
              </span>
              <span
                className="text-[11px] px-2 py-0.5 rounded-full"
                style={{ color: statusMeta.color, background: statusMeta.bg, border: `1px solid ${statusMeta.border}` }}
                data-testid="monthly-status"
              >
                {statusMeta.label}
              </span>
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {report.teamName}
              {report.submittedAt && ` · 提交于 ${new Date(report.submittedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
            </div>
          </div>
          {detail.canEdit && (
            <Button variant="secondary" size="sm" onClick={() => navigate(`/report-agent/monthly/${report.id}/edit`)}>
              <Pencil size={13} /> 编辑
            </Button>
          )}
        </div>
      </GlassCard>

      <div className="lg:flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0 min-h-0 lg:overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {/* relative：划词评论层（下划线 / 角标 / 评论按钮）的定位坐标系 */}
          <div ref={contentRef} className="relative flex flex-col gap-4 pb-8">
            {titles.map((title, idx) => (
              <MonthlyChapterShell key={idx} index={idx} title={title}>
                {/* data-report-section：划词评论的章节锚定根 */}
                <div data-report-section={idx}>{renderChapter(idx)}</div>
                {interactive && (
                  <ReportSectionComments
                    reportId={report.id}
                    kind="monthly"
                    sectionIndex={idx}
                    sectionTitle={title}
                    sectionComments={commentsBySection[idx] ?? []}
                    currentUserId={currentUserId}
                    isLight={isLight}
                    accentBorder="var(--status-going-border)"
                    flashCommentId={flashCommentId}
                    replyTo={replyTo}
                    submitting={submitting}
                    indent={false}
                    onOpenInput={(sectionIndex, parentId) => setReplyTo({ sectionIndex, parentId })}
                    onCancel={() => setReplyTo(null)}
                    onSubmit={handleCreateComment}
                    onDelete={handleDeleteComment}
                    onEdit={handleUpdateComment}
                  />
                )}
              </MonthlyChapterShell>
            ))}
            {interactive && (
              <ReportSelectionCommentLayer
                containerRef={contentRef}
                comments={comments}
                isLight={isLight}
                reflowKey={`${report.id}:${report.updatedAt}`}
                onCreateFromSelection={handleSelectionComment}
                onActivateThread={handleActivateThread}
              />
            )}
          </div>
        </div>

        {interactive ? (
          <RightRailPanel
            reportId={report.id}
            kind="monthly"
            viewSummary={viewSummary}
            versionHistory={report.versionHistory}
            fallbackTimestamps={{ submittedAt: report.submittedAt ?? undefined }}
          />
        ) : (
          <aside className="lg:w-[280px] shrink-0">
            <div
              className="rounded-2xl p-4 text-[12px] leading-relaxed"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-muted)' }}
            >
              这还是一份草稿，只有你自己看得到。提交后负责人可以查看，团队成员能否查看取决于团队的月报可见性设置；评论与点赞在提交后开放。
            </div>
          </aside>
        )}
      </div>
    </div>
  );

  function renderChapter(idx: number) {
    switch (idx) {
      case 0:
        return (
          <div className="flex flex-col gap-3">
            <WeeklyLinkChips links={detail!.linkedWeeklies} />
            {report.achievementsText?.trim()
              ? <RichTextMarkdownContent content={report.achievementsText} />
              : detail!.linkedWeeklies.length === 0 && <EmptyText />}
          </div>
        );
      case 1:
        return report.problemsText?.trim() ? <RichTextMarkdownContent content={report.problemsText} /> : <EmptyText />;
      case 2:
        return report.partners.length === 0 ? (
          <EmptyText />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }} data-testid="monthly-partners">
            {report.partners.map((p) => (
              <div
                key={p.userId}
                className="rounded-xl p-3 flex flex-col gap-2"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
              >
                <div className="flex items-center gap-2">
                  <UserAvatar
                    src={resolveAvatarUrl({ username: p.userName, avatarFileName: p.avatarFileName })}
                    className="w-8 h-8 rounded-full object-cover"
                  />
                  <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {p.userName || p.userId}
                  </span>
                </div>
                <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {p.reason || '（没有写理由）'}
                </div>
              </div>
            ))}
          </div>
        );
      default:
        return report.suggestionsText?.trim() ? <RichTextMarkdownContent content={report.suggestionsText} /> : <EmptyText />;
    }
  }
}
