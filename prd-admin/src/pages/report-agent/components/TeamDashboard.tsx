import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  CheckCircle2,
  Clock,
  AlertCircle,
  Sparkles,
  Loader2,
  Download,
  Users,
  FileCheck,
  FileClock,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  UserPlus,
  UserMinus,
  LogOut,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import {
  reviewWeeklyReport,
  returnWeeklyReport,
  generateTeamSummary,
  getTeamSummary,
  exportTeamSummaryMarkdown,
  addReportTeamMember,
  removeReportTeamMember,
  leaveReportTeam,
} from '@/services';
import { WeeklyReportStatus, ReportTeamRole } from '@/services/contracts/reportAgent';
import type { TeamSummary, ReportUser } from '@/services/contracts/reportAgent';

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

const statusConfig: Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156,163,175,.6)', bg: 'rgba(156,163,175,.08)', icon: Clock },
  [WeeklyReportStatus.Draft]: { label: '草稿', color: 'rgba(156,163,175,.9)', bg: 'rgba(156,163,175,.08)', icon: Clock },
  [WeeklyReportStatus.Submitted]: { label: '待审阅', color: 'rgba(59,130,246,.9)', bg: 'rgba(59,130,246,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Reviewed]: { label: '已审阅', color: 'rgba(34,197,94,.9)', bg: 'rgba(34,197,94,.08)', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]: { label: '已打回', color: 'rgba(239,68,68,.9)', bg: 'rgba(239,68,68,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Overdue]: { label: '逾期', color: 'rgba(239,68,68,.9)', bg: 'rgba(239,68,68,.08)', icon: AlertCircle },
};

const summaryColors = ['rgba(59,130,246,.9)', 'rgba(34,197,94,.9)', 'rgba(168,85,247,.9)', 'rgba(249,115,22,.9)'];

type MemberFilter = 'all' | 'pending' | 'reviewed' | 'attention' | 'notStarted';

function getMemberRoleLabel(role?: string | null): string {
  if (role === ReportTeamRole.Leader) return '负责人';
  if (role === ReportTeamRole.Deputy) return '副负责人';
  return '成员';
}

function getMemberPriority(status: string): number {
  if (status === WeeklyReportStatus.Submitted) return 0;
  if (status === WeeklyReportStatus.Returned || status === WeeklyReportStatus.Overdue) return 1;
  if (status === WeeklyReportStatus.Reviewed) return 2;
  if (status === WeeklyReportStatus.Draft) return 3;
  return 4;
}

