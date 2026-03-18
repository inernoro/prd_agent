import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  LogOut,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
  X,
  CheckCircle2,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import {
  addReportTeamMember,
  exportTeamSummaryMarkdown,
  generateTeamSummary,
  getTeamSummaryView,
  leaveReportTeam,
  removeReportTeamMember,
  reviewWeeklyReport,
  returnWeeklyReport,
} from '@/services';
import { ReportTeamRole, WeeklyReportStatus } from '@/services/contracts/reportAgent';
import type { ReportUser, TeamSummaryViewData } from '@/services/contracts/reportAgent';

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

const summaryColors = ['rgba(59,130,246,.9)', 'rgba(34,197,94,.9)', 'rgba(168,85,247,.9)', 'rgba(249,115,22,.9)'];

const statusConfig: Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156,163,175,.8)', bg: 'rgba(156,163,175,.08)', icon: Clock },
  [WeeklyReportStatus.Draft]: { label: '草稿', color: 'rgba(156,163,175,.92)', bg: 'rgba(156,163,175,.08)', icon: Clock },
  [WeeklyReportStatus.Submitted]: { label: '待审阅', color: 'rgba(59,130,246,.9)', bg: 'rgba(59,130,246,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Reviewed]: { label: '已审阅', color: 'rgba(34,197,94,.9)', bg: 'rgba(34,197,94,.08)', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]: { label: '已打回', color: 'rgba(239,68,68,.9)', bg: 'rgba(239,68,68,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Overdue]: { label: '逾期', color: 'rgba(239,68,68,.9)', bg: 'rgba(239,68,68,.08)', icon: AlertCircle },
  [WeeklyReportStatus.Viewed]: { label: '已查看', color: 'rgba(14,165,233,.9)', bg: 'rgba(14,165,233,.08)', icon: CheckCircle2 },
};

function getMemberRoleLabel(role?: string | null): string {
  if (role === ReportTeamRole.Leader) return '负责人';
  if (role === ReportTeamRole.Deputy) return '副负责人';
  return '成员';
}

function getMemberPriority(status?: string): number {
  if (status === WeeklyReportStatus.Submitted) return 0;
  if (status === WeeklyReportStatus.Returned || status === WeeklyReportStatus.Overdue) return 1;
  if (status === WeeklyReportStatus.Reviewed || status === WeeklyReportStatus.Viewed) return 2;
  if (status === WeeklyReportStatus.Draft) return 3;
  return 4;
}

