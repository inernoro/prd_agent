import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar, CheckCircle2, Clock, AlertCircle, Eye, Sparkles, Loader2, Palmtree, Download, Users, FileCheck, FileClock } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { reviewWeeklyReport, returnWeeklyReport, generateTeamSummary, getTeamSummary, markVacation, cancelVacation, exportTeamSummaryMarkdown } from '@/services';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import type { TeamSummary } from '@/services/contracts/reportAgent';
import { ReportDetailPanel } from './ReportDetailPanel';
import { TeamWorkflowPanel } from './TeamWorkflowPanel';

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

const statusConfig: Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156, 163, 175, 0.6)', bg: 'rgba(156, 163, 175, 0.08)', icon: Clock },
  [WeeklyReportStatus.Draft]:      { label: '草稿',   color: 'rgba(156, 163, 175, 0.9)', bg: 'rgba(156, 163, 175, 0.08)', icon: Clock },
  [WeeklyReportStatus.Submitted]:  { label: '已提交', color: 'rgba(59, 130, 246, 0.9)',  bg: 'rgba(59, 130, 246, 0.08)',  icon: AlertCircle },
  [WeeklyReportStatus.Reviewed]:   { label: '已审阅', color: 'rgba(34, 197, 94, 0.9)',   bg: 'rgba(34, 197, 94, 0.08)',   icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]:   { label: '已退回', color: 'rgba(239, 68, 68, 0.9)',   bg: 'rgba(239, 68, 68, 0.08)',   icon: AlertCircle },
  [WeeklyReportStatus.Overdue]:    { label: '逾期',   color: 'rgba(239, 68, 68, 0.9)',   bg: 'rgba(239, 68, 68, 0.08)',   icon: AlertCircle },
  vacation:                         { label: '请假',   color: 'rgba(139, 92, 246, 0.9)',  bg: 'rgba(139, 92, 246, 0.08)',  icon: Palmtree },
};

