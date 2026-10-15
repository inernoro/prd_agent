import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Pencil, Eye } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useSmartBack } from '@/hooks/useSmartBack';
import { getMonthlyReport, getMonthlyReportViewsSummary, recordMonthlyReportView } from '@/services';
import type { ReportViewSummary } from '@/services/contracts/reportAgent';
import type { MonthlyReportDetail } from '@/services/contracts/reportAgentMonthly';
import { RichTextMarkdownContent } from '../components/RichTextMarkdownContent';
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
    })();
    return () => {
      alive = false;
    };
  }, [reportId, loadViews]);

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
          <div className="flex flex-col gap-4 pb-8">
            <MonthlyChapterShell index={0} title={titles[0]}>
              <WeeklyLinkChips links={detail.linkedWeeklies} />
              {report.achievementsText?.trim()
                ? <RichTextMarkdownContent content={report.achievementsText} />
                : detail.linkedWeeklies.length === 0 && <EmptyText />}
            </MonthlyChapterShell>

            <MonthlyChapterShell index={1} title={titles[1]}>
              {report.problemsText?.trim() ? <RichTextMarkdownContent content={report.problemsText} /> : <EmptyText />}
            </MonthlyChapterShell>

            <MonthlyChapterShell index={2} title={titles[2]}>
              {report.partners.length === 0 ? (
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
              )}
            </MonthlyChapterShell>

            <MonthlyChapterShell index={3} title={titles[3]}>
              {report.suggestionsText?.trim() ? <RichTextMarkdownContent content={report.suggestionsText} /> : <EmptyText />}
            </MonthlyChapterShell>
          </div>
        </div>

        <aside className="lg:w-[280px] shrink-0 flex flex-col gap-3">
          <div
            className="rounded-2xl p-4"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
            data-testid="monthly-views"
          >
            <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <Eye size={13} /> {viewSummary.count} 人看过
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {viewSummary.users.slice(0, 12).map((u) => (
                <div key={u.userId} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  <UserAvatar src={resolveAvatarUrl({ username: u.userName, avatarFileName: u.avatarFileName })} className="w-5 h-5 rounded-full object-cover" />
                  <span className="truncate flex-1">{u.userName}{u.isOwner ? '（作者）' : ''}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{new Date(u.lastViewedAt).toLocaleDateString('zh-CN')}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
