import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar, CheckCircle2, Clock, AlertCircle, Eye, Sparkles, Loader2 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { reviewWeeklyReport, returnWeeklyReport, generateTeamSummary, getTeamSummary } from '@/services';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import type { TeamSummary } from '@/services/contracts/reportAgent';
import { ReportDetailPanel } from './ReportDetailPanel';

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156, 163, 175, 0.6)', icon: Clock },
  [WeeklyReportStatus.Draft]: { label: '草稿', color: 'rgba(156, 163, 175, 0.9)', icon: Clock },
  [WeeklyReportStatus.Submitted]: { label: '已提交', color: 'rgba(59, 130, 246, 0.9)', icon: AlertCircle },
  [WeeklyReportStatus.Reviewed]: { label: '已审阅', color: 'rgba(34, 197, 94, 0.9)', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]: { label: '已退回', color: 'rgba(239, 68, 68, 0.9)', icon: AlertCircle },
  [WeeklyReportStatus.Overdue]: { label: '逾期', color: 'rgba(239, 68, 68, 0.9)', icon: AlertCircle },
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

  // Return dialog state
  const [returnDialogId, setReturnDialogId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');

  // Team summary state
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

  if (leaderTeams.length === 0) {
    return (
      <GlassCard variant="subtle" className="flex items-center justify-center py-16">
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>你不是任何团队的负责人</div>
      </GlassCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
          <GlassCard className="p-4 w-[400px]">
            <div className="text-[14px] font-medium mb-3" style={{ color: 'var(--text-primary)' }}>退回周报</div>
            <textarea
              className="w-full text-[12px] px-3 py-2 rounded-lg resize-none"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 80 }}
              placeholder="请输入退回原因..."
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => { setReturnDialogId(null); setReturnReason(''); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleReturn}>确认退回</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Controls */}
      <GlassCard variant="subtle" className="px-4 py-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
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
          <div className="flex items-center gap-3">
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={handlePrevWeek}><ChevronLeft size={14} /></Button>
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {weekYear} 年第 {weekNumber} 周
            </span>
            <Button variant="ghost" size="sm" onClick={handleNextWeek}><ChevronRight size={14} /></Button>
          </div>
        </div>
      </GlassCard>

      {/* Stats */}
      {dashboard && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: '总人数', value: dashboard.stats.total, color: 'var(--text-primary)' },
            { label: '已提交', value: dashboard.stats.submitted, color: 'rgba(59, 130, 246, 0.9)' },
            { label: '已审阅', value: dashboard.stats.reviewed, color: 'rgba(34, 197, 94, 0.9)' },
            { label: '未开始', value: dashboard.stats.notStarted, color: 'rgba(156, 163, 175, 0.6)' },
          ].map((s) => (
            <GlassCard key={s.label} variant="subtle" className="px-3 py-2 text-center">
              <div className="text-[18px] font-semibold" style={{ color: s.color }}>{s.value}</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
            </GlassCard>
          ))}
        </div>
      )}

      {/* Member list */}
      {dashboard && (
        <GlassCard variant="subtle" className="p-0">
          <div className="divide-y" style={{ borderColor: 'var(--border-primary)' }}>
            {dashboard.members.map((member) => {
              const cfg = statusConfig[member.reportStatus] || statusConfig[WeeklyReportStatus.NotStarted];
              const StatusIcon = cfg.icon;
              return (
                <div key={member.userId} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                      {(member.userName || '?')[0]}
                    </div>
                    <div>
                      <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {member.userName || member.userId}
                      </div>
                      {member.jobTitle && (
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{member.jobTitle}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusIcon size={14} style={{ color: cfg.color }} />
                    <span className="text-[12px]" style={{ color: cfg.color }}>{cfg.label}</span>
                    {member.reportId && member.reportStatus === WeeklyReportStatus.Submitted && (
                      <div className="flex items-center gap-1 ml-2">
                        <Button variant="ghost" size="sm" onClick={() => setViewingReportId(member.reportId!)}>
                          <Eye size={12} />
                        </Button>
                        <Button variant="primary" size="sm" onClick={() => handleReview(member.reportId!)}>
                          审阅
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setReturnDialogId(member.reportId!)}>
                          退回
                        </Button>
                      </div>
                    )}
                    {member.reportId && member.reportStatus !== WeeklyReportStatus.Submitted && member.reportStatus !== WeeklyReportStatus.NotStarted && (
                      <Button variant="ghost" size="sm" className="ml-2" onClick={() => setViewingReportId(member.reportId!)}>
                        <Eye size={12} /> 查看
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </GlassCard>
      )}

      {/* Team Summary */}
      <GlassCard variant="subtle" className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>团队周报汇总</div>
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

        {summaryLoading ? (
          <div className="text-[12px] text-center py-4" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : summary ? (
          <div className="space-y-3">
            <div className="text-[10px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <span>汇总 {summary.submittedCount}/{summary.memberCount} 份周报</span>
              <span>·</span>
              <span>由 {summary.generatedByName || '系统'} 生成于 {new Date(summary.generatedAt).toLocaleString()}</span>
            </div>
            {summary.sections.map((section, idx) => (
              <div key={idx}>
                <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{section.title}</div>
                {section.items.length === 0 ? (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>（无内容）</div>
                ) : (
                  <ul className="space-y-0.5">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>•</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-center py-4" style={{ color: 'var(--text-muted)' }}>
            暂无汇总，点击"生成汇总"自动聚合团队周报
          </div>
        )}
      </GlassCard>
    </div>
  );
}