export function TeamDashboard() {
  const { teams, users, dashboard, loadDashboard, loadUsers, loadTeams } = useReportAgentStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const navigate = useNavigate();

  const [teamScope, setTeamScope] = useState<'managed' | 'joined'>('managed');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all');
  const now = useMemo(() => getISOWeek(new Date()), []);
  const [weekYear, setWeekYear] = useState(now.weekYear);
  const [weekNumber, setWeekNumber] = useState(now.weekNumber);

  const [summary, setSummary] = useState<TeamSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [returnDialogId, setReturnDialogId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false);
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<string>(ReportTeamRole.Member);
  const [memberJobTitle, setMemberJobTitle] = useState('');
  const [memberSaving, setMemberSaving] = useState(false);

  const managedTeams = useMemo(
    () =>
      teams.filter((team) => {
        const myRole = team.myRole ?? (team.leaderUserId === userId ? ReportTeamRole.Leader : undefined);
        return team.relationType === 'managed' || myRole === ReportTeamRole.Leader || myRole === ReportTeamRole.Deputy;
      }),
    [teams, userId]
  );
  const joinedTeams = useMemo(
    () =>
      teams.filter((team) => {
        const myRole = team.myRole ?? (team.leaderUserId === userId ? ReportTeamRole.Leader : undefined);
        return team.relationType === 'joined' || myRole === ReportTeamRole.Member;
      }),
    [teams, userId]
  );
  const scopedTeams = teamScope === 'managed' ? managedTeams : joinedTeams;
  const selectedTeam = useMemo(() => teams.find((x) => x.id === selectedTeamId) ?? null, [teams, selectedTeamId]);

  const canManageMembers = useMemo(() => {
    if (!selectedTeam) return false;
    if (typeof selectedTeam.canManageMembers === 'boolean') return selectedTeam.canManageMembers;
    const role = selectedTeam.myRole ?? (selectedTeam.leaderUserId === userId ? ReportTeamRole.Leader : undefined);
    return role === ReportTeamRole.Leader || role === ReportTeamRole.Deputy;
  }, [selectedTeam, userId]);
  const canLeaveSelectedTeam = useMemo(() => {
    if (!selectedTeam) return false;
    if (typeof selectedTeam.canLeave === 'boolean') return selectedTeam.canLeave;
    const role = selectedTeam.myRole ?? (selectedTeam.leaderUserId === userId ? ReportTeamRole.Leader : undefined);
    return !!role && role !== ReportTeamRole.Leader;
  }, [selectedTeam, userId]);

  const loadSummary = useCallback(async (teamId: string, wy: number, wn: number) => {
    setSummaryLoading(true);
    const res = await getTeamSummary({ teamId, weekYear: wy, weekNumber: wn });
    setSummary(res.success && res.data ? res.data.summary : null);
    setSummaryLoading(false);
  }, []);
  const refreshManagedData = useCallback(async () => {
    if (!selectedTeamId || teamScope !== 'managed') return;
    await loadDashboard(selectedTeamId, weekYear, weekNumber);
    await loadSummary(selectedTeamId, weekYear, weekNumber);
  }, [loadDashboard, loadSummary, selectedTeamId, teamScope, weekYear, weekNumber]);

  useEffect(() => {
    if (teamScope === 'managed' && managedTeams.length === 0 && joinedTeams.length > 0) setTeamScope('joined');
    if (teamScope === 'joined' && joinedTeams.length === 0 && managedTeams.length > 0) setTeamScope('managed');
  }, [teamScope, managedTeams.length, joinedTeams.length]);
  useEffect(() => {
    if (scopedTeams.length === 0) return setSelectedTeamId('');
    if (!scopedTeams.some((x) => x.id === selectedTeamId)) setSelectedTeamId(scopedTeams[0].id);
  }, [scopedTeams, selectedTeamId]);
  useEffect(() => { void loadUsers(); }, [loadUsers]);
  useEffect(() => {
    if (teamScope !== 'managed' || !selectedTeamId) return setSummary(null);
    void refreshManagedData();
  }, [refreshManagedData, selectedTeamId, teamScope]);
  useEffect(() => {
    setMembersExpanded(false);
    setMemberFilter('all');
  }, [teamScope, selectedTeamId]);

  const handleReview = async (reportId: string) => {
    const res = await reviewWeeklyReport({ id: reportId });
    if (!res.success) return toast.error(res.error?.message || '操作失败');
    toast.success('已审阅');
    void refreshManagedData();
  };
  const handleReturn = async () => {
    if (!returnDialogId || !returnReason.trim()) return toast.error('请填写退回原因');
    const res = await returnWeeklyReport({ id: returnDialogId, reason: returnReason.trim() });
    if (!res.success) return toast.error(res.error?.message || '操作失败');
    toast.success('已退回');
    setReturnDialogId(null);
    setReturnReason('');
    void refreshManagedData();
  };
  const handleGenerateSummary = async () => {
    if (!selectedTeamId) return;
    setGeneratingSummary(true);
    const res = await generateTeamSummary({ teamId: selectedTeamId, weekYear, weekNumber });
    setGeneratingSummary(false);
    if (!res.success || !res.data) return toast.error(res.error?.message || '汇总生成失败');
    setSummary(res.data.summary);
    toast.success('团队汇总已生成');
  };
  const handleAddMember = async () => {
    if (!selectedTeamId || !memberUserId) return toast.error('请选择要添加的成员');
    setMemberSaving(true);
    const res = await addReportTeamMember({
      teamId: selectedTeamId,
      userId: memberUserId,
      role: memberRole,
      jobTitle: memberJobTitle.trim() || undefined,
    });
    setMemberSaving(false);
    if (!res.success) return toast.error(res.error?.message || '操作失败');
    toast.success('成员已添加');
    setShowAddMemberDialog(false);
    setMemberUserId('');
    setMemberRole(ReportTeamRole.Member);
    setMemberJobTitle('');
    await loadTeams();
    await refreshManagedData();
  };
  const handleRemoveMember = async (memberUserIdValue: string) => {
    if (!selectedTeamId || !window.confirm('确认移除该成员？')) return;
    const res = await removeReportTeamMember({ teamId: selectedTeamId, userId: memberUserIdValue });
    if (!res.success) return toast.error(res.error?.message || '操作失败');
    toast.success('成员已移除');
    await loadTeams();
    await refreshManagedData();
  };
  const handleLeaveSelectedTeam = async () => {
    if (!selectedTeamId || !window.confirm('确认退出该团队？')) return;
    const res = await leaveReportTeam({ teamId: selectedTeamId });
    if (!res.success) return toast.error(res.error?.message || '退出失败');
    toast.success('你已退出该团队');
    await loadTeams();
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

  const submissionRate = dashboard ? Math.round(((dashboard.stats.submitted + dashboard.stats.reviewed) / Math.max(1, dashboard.stats.total)) * 100) : 0;
  const memberStats = useMemo(() => {
    if (!dashboard) {
      return { all: 0, pending: 0, reviewed: 0, attention: 0, notStarted: 0 };
    }
    const pending = dashboard.members.filter((m) => m.reportStatus === WeeklyReportStatus.Submitted).length;
    const reviewed = dashboard.members.filter((m) => m.reportStatus === WeeklyReportStatus.Reviewed).length;
    const attention = dashboard.members.filter(
      (m) => m.reportStatus === WeeklyReportStatus.Returned || m.reportStatus === WeeklyReportStatus.Overdue
    ).length;
    const notStarted = dashboard.members.filter(
      (m) => m.reportStatus === WeeklyReportStatus.NotStarted || m.reportStatus === WeeklyReportStatus.Draft
    ).length;
    return { all: dashboard.members.length, pending, reviewed, attention, notStarted };
  }, [dashboard]);

  const filteredMembers = useMemo(() => {
    if (!dashboard) return [];
    const list = dashboard.members.filter((member) => {
      if (memberFilter === 'all') return true;
      if (memberFilter === 'pending') return member.reportStatus === WeeklyReportStatus.Submitted;
      if (memberFilter === 'reviewed') return member.reportStatus === WeeklyReportStatus.Reviewed;
      if (memberFilter === 'attention') {
        return member.reportStatus === WeeklyReportStatus.Returned || member.reportStatus === WeeklyReportStatus.Overdue;
      }
      return member.reportStatus === WeeklyReportStatus.NotStarted || member.reportStatus === WeeklyReportStatus.Draft;
    });

    return list.slice().sort((a, b) => {
      const byStatus = getMemberPriority(a.reportStatus) - getMemberPriority(b.reportStatus);
      if (byStatus !== 0) return byStatus;
      return (a.userName || '').localeCompare(b.userName || '');
    });
  }, [dashboard, memberFilter]);

  const handlePrevWeek = () => {
    if (weekNumber <= 1) {
      setWeekYear((v) => v - 1);
      setWeekNumber(52);
      return;
    }
    setWeekNumber((v) => v - 1);
  };
  const handleNextWeek = () => {
    if (weekNumber >= 52) {
      setWeekYear((v) => v + 1);
      setWeekNumber(1);
      return;
    }
    setWeekNumber((v) => v + 1);
  };
  const availableUsers = useMemo<ReportUser[]>(() => {
    if (!dashboard) return users;
    const ids = new Set(dashboard.members.map((m) => m.userId));
    return users.filter((u) => !ids.has(u.id));
  }, [dashboard, users]);

  const memberFilterItems: Array<{ key: MemberFilter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: memberStats.all },
    { key: 'pending', label: '待审阅', count: memberStats.pending },
    { key: 'reviewed', label: '已审阅', count: memberStats.reviewed },
    { key: 'attention', label: '需关注', count: memberStats.attention },
    { key: 'notStarted', label: '未开始/草稿', count: memberStats.notStarted },
  ];

  if (teams.length === 0) {
    return <div className="text-center py-14 text-[13px]" style={{ color: 'var(--text-muted)' }}>暂无可访问团队</div>;
  }

  const hasScopedTeams = scopedTeams.length > 0;
  const openReportDetail = (reportId: string) => navigate(`/report-agent/report/${reportId}`);

  return (
    <div className="mx-auto w-full max-w-[1180px] flex flex-col gap-4">
      {returnDialogId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.5)' }}>
          <GlassCard className="p-6 w-[440px]">
            <div className="text-[16px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>退回周报</div>
            <textarea className="w-full text-[13px] px-4 py-3 rounded-xl resize-none" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', minHeight: 100 }} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="请输入退回原因（必填）..." />
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => { setReturnDialogId(null); setReturnReason(''); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleReturn} disabled={!returnReason.trim()}>确认退回</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {showAddMemberDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.5)' }}>
          <GlassCard className="p-6 w-[440px]">
            <div className="text-[16px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>添加团队成员</div>
            <div className="flex flex-col gap-3">
              <select className="w-full px-3 py-2.5 rounded-xl text-[13px]" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }} value={memberUserId} onChange={(e) => setMemberUserId(e.target.value)}>
                <option value="">选择成员</option>
                {availableUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName || u.username}</option>)}
              </select>
              <select className="w-full px-3 py-2.5 rounded-xl text-[13px]" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }} value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                <option value={ReportTeamRole.Member}>成员</option>
                <option value={ReportTeamRole.Deputy}>副负责人</option>
                <option value={ReportTeamRole.Leader}>负责人</option>
              </select>
              <input className="w-full px-3 py-2.5 rounded-xl text-[13px]" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }} placeholder="岗位（可选）" value={memberJobTitle} onChange={(e) => setMemberJobTitle(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => setShowAddMemberDialog(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleAddMember} disabled={memberSaving || !memberUserId}>{memberSaving ? '添加中...' : '确认添加'}</Button>
            </div>
          </GlassCard>
        </div>
      )}

      <GlassCard variant="subtle" className="px-5 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="surface-inset rounded-xl p-1 flex items-center gap-1">
            <button
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200"
              style={{
                background: teamScope === 'managed' ? 'rgba(59,130,246,.15)' : 'transparent',
                color: teamScope === 'managed' ? 'rgba(59,130,246,.95)' : 'var(--text-secondary)',
              }}
              onClick={() => setTeamScope('managed')}
            >
              我管理的团队 ({managedTeams.length})
            </button>
            <button
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200"
              style={{
                background: teamScope === 'joined' ? 'rgba(34,197,94,.15)' : 'transparent',
                color: teamScope === 'joined' ? 'rgba(34,197,94,.95)' : 'var(--text-secondary)',
              }}
              onClick={() => setTeamScope('joined')}
            >
              我加入的团队 ({joinedTeams.length})
            </button>
          </div>
          <div className="flex items-center gap-2.5">
            <select
              className="surface-inset px-3 py-2 rounded-xl text-[13px] min-w-[220px]"
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              disabled={!hasScopedTeams}
            >
              {hasScopedTeams ? scopedTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>) : <option value="">暂无团队</option>}
            </select>
            {teamScope === 'managed' && (
              <>
                <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
                <Button variant="ghost" size="sm" onClick={handlePrevWeek}><ChevronLeft size={15} /></Button>
                <span className="text-[14px] font-semibold whitespace-nowrap">{weekYear} 年第 {weekNumber} 周</span>
                <Button variant="ghost" size="sm" onClick={handleNextWeek}><ChevronRight size={15} /></Button>
              </>
            )}
          </div>
        </div>
      </GlassCard>

      {!hasScopedTeams && <GlassCard variant="subtle" className="py-10 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>{teamScope === 'managed' ? '暂无你可管理的团队' : '暂无你加入的团队'}</GlassCard>}

      {teamScope === 'joined' && hasScopedTeams && selectedTeam && (
        <GlassCard variant="subtle" className="p-5">
          <div className="surface-inset rounded-2xl px-4 py-4 flex items-start justify-between gap-4">
            <div>
              <div className="text-[16px] font-semibold mb-1">{selectedTeam.name}</div>
              <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>负责人：{selectedTeam.leaderName || selectedTeam.leaderUserId}</div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                你的角色：{getMemberRoleLabel(selectedTeam.myRole)}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={handleLeaveSelectedTeam} disabled={!canLeaveSelectedTeam}><LogOut size={13} /> 退出团队</Button>
          </div>
        </GlassCard>
      )}

      {teamScope === 'managed' && hasScopedTeams && dashboard && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <GlassCard variant="subtle" className="surface-raised p-0 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-primary)' }}>
                <div>
                  <div className="flex items-center gap-2.5">
                    <Sparkles size={16} />
                    <span className="text-[15px] font-semibold">团队周报汇总</span>
                  </div>
                  {summary && (
                    <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                      覆盖 {summary.submittedCount}/{summary.memberCount} 人 · 最近更新 {new Date(summary.updatedAt).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {summary && <Button variant="ghost" size="sm" onClick={handleExportSummary}><Download size={13} /></Button>}
                  <Button variant="primary" size="sm" onClick={handleGenerateSummary} disabled={generatingSummary}>{generatingSummary ? <Loader2 size={13} className="animate-spin mr-1" /> : <Sparkles size={13} className="mr-1" />}{summary ? '重新生成' : '生成汇总'}</Button>
                </div>
              </div>
              <div className="px-5 py-4 max-h-[420px] overflow-auto">
                {summaryLoading ? <div className="text-[12px] text-center py-10">加载中...</div> : summary ? (
                  <div className="flex flex-col gap-4">
                    {summary.sections.map((section, idx) => (
                      <div key={idx} className="surface-inset rounded-xl p-3">
                        <div className="flex items-center gap-2.5 mb-2">
                          <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white" style={{ background: summaryColors[idx % summaryColors.length] }}>{idx + 1}</div>
                          <span className="text-[13px] font-semibold">{section.title}</span>
                        </div>
                        {section.items.length === 0 ? <div className="text-[12px] ml-7" style={{ color: 'var(--text-muted)' }}>（无内容）</div> : (
                          <ul className="ml-7 space-y-1.5">{section.items.map((item, i) => <li key={i} className="text-[12px] leading-relaxed">{item}</li>)}</ul>
                        )}
                      </div>
                    ))}
                  </div>
                ) : <div className="text-center py-10 text-[13px]" style={{ color: 'var(--text-muted)' }}>暂无汇总，点击“生成汇总”</div>}
              </div>
            </GlassCard>
            <div className="flex flex-col gap-4">
              <GlassCard variant="subtle" className="surface-inset p-4">
                <div className="text-[12px] font-medium mb-2">提交进度</div>
                <div className="flex items-center justify-between mb-2 text-[12px]"><span>{dashboard.stats.submitted + dashboard.stats.reviewed}/{dashboard.stats.total}</span><span className="font-semibold">{submissionRate}%</span></div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}><div className="h-full rounded-full" style={{ width: `${submissionRate}%`, background: 'linear-gradient(90deg, rgba(59,130,246,.7), rgba(59,130,246,.4))' }} /></div>
              </GlassCard>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="总人数" value={dashboard.stats.total} icon={<Users size={16} />} color="rgba(148,163,184,.9)" bg="rgba(148,163,184,.06)" />
                <StatCard label="待审阅" value={dashboard.stats.submitted} icon={<FileClock size={16} />} color="rgba(59,130,246,.9)" bg="rgba(59,130,246,.06)" />
                <StatCard label="已审阅" value={dashboard.stats.reviewed} icon={<FileCheck size={16} />} color="rgba(34,197,94,.9)" bg="rgba(34,197,94,.06)" />
                <StatCard label="未开始" value={dashboard.stats.notStarted} icon={<Clock size={16} />} color="rgba(156,163,175,.75)" bg="rgba(156,163,175,.04)" />
              </div>
            </div>
          </div>

          <GlassCard variant="subtle" className="p-0 overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between cursor-pointer select-none" style={{ borderBottom: membersExpanded ? '1px solid var(--border-primary)' : undefined }} onClick={() => setMembersExpanded((v) => !v)}>
              <div className="flex items-center gap-2"><span className="text-[13px] font-medium">团队成员（默认隐藏）</span><span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{dashboard.members.length} 人</span></div>
              <div className="flex items-center gap-2">
                {canManageMembers && membersExpanded && <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); setShowAddMemberDialog(true); }}><UserPlus size={12} /> 添加成员</Button>}
                {membersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </div>
            </div>
            {membersExpanded && (
              <div className="px-4 py-3 flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {memberFilterItems.map((item) => (
                    <button
                      key={item.key}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-200 surface-inset"
                      style={{
                        color: memberFilter === item.key ? 'var(--text-primary)' : 'var(--text-muted)',
                        borderColor: memberFilter === item.key ? 'var(--border-primary)' : undefined,
                      }}
                      onClick={() => setMemberFilter(item.key)}
                    >
                      {item.label} · {item.count}
                    </button>
                  ))}
                </div>

                {filteredMembers.length === 0 && (
                  <div className="surface-inset rounded-xl px-4 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    当前筛选下暂无成员
                  </div>
                )}

                {filteredMembers.map((member) => {
                  const cfg = statusConfig[member.reportStatus] || statusConfig[WeeklyReportStatus.NotStarted];
                  const StatusIcon = cfg.icon;
                  const canRemove = canManageMembers && member.role !== ReportTeamRole.Leader;
                  return (
                    <div key={member.userId} className="surface-row rounded-xl flex items-center justify-between px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium truncate">{member.userName || member.userId}</div>
                        <div className="flex items-center flex-wrap gap-2 mt-1">
                          <span className="text-[11px] surface-inset rounded-full px-2 py-0.5">{getMemberRoleLabel(member.role)}</span>
                          {member.jobTitle && (
                            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{member.jobTitle}</span>
                          )}
                          <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ color: cfg.color, background: cfg.bg }}>
                            <StatusIcon size={10} />
                            {cfg.label}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {member.reportId && <Button variant="ghost" size="sm" onClick={() => openReportDetail(member.reportId!)}><ExternalLink size={13} /> 查看</Button>}
                        {member.reportId && member.reportStatus === WeeklyReportStatus.Submitted && <><Button variant="primary" size="sm" onClick={() => handleReview(member.reportId!)}>审阅</Button><Button variant="secondary" size="sm" onClick={() => setReturnDialogId(member.reportId!)}>打回</Button></>}
                        {member.reportId && member.reportStatus === WeeklyReportStatus.Reviewed && <Button variant="secondary" size="sm" onClick={() => setReturnDialogId(member.reportId!)}>打回</Button>}
                        {canRemove && <Button variant="ghost" size="sm" onClick={() => handleRemoveMember(member.userId)}><UserMinus size={12} /></Button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </GlassCard>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, color, bg }: { label: string; value: number; icon: React.ReactNode; color: string; bg: string; }) {
  return (
    <div className="surface-inset rounded-xl px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: bg, color }}>{icon}</div>
      </div>
      <div className="text-[24px] font-bold mt-1.5 leading-none" style={{ color }}>{value}</div>
    </div>
  );
}