export function TeamDashboard() {
  const { teams, dashboard, loadDashboard } = useReportAgentStore();
  const userId = useAuthStore((s) => s.user?.userId);

  const leaderTeams = useMemo(() => teams.filter((t) => t.leaderUserId === userId), [teams, userId]);
  const [selectedTeamId, setSelectedTeamId] = useState(leaderTeams[0]?.id || '');

  const now = useMemo(() => getISOWeek(new Date()), []);
  const [weekYear, setWeekYear] = useState(now.weekYear);
  const [weekNumber, setWeekNumber] = useState(now.weekNumber);
  const [viewingReportId, setViewingReportId] = useState<string | null>(null);

  const [returnDialogId, setReturnDialogId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');

  const [summary, setSummary] = useState<TeamSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  useEffect(() => {
    if (selectedTeamId) {
      void loadDashboard(selectedTeamId, weekYear, weekNumber);
      loadSummary();
    }
  }, [selectedTeamId, weekYear, weekNumber, loadDashboard]);

  const loadSummary = async () => {
    if (!selectedTeamId) return;
    setSummaryLoading(true);
    const res = await getTeamSummary({ teamId: selectedTeamId, weekYear, weekNumber });
    if (res.success && res.data) setSummary(res.data.summary);
    else setSummary(null);
    setSummaryLoading(false);
  };

  const handlePrevWeek = () => {
    if (weekNumber <= 1) { setWeekYear(weekYear - 1); setWeekNumber(52); }
    else setWeekNumber(weekNumber - 1);
  };

  const handleNextWeek = () => {
    if (weekNumber >= 52) { setWeekYear(weekYear + 1); setWeekNumber(1); }
    else setWeekNumber(weekNumber + 1);
  };

  const handleReview = async (reportId: string) => {
    const res = await reviewWeeklyReport({ id: reportId });
    if (res.success) {
      toast.success('已审阅');
      void loadDashboard(selectedTeamId, weekYear, weekNumber);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleReturn = async () => {
    if (!returnDialogId) return;
    const res = await returnWeeklyReport({ id: returnDialogId, reason: returnReason });
    if (res.success) {
      toast.success('已退回');
      setReturnDialogId(null);
      setReturnReason('');
      void loadDashboard(selectedTeamId, weekYear, weekNumber);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleGenerateSummary = async () => {
    setGeneratingSummary(true);
    const res = await generateTeamSummary({ teamId: selectedTeamId, weekYear, weekNumber });
    setGeneratingSummary(false);
    if (res.success && res.data) {
      setSummary(res.data.summary);
      toast.success('团队汇总已生成');
    } else {
      toast.error(res.error?.message || '汇总生成失败');
    }
  };

  const [vacationDialogUserId, setVacationDialogUserId] = useState<string | null>(null);
  const [vacationReason, setVacationReason] = useState('');

  const handleMarkVacation = async () => {
    if (!vacationDialogUserId) return;
    const res = await markVacation({
      teamId: selectedTeamId,
      userId: vacationDialogUserId,
      weekYear,
      weekNumber,
      reason: vacationReason || undefined,
    });
    if (res.success) {
      toast.success('已标记请假');
      setVacationDialogUserId(null);
      setVacationReason('');
      void loadDashboard(selectedTeamId, weekYear, weekNumber);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleCancelVacation = async (memberUserId: string) => {
    const res = await cancelVacation({ teamId: selectedTeamId, userId: memberUserId, weekYear, weekNumber });
    if (res.success) {
      toast.success('已取消请假标记');
      void loadDashboard(selectedTeamId, weekYear, weekNumber);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleExportSummary = async () => {
    try {
      const blob = await exportTeamSummaryMarkdown({ teamId: selectedTeamId, weekYear, weekNumber });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `团队汇总_${weekYear}W${String(weekNumber).padStart(2, '0')}.md`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('导出成功');
    } catch {
      toast.error('导出失败');
    }
  };

  // Compute submission progress
  const submissionRate = dashboard
    ? Math.round(((dashboard.stats.submitted + dashboard.stats.reviewed) / Math.max(1, dashboard.stats.total)) * 100)
    : 0;

  if (leaderTeams.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 400 }}>
        <div className="text-center">
          <Users size={32} style={{ color: 'var(--text-muted)', opacity: 0.4, margin: '0 auto' }} />
          <div className="text-[13px] mt-3" style={{ color: 'var(--text-muted)' }}>你不是任何团队的负责人</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {viewingReportId && (
        <ReportDetailPanel
          reportId={viewingReportId}
          onClose={() => setViewingReportId(null)}
          onReview={() => handleReview(viewingReportId)}
          onReturn={() => { setReturnDialogId(viewingReportId); setViewingReportId(null); }}
        />
      )}

      {/* Return Dialog */}
      {returnDialogId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <GlassCard className="p-5 w-[420px]">
            <div className="text-[15px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>退回周报</div>
            <textarea
              className="w-full text-[13px] px-3 py-2.5 rounded-xl resize-none"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 80 }}
              placeholder="请输入退回原因..."
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => { setReturnDialogId(null); setReturnReason(''); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleReturn}>确认退回</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Vacation Dialog */}
      {vacationDialogUserId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <GlassCard className="p-5 w-[420px]">
            <div className="text-[15px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              标记请假
            </div>
            <div className="text-[12px] mb-3" style={{ color: 'var(--text-secondary)' }}>
              将标记该成员 {weekYear} 年第 {weekNumber} 周为请假，无需提交周报。
            </div>
            <textarea
              className="w-full text-[13px] px-3 py-2.5 rounded-xl resize-none"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 60 }}
              placeholder="请假原因（选填）..."
              value={vacationReason}
              onChange={(e) => setVacationReason(e.target.value)}
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => { setVacationDialogUserId(null); setVacationReason(''); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleMarkVacation}>确认标记</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Controls — Week nav + team selector */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {leaderTeams.length > 1 && (
            <select
              className="px-3 py-1.5 rounded-lg text-[13px]"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
            >
              {leaderTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Calendar size={15} style={{ color: 'var(--text-muted)' }} />
          <Button variant="ghost" size="sm" onClick={handlePrevWeek}><ChevronLeft size={14} /></Button>
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {weekYear} 年第 {weekNumber} 周
          </span>
          <Button variant="ghost" size="sm" onClick={handleNextWeek}><ChevronRight size={14} /></Button>
        </div>
      </div>

      {/* Workflow Panel */}
      {selectedTeamId && <TeamWorkflowPanel teamId={selectedTeamId} />}

      {/* Stats Cards — colored accents */}
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="总人数"
            value={dashboard.stats.total}
            icon={<Users size={16} />}
            color="rgba(148, 163, 184, 0.9)"
            bg="rgba(148, 163, 184, 0.08)"
          />
          <StatCard
            label="已提交"
            value={dashboard.stats.submitted}
            icon={<FileClock size={16} />}
            color="rgba(59, 130, 246, 0.9)"
            bg="rgba(59, 130, 246, 0.08)"
          />
          <StatCard
            label="已审阅"
            value={dashboard.stats.reviewed}
            icon={<FileCheck size={16} />}
            color="rgba(34, 197, 94, 0.9)"
            bg="rgba(34, 197, 94, 0.08)"
          />
          <StatCard
            label="未开始"
            value={dashboard.stats.notStarted}
            icon={<Clock size={16} />}
            color="rgba(156, 163, 175, 0.6)"
            bg="rgba(156, 163, 175, 0.06)"
          />
        </div>
      )}

      {/* Submission progress bar */}
      {dashboard && dashboard.stats.total > 0 && (
        <div className="px-1">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>提交进度</span>
            <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {dashboard.stats.submitted + dashboard.stats.reviewed}/{dashboard.stats.total} ({submissionRate}%)
            </span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${submissionRate}%`,
                background: submissionRate === 100
                  ? 'linear-gradient(90deg, rgba(34,197,94,0.7), rgba(34,197,94,0.5))'
                  : 'linear-gradient(90deg, rgba(59,130,246,0.7), rgba(59,130,246,0.4))',
              }}
            />
          </div>
        </div>
      )}

      {/* Member list */}
      {dashboard && (
        <GlassCard variant="subtle" className="p-0 overflow-hidden">
          {dashboard.members.map((member, idx) => {
            const cfg = statusConfig[member.reportStatus] || statusConfig[WeeklyReportStatus.NotStarted];
            const StatusIcon = cfg.icon;
            return (
              <div
                key={member.userId}
                className="flex items-center justify-between px-4 py-3 transition-colors duration-150 hover:bg-[var(--bg-tertiary)]"
                style={{
                  borderTop: idx > 0 ? '1px solid var(--border-primary)' : undefined,
                }}
              >
                <div className="flex items-center gap-3">
                  {/* Avatar with status ring */}
                  <div className="relative">
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-medium"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        border: `2px solid ${cfg.color}`,
                      }}
                    >
                      {(member.userName || '?')[0]}
                    </div>
                  </div>
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {member.userName || member.userId}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {member.jobTitle && (
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{member.jobTitle}</span>
                      )}
                      <span
                        className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full"
                        style={{ color: cfg.color, background: cfg.bg }}
                      >
                        <StatusIcon size={10} />
                        {cfg.label}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5">
                  {member.reportId && member.reportStatus === WeeklyReportStatus.Submitted && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setViewingReportId(member.reportId!)}>
                        <Eye size={12} />
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => handleReview(member.reportId!)}>
                        审阅
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setReturnDialogId(member.reportId!)}>
                        退回
                      </Button>
                    </>
                  )}
                  {member.reportId && member.reportStatus === 'vacation' && (
                    <Button variant="ghost" size="sm" onClick={() => handleCancelVacation(member.userId)}>
                      取消请假
                    </Button>
                  )}
                  {member.reportId && member.reportStatus !== WeeklyReportStatus.Submitted && member.reportStatus !== WeeklyReportStatus.NotStarted && member.reportStatus !== 'vacation' && (
                    <Button variant="ghost" size="sm" onClick={() => setViewingReportId(member.reportId!)}>
                      <Eye size={12} /> 查看
                    </Button>
                  )}
                  {(!member.reportId || member.reportStatus === WeeklyReportStatus.NotStarted || member.reportStatus === WeeklyReportStatus.Draft) && member.reportStatus !== 'vacation' && (
                    <Button variant="ghost" size="sm" onClick={() => setVacationDialogUserId(member.userId)} title="标记请假">
                      <Palmtree size={12} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </GlassCard>
      )}

      {/* Team Summary */}
      <GlassCard variant="subtle" className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={15} style={{ color: 'rgba(168, 85, 247, 0.8)' }} />
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>团队周报汇总</span>
          </div>
          <div className="flex items-center gap-2">
            {summary && (
              <Button variant="ghost" size="sm" onClick={handleExportSummary} title="导出 Markdown">
                <Download size={12} />
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleGenerateSummary}
              disabled={generatingSummary}
            >
              {generatingSummary ? <Loader2 size={12} className="animate-spin mr-1" /> : <Sparkles size={12} className="mr-1" />}
              {summary ? '重新生成' : '生成汇总'}
            </Button>
          </div>
        </div>

        {summaryLoading ? (
          <div className="text-[12px] text-center py-6" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : summary ? (
          <div className="space-y-4">
            <div className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <span>汇总 {summary.submittedCount}/{summary.memberCount} 份周报</span>
              <span style={{ opacity: 0.4 }}>|</span>
              <span>由 {summary.generatedByName || '系统'} 生成于 {new Date(summary.generatedAt).toLocaleString()}</span>
            </div>
            {summary.sections.map((section, idx) => (
              <div key={idx}>
                <div className="text-[13px] font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>{section.title}</div>
                {section.items.length === 0 ? (
                  <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>（无内容）</div>
                ) : (
                  <ul className="space-y-1">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>•</span>
                        <span className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              暂无汇总，点击"生成汇总"自动聚合团队周报
            </div>
          </div>
        )}
      </GlassCard>
    </div>
  );
}

function StatCard({ label, value, icon, color, bg }: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  bg: string;
}) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{
        background: 'var(--surface-glass)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--border-primary)',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: bg }}
        >
          <div style={{ color }}>{icon}</div>
        </div>
      </div>
      <div className="text-[22px] font-bold" style={{ color }}>{value}</div>
      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}