export function TeamDashboard() {
  const { teams, users, loadUsers, loadTeams } = useReportAgentStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const navigate = useNavigate();

  const [teamScope, setTeamScope] = useState<'managed' | 'joined'>('managed');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [memberDrawerOpen, setMemberDrawerOpen] = useState(false);

  const now = useMemo(() => getISOWeek(new Date()), []);
  const [weekYear, setWeekYear] = useState(now.weekYear);
  const [weekNumber, setWeekNumber] = useState(now.weekNumber);

  const [summaryView, setSummaryView] = useState<TeamSummaryViewData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false);
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<string>(ReportTeamRole.Member);
  const [memberJobTitle, setMemberJobTitle] = useState('');
  const [memberSaving, setMemberSaving] = useState(false);

  const [returnDialogId, setReturnDialogId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');

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
  const selectedTeam = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? null, [teams, selectedTeamId]);
  const hasScopedTeams = scopedTeams.length > 0;
  const canLeaveSelectedTeam = !!selectedTeam?.canLeave;

  const isLeaderOrDeputyOnSelectedTeam = useMemo(() => {
    if (!selectedTeam) return false;
    const role = selectedTeam.myRole ?? (selectedTeam.leaderUserId === userId ? ReportTeamRole.Leader : undefined);
    return role === ReportTeamRole.Leader || role === ReportTeamRole.Deputy;
  }, [selectedTeam, userId]);

  const canManageMembers = !!summaryView?.canManageMembers;

  const loadSummaryView = useCallback(async () => {
    if (!selectedTeamId) {
      setSummaryView(null);
      return;
    }
    setSummaryLoading(true);
    const res = await getTeamSummaryView({ teamId: selectedTeamId, weekYear, weekNumber });
    if (res.success && res.data) {
      setSummaryView(res.data);
    } else {
      setSummaryView(null);
      if (res.error?.message) toast.error(res.error.message);
    }
    setSummaryLoading(false);
  }, [selectedTeamId, weekYear, weekNumber]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (!hasScopedTeams) {
      setSelectedTeamId('');
      setSummaryView(null);
      setMemberDrawerOpen(false);
      return;
    }
    if (!scopedTeams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(scopedTeams[0].id);
    }
  }, [hasScopedTeams, scopedTeams, selectedTeamId]);

  useEffect(() => {
    setMemberDrawerOpen(false);
  }, [teamScope, selectedTeamId]);

  useEffect(() => {
    void loadSummaryView();
  }, [loadSummaryView]);

  const members = useMemo(() => {
    const list = summaryView?.members ?? [];
    return list.slice().sort((a, b) => {
      const byStatus = getMemberPriority(a.reportStatus) - getMemberPriority(b.reportStatus);
      if (byStatus !== 0) return byStatus;
      return (a.userName || '').localeCompare(b.userName || '');
    });
  }, [summaryView]);

  const availableUsers = useMemo<ReportUser[]>(() => {
    const memberIds = new Set((summaryView?.members ?? []).map((member) => member.userId));
    return users.filter((user) => !memberIds.has(user.id));
  }, [summaryView, users]);

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

  const handleGenerateSummary = async () => {
    if (!selectedTeamId) return;
    setGeneratingSummary(true);
    const res = await generateTeamSummary({ teamId: selectedTeamId, weekYear, weekNumber });
    setGeneratingSummary(false);
    if (!res.success) {
      toast.error(res.error?.message || '生成汇总失败');
      return;
    }
    toast.success('团队汇总已生成');
    await loadSummaryView();
  };

  const handleExportSummary = async () => {
    if (!selectedTeamId || !summaryView?.summary) return;
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

  const handleLeaveSelectedTeam = async () => {
    if (!selectedTeamId || !window.confirm('确认退出该团队？')) return;
    const res = await leaveReportTeam({ teamId: selectedTeamId });
    if (!res.success) {
      toast.error(res.error?.message || '退出失败');
      return;
    }
    toast.success('你已退出该团队');
    await loadTeams();
    setMemberDrawerOpen(false);
  };

  const handleAddMember = async () => {
    if (!selectedTeamId || !memberUserId) {
      toast.error('请选择要添加的成员');
      return;
    }
    setMemberSaving(true);
    const res = await addReportTeamMember({
      teamId: selectedTeamId,
      userId: memberUserId,
      role: memberRole,
      jobTitle: memberJobTitle.trim() || undefined,
    });
    setMemberSaving(false);
    if (!res.success) {
      toast.error(res.error?.message || '添加失败');
      return;
    }
    toast.success('成员已添加');
    setShowAddMemberDialog(false);
    setMemberUserId('');
    setMemberRole(ReportTeamRole.Member);
    setMemberJobTitle('');
    await loadTeams();
    await loadSummaryView();
  };

  const handleRemoveMember = async (targetUserId: string) => {
    if (!selectedTeamId || !window.confirm('确认移除该成员？')) return;
    const res = await removeReportTeamMember({ teamId: selectedTeamId, userId: targetUserId });
    if (!res.success) {
      toast.error(res.error?.message || '移除失败');
      return;
    }
    toast.success('成员已移除');
    await loadTeams();
    await loadSummaryView();
  };

  const handleReview = async (reportId: string) => {
    const res = await reviewWeeklyReport({ id: reportId });
    if (!res.success) {
      toast.error(res.error?.message || '审阅失败');
      return;
    }
    toast.success('已审阅');
    await loadSummaryView();
  };

  const handleReturn = async () => {
    if (!returnDialogId || !returnReason.trim()) {
      toast.error('请填写退回原因');
      return;
    }
    const res = await returnWeeklyReport({ id: returnDialogId, reason: returnReason.trim() });
    if (!res.success) {
      toast.error(res.error?.message || '打回失败');
      return;
    }
    toast.success('已打回');
    setReturnDialogId(null);
    setReturnReason('');
    await loadSummaryView();
  };

  const openReportDetail = (reportId: string) => navigate(`/report-agent/report/${reportId}`);

  return (
    <div className="mx-auto w-full max-w-[1180px] flex flex-col gap-4">
      {returnDialogId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.55)' }}>
          <GlassCard className="p-6 w-[440px]">
            <div className="text-[16px] font-semibold mb-3">退回周报</div>
            <textarea
              className="w-full text-[13px] px-4 py-3 rounded-xl resize-none"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', minHeight: 110 }}
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              placeholder="请输入退回原因（必填）"
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => { setReturnDialogId(null); setReturnReason(''); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleReturn} disabled={!returnReason.trim()}>确认打回</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {showAddMemberDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.55)' }}>
          <GlassCard className="p-6 w-[440px]">
            <div className="text-[16px] font-semibold mb-3">添加团队成员</div>
            <div className="flex flex-col gap-3">
              <select className="surface-inset w-full rounded-xl px-3 py-2.5 text-[13px]" value={memberUserId} onChange={(e) => setMemberUserId(e.target.value)}>
                <option value="">选择成员</option>
                {availableUsers.map((user) => <option key={user.id} value={user.id}>{user.displayName || user.username}</option>)}
              </select>
              <select className="surface-inset w-full rounded-xl px-3 py-2.5 text-[13px]" value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                <option value={ReportTeamRole.Member}>成员</option>
                <option value={ReportTeamRole.Deputy}>副负责人</option>
                <option value={ReportTeamRole.Leader}>负责人</option>
              </select>
              <input className="surface-inset w-full rounded-xl px-3 py-2.5 text-[13px]" placeholder="岗位（可选）" value={memberJobTitle} onChange={(e) => setMemberJobTitle(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => setShowAddMemberDialog(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleAddMember} disabled={memberSaving || !memberUserId}>{memberSaving ? '添加中...' : '确认添加'}</Button>
            </div>
          </GlassCard>
        </div>
      )}

      {memberDrawerOpen && selectedTeam && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setMemberDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative h-full w-full max-w-[500px] surface p-0 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 surface-inset px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-[15px] font-semibold">团队成员</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{selectedTeam.name}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setMemberDrawerOpen(false)}><X size={14} /></Button>
            </div>
            <div className="p-4 space-y-3">
              {!summaryView?.canViewAllMembers && (
                <div className="surface-inset rounded-xl px-3 py-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  当前团队未公开成员周报，仅展示你本人信息。
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>成员数：{members.length}</div>
                {canManageMembers && (
                  <Button variant="secondary" size="sm" onClick={() => setShowAddMemberDialog(true)}>
                    <UserPlus size={12} /> 添加成员
                  </Button>
                )}
              </div>
              {members.map((member) => {
                const cfg = statusConfig[member.reportStatus] || statusConfig[WeeklyReportStatus.NotStarted];
                const StatusIcon = cfg.icon;
                const canRemove = canManageMembers && summaryView?.canViewAllMembers && member.role !== ReportTeamRole.Leader;
                return (
                  <div key={member.userId} className="surface-row rounded-xl px-3 py-3 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{member.userName || member.userId}</div>
                      <div className="mt-1 flex items-center flex-wrap gap-2">
                        <span className="surface-inset rounded-full px-2 py-0.5 text-[11px]">{getMemberRoleLabel(member.role)}</span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ color: cfg.color, background: cfg.bg }}>
                          <StatusIcon size={10} />
                          {cfg.label}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {member.reportId && <Button variant="ghost" size="sm" onClick={() => openReportDetail(member.reportId!)}><ExternalLink size={13} /> 查看</Button>}
                      {isLeaderOrDeputyOnSelectedTeam && member.reportId && member.reportStatus === WeeklyReportStatus.Submitted && (
                        <>
                          <Button variant="primary" size="sm" onClick={() => handleReview(member.reportId!)}>审阅</Button>
                          <Button variant="secondary" size="sm" onClick={() => setReturnDialogId(member.reportId!)}>打回</Button>
                        </>
                      )}
                      {isLeaderOrDeputyOnSelectedTeam && member.reportId && member.reportStatus === WeeklyReportStatus.Reviewed && (
                        <Button variant="secondary" size="sm" onClick={() => setReturnDialogId(member.reportId!)}>打回</Button>
                      )}
                      {canRemove && <Button variant="ghost" size="sm" onClick={() => handleRemoveMember(member.userId)}><UserMinus size={12} /></Button>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
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

          <div className="flex items-center gap-2.5 flex-wrap justify-end">
            <select
              className="surface-inset px-3 py-2 rounded-xl text-[13px] min-w-[220px]"
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              disabled={!hasScopedTeams}
            >
              {hasScopedTeams
                ? scopedTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)
                : <option value="">暂无团队</option>}
            </select>
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={handlePrevWeek}><ChevronLeft size={15} /></Button>
            <span className="text-[14px] font-semibold whitespace-nowrap">{weekYear} 年第 {weekNumber} 周</span>
            <Button variant="ghost" size="sm" onClick={handleNextWeek}><ChevronRight size={15} /></Button>
            {selectedTeamId && (
              <Button variant="secondary" size="sm" onClick={() => setMemberDrawerOpen(true)}>
                <Users size={13} />
                团队成员
              </Button>
            )}
          </div>
        </div>
      </GlassCard>

      {!hasScopedTeams && (
        <GlassCard variant="subtle" className="py-10 text-center">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {teamScope === 'managed' ? '暂无你管理的团队' : '暂无你加入的团队'}
          </div>
        </GlassCard>
      )}

      {teamScope === 'joined' && hasScopedTeams && selectedTeam && (
        <GlassCard variant="subtle" className="p-5">
          <div className="surface-inset rounded-2xl px-4 py-4 flex items-start justify-between gap-4">
            <div>
              <div className="text-[16px] font-semibold mb-1">{selectedTeam.name}</div>
              <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                负责人：{selectedTeam.leaderName || selectedTeam.leaderUserId}
              </div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                你的角色：{getMemberRoleLabel(selectedTeam.myRole)}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={handleLeaveSelectedTeam} disabled={!canLeaveSelectedTeam}>
              <LogOut size={13} />
              退出团队
            </Button>
          </div>
        </GlassCard>
      )}

      {hasScopedTeams && selectedTeamId && (
        <GlassCard variant="subtle" className="surface-raised p-0 overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
            <div>
              <div className="flex items-center gap-2.5">
                <Sparkles size={16} />
                <span className="text-[15px] font-semibold">团队周报汇总</span>
              </div>
              {summaryView?.visibilityScope === 'self_only' && (
                <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  当前团队未公开成员周报，仅展示你本人已提交周报汇总。
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {summaryView?.summary && <Button variant="ghost" size="sm" onClick={handleExportSummary}><Download size={13} /></Button>}
              {summaryView?.canGenerateSummary && (
                <Button variant="primary" size="sm" onClick={handleGenerateSummary} disabled={generatingSummary}>
                  {generatingSummary ? <Loader2 size={13} className="animate-spin mr-1" /> : <Sparkles size={13} className="mr-1" />}
                  {summaryView?.summary ? '重新生成' : '生成汇总'}
                </Button>
              )}
            </div>
          </div>
          <div className="px-5 py-4 max-h-[500px] overflow-auto">
            {summaryLoading ? (
              <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : summaryView?.summary ? (
              <div className="flex flex-col gap-4">
                {summaryView.message && (
                  <div className="surface-inset rounded-xl px-3 py-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {summaryView.message}
                  </div>
                )}
                {summaryView.summary.sections.map((section, idx) => (
                  <div key={idx} className="surface-inset rounded-xl p-3">
                    <div className="flex items-center gap-2.5 mb-2">
                      <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white" style={{ background: summaryColors[idx % summaryColors.length] }}>
                        {idx + 1}
                      </div>
                      <span className="text-[13px] font-semibold">{section.title}</span>
                    </div>
                    {section.items.length === 0 ? (
                      <div className="text-[12px] ml-7" style={{ color: 'var(--text-muted)' }}>（无内容）</div>
                    ) : (
                      <ul className="ml-7 space-y-1.5">
                        {section.items.map((item, itemIdx) => <li key={itemIdx} className="text-[12px] leading-relaxed">{item}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  {summaryView?.message || '暂无汇总内容'}
                </div>
              </div>
            )}
          </div>
        </GlassCard>
      )}
    </div>
  );
}
