import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  LogOut,
  Share2,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import {
  batchAddReportTeamMembers,
  generateTeamSummary,
  getTeamReportsView,
  getTeamSummaryView,
  leaveReportTeam,
  removeReportTeamMember,
} from '@/services';
import { ReportTeamRole, WeeklyReportStatus } from '@/services/contracts/reportAgent';
import type { TeamDashboardMember, TeamReportsViewData, TeamSummaryViewData } from '@/services/contracts/reportAgent';
import { UserMultiSearchSelect } from '@/components/UserMultiSearchSelect';
import { ShareTeamWeekDialog } from './ShareTeamWeekDialog';
import { WeekNavRail } from './WeekNavRail';
import { MemberReportInlineView } from './MemberReportInlineView';
import { TeamIssuesPanel } from './TeamIssuesPanel';
import { useDataTheme } from '../hooks/useDataTheme';

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

const summaryColors = ['rgba(59,130,246,.9)', 'rgba(34,197,94,.9)', 'rgba(168,85,247,.9)', 'rgba(249,115,22,.9)'];
const DRAWER_CLOSE_MS = 220;
const DRAWER_ENTER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

function buildStatusConfig(isLight: boolean): Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> {
  // 浅色模式:文字色升级到 600/700 色阶 alpha 1.0 (WCAG 4.5:1+),底色 alpha 0.10
  if (isLight) {
    return {
      [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(71,85,105,1)',  bg: 'rgba(71,85,105,.10)',  icon: Clock },
      [WeeklyReportStatus.Draft]:      { label: '草稿',   color: 'rgba(71,85,105,1)',  bg: 'rgba(71,85,105,.10)',  icon: Clock },
      [WeeklyReportStatus.Submitted]:  { label: '待审阅', color: 'rgba(29,78,216,1)',  bg: 'rgba(29,78,216,.10)',  icon: AlertCircle },
      [WeeklyReportStatus.Reviewed]:   { label: '已审阅', color: 'rgba(21,128,61,1)',  bg: 'rgba(21,128,61,.10)',  icon: CheckCircle2 },
      [WeeklyReportStatus.Returned]:   { label: '已打回', color: 'rgba(185,28,28,1)',  bg: 'rgba(185,28,28,.10)',  icon: AlertCircle },
      [WeeklyReportStatus.Overdue]:    { label: '逾期',   color: 'rgba(185,28,28,1)',  bg: 'rgba(185,28,28,.10)',  icon: AlertCircle },
      [WeeklyReportStatus.Viewed]:     { label: '已查看', color: 'rgba(3,105,161,1)',  bg: 'rgba(3,105,161,.10)',  icon: CheckCircle2 },
    };
  }
  return {
    [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156,163,175,.82)', bg: 'rgba(156,163,175,.08)', icon: Clock },
    [WeeklyReportStatus.Draft]:      { label: '草稿',   color: 'rgba(156,163,175,.92)', bg: 'rgba(156,163,175,.08)', icon: Clock },
    [WeeklyReportStatus.Submitted]:  { label: '待审阅', color: 'rgba(59,130,246,.9)',   bg: 'rgba(59,130,246,.08)',  icon: AlertCircle },
    [WeeklyReportStatus.Reviewed]:   { label: '已审阅', color: 'rgba(34,197,94,.9)',    bg: 'rgba(34,197,94,.08)',   icon: CheckCircle2 },
    [WeeklyReportStatus.Returned]:   { label: '已打回', color: 'rgba(239,68,68,.9)',    bg: 'rgba(239,68,68,.08)',   icon: AlertCircle },
    [WeeklyReportStatus.Overdue]:    { label: '逾期',   color: 'rgba(239,68,68,.9)',    bg: 'rgba(239,68,68,.08)',   icon: AlertCircle },
    [WeeklyReportStatus.Viewed]:     { label: '已查看', color: 'rgba(14,165,233,.9)',   bg: 'rgba(14,165,233,.08)',  icon: CheckCircle2 },
  };
}

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

type ViewMode = 'report_list' | 'ai_summary' | 'issues';

export function TeamDashboard() {
  const { teams, loadTeams } = useReportAgentStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const statusConfig = useMemo(() => buildStatusConfig(isLight), [isLight]);

  const now = useMemo(() => getISOWeek(new Date()), []);
  const teamScope: 'managed' | 'joined' = searchParams.get('scope') === 'joined' ? 'joined' : 'managed';
  const selectedTeamId = searchParams.get('teamId') ?? '';
  const weekYear = (() => {
    const v = Number.parseInt(searchParams.get('weekYear') ?? '', 10);
    return Number.isFinite(v) && v >= 2000 && v <= 2100 ? v : now.weekYear;
  })();
  const weekNumber = (() => {
    const v = Number.parseInt(searchParams.get('weekNumber') ?? '', 10);
    return Number.isFinite(v) && v >= 1 && v <= 53 ? v : now.weekNumber;
  })();
  const selectedMemberUserId = searchParams.get('memberUserId') || null;

  const updateParams = useCallback(
    (patch: Record<string, string | number | null | undefined>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === undefined || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const setTeamScope = useCallback(
    (scope: 'managed' | 'joined') => {
      updateParams({ scope: scope === 'managed' ? null : scope, teamId: null, memberUserId: null });
    },
    [updateParams]
  );

  const setSelectedTeamId = useCallback(
    (id: string) => {
      updateParams({ teamId: id || null, memberUserId: null });
    },
    [updateParams]
  );

  const setSelectedMemberUserId = useCallback(
    (userId: string | null) => {
      updateParams({ memberUserId: userId || null });
    },
    [updateParams]
  );

  const jumpToWeek = useCallback(
    (y: number, w: number) => {
      updateParams({ weekYear: y, weekNumber: w, memberUserId: null });
    },
    [updateParams]
  );

  const [viewMode, setViewMode] = useState<ViewMode>('report_list');

  const [memberDrawerVisible, setMemberDrawerVisible] = useState(false);
  const [memberDrawerOpen, setMemberDrawerOpen] = useState(false);
  const drawerCloseTimerRef = useRef<number | null>(null);

  const [reportsView, setReportsView] = useState<TeamReportsViewData | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [summaryView, setSummaryView] = useState<TeamSummaryViewData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  // Per-week cache: 键 "teamId|year|week" → { members, fetchedAt }
  type WeekCacheEntry = { members: TeamDashboardMember[]; fetchedAt: number };
  const weekCacheRef = useRef<Map<string, WeekCacheEntry>>(new Map());
  const [cacheTick, setCacheTick] = useState(0); // 用于触发 currentWeekMembers 重新 memoize

  const [memberFormOpen, setMemberFormOpen] = useState(false);
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [memberRole, setMemberRole] = useState<string>(ReportTeamRole.Member);
  const [memberJobTitle, setMemberJobTitle] = useState('');
  const [memberSaving, setMemberSaving] = useState(false);
  const [pendingRemoveUserId, setPendingRemoveUserId] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);

  const closeMemberDrawer = useCallback((immediate = false) => {
    if (drawerCloseTimerRef.current) {
      window.clearTimeout(drawerCloseTimerRef.current);
      drawerCloseTimerRef.current = null;
    }
    setMemberDrawerOpen(false);
    if (immediate) {
      setMemberDrawerVisible(false);
      return;
    }
    drawerCloseTimerRef.current = window.setTimeout(() => {
      setMemberDrawerVisible(false);
      drawerCloseTimerRef.current = null;
    }, DRAWER_CLOSE_MS);
  }, []);

  const openMemberDrawer = useCallback(() => {
    if (drawerCloseTimerRef.current) {
      window.clearTimeout(drawerCloseTimerRef.current);
      drawerCloseTimerRef.current = null;
    }
    setMemberDrawerVisible(true);
    window.requestAnimationFrame(() => {
      setMemberDrawerOpen(true);
    });
  }, []);

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

  const canManageMembers = !!reportsView?.canManageMembers;
  const canAccessTeamAiSummary = teamScope === 'managed' && !!reportsView?.canGenerateSummary;

  const loadReportsView = useCallback(async () => {
    if (!selectedTeamId) {
      setReportsView(null);
      return;
    }
    setReportsLoading(true);
    const res = await getTeamReportsView({ teamId: selectedTeamId, weekYear, weekNumber });
    if (res.success && res.data) {
      setReportsView(res.data);
      const key = `${selectedTeamId}|${weekYear}|${weekNumber}`;
      weekCacheRef.current.set(key, { members: res.data.members, fetchedAt: Date.now() });
      setCacheTick((t) => t + 1);
    } else {
      setReportsView(null);
      if (res.error?.message) toast.error(res.error.message);
    }
    setReportsLoading(false);
  }, [selectedTeamId, weekYear, weekNumber]);

  // 切换团队时清空 per-week 缓存
  useEffect(() => {
    weekCacheRef.current.clear();
    setCacheTick((t) => t + 1);
  }, [selectedTeamId]);

  // 监听 ReportDetailPage 审阅/退回事件,局部 mutate reportsView + 周缓存,避免回到列表后还要等下次拉接口
  const lastReportMutation = useReportAgentStore((s) => s.lastReportMutation);
  const clearReportMutation = useReportAgentStore((s) => s.clearReportMutation);
  useEffect(() => {
    if (!lastReportMutation) return;
    const m = lastReportMutation;
    let consumed = false;

    setReportsView((prev) => {
      if (!prev) return prev;
      const itemHit = prev.items.some((it) => it.reportId === m.reportId);
      const memberHit = prev.members.some((mb) => mb.reportId === m.reportId);
      if (!itemHit && !memberHit) return prev;
      consumed = true;
      return {
        ...prev,
        items: prev.items.map((it) =>
          it.reportId === m.reportId
            ? { ...it, status: m.status, submittedAt: m.submittedAt ?? it.submittedAt }
            : it
        ),
        members: prev.members.map((mb) =>
          mb.reportId === m.reportId
            ? { ...mb, reportStatus: m.status, submittedAt: m.submittedAt ?? mb.submittedAt }
            : mb
        ),
      };
    });

    // 同步 per-week 缓存,保证 currentWeekMembers memo 也拿到最新 status
    let cacheChanged = false;
    weekCacheRef.current.forEach((entry) => {
      const idx = entry.members.findIndex((mb) => mb.reportId === m.reportId);
      if (idx >= 0) {
        const next = [...entry.members];
        next[idx] = { ...next[idx], reportStatus: m.status, submittedAt: m.submittedAt ?? next[idx].submittedAt };
        entry.members = next;
        cacheChanged = true;
      }
    });
    if (cacheChanged) setCacheTick((t) => t + 1);

    if (consumed || cacheChanged) clearReportMutation();
  }, [lastReportMutation, clearReportMutation]);

  const currentWeekMembers = useMemo<TeamDashboardMember[]>(() => {
    if (!selectedTeamId) return [];
    const key = `${selectedTeamId}|${weekYear}|${weekNumber}`;
    const cached = weekCacheRef.current.get(key);
    if (cached) return cached.members;
    return reportsView?.members ?? [];
    // 读 cacheTick 触发重新计算，即使 ref.current 自身变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeamId, weekYear, weekNumber, reportsView, cacheTick]);

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

  const reloadListAndSummaryIfNeeded = useCallback(async () => {
    await loadReportsView();
    if (viewMode === 'ai_summary') {
      await loadSummaryView();
    }
  }, [loadReportsView, loadSummaryView, viewMode]);

  useEffect(() => {
    if (!hasScopedTeams) {
      if (selectedTeamId) setSelectedTeamId('');
      setReportsView(null);
      setSummaryView(null);
      closeMemberDrawer(true);
      return;
    }
    if (!scopedTeams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(scopedTeams[0].id);
    }
  }, [closeMemberDrawer, hasScopedTeams, scopedTeams, selectedTeamId, setSelectedTeamId]);

  useEffect(() => {
    setViewMode('report_list');
    closeMemberDrawer(true);
    setMemberFormOpen(false);
    setPendingRemoveUserId(null);
  }, [closeMemberDrawer, teamScope, selectedTeamId]);

  useEffect(() => {
    void loadReportsView();
  }, [loadReportsView]);

  useEffect(() => {
    if (viewMode === 'ai_summary' && canAccessTeamAiSummary) {
      void loadSummaryView();
    }
  }, [canAccessTeamAiSummary, loadSummaryView, viewMode]);

  useEffect(() => {
    if (viewMode === 'ai_summary' && !canAccessTeamAiSummary) {
      setViewMode('report_list');
    }
  }, [canAccessTeamAiSummary, viewMode]);

  useEffect(() => {
    return () => {
      if (drawerCloseTimerRef.current) {
        window.clearTimeout(drawerCloseTimerRef.current);
        drawerCloseTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!memberDrawerVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMemberDrawer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeMemberDrawer, memberDrawerVisible]);

  const members = useMemo(() => {
    const list = reportsView?.members ?? [];
    return list.slice().sort((a, b) => {
      const byStatus = getMemberPriority(a.reportStatus) - getMemberPriority(b.reportStatus);
      if (byStatus !== 0) return byStatus;
      return (a.userName || '').localeCompare(b.userName || '');
    });
  }, [reportsView]);

  const selectedMember = useMemo<TeamDashboardMember | null>(() => {
    if (!selectedMemberUserId) return null;
    return currentWeekMembers.find((m) => m.userId === selectedMemberUserId) ?? null;
  }, [selectedMemberUserId, currentWeekMembers]);

  const handleSelectMember = useCallback(
    (member: TeamDashboardMember) => {
      setSelectedMemberUserId(member.userId);
    },
    [setSelectedMemberUserId]
  );

  const handleBackFromMember = useCallback(() => {
    setSelectedMemberUserId(null);
  }, [setSelectedMemberUserId]);

  const handleSelectSiblingFromDetail = useCallback(
    (_reportId: string, userId: string) => {
      if (userId) setSelectedMemberUserId(userId);
    },
    [setSelectedMemberUserId]
  );

  const handleEnterSummary = async () => {
    if (!canAccessTeamAiSummary) {
      toast.warning('当前视角不支持团队周报AI分析');
      return;
    }
    setViewMode('ai_summary');
    await loadSummaryView();
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

  const handleLeaveSelectedTeam = async () => {
    if (!selectedTeamId || !window.confirm('确认退出该团队？')) return;
    const res = await leaveReportTeam({ teamId: selectedTeamId });
    if (!res.success) {
      toast.error(res.error?.message || '退出失败');
      return;
    }
    toast.success('你已退出该团队');
    await loadTeams();
    closeMemberDrawer();
  };

  const handleAddMember = async () => {
    if (!selectedTeamId || memberUserIds.length === 0) {
      toast.error('请选择要添加的成员');
      return;
    }
    setMemberSaving(true);
    const res = await batchAddReportTeamMembers({
      teamId: selectedTeamId,
      userIds: memberUserIds,
      role: memberRole,
      jobTitle: memberJobTitle.trim() || undefined,
    });
    setMemberSaving(false);
    if (!res.success) {
      toast.error(res.error?.message || '添加失败');
      return;
    }
    const addedCount = res.data.added.length;
    const skippedCount = res.data.skipped.length;
    if (skippedCount > 0) {
      toast.success(`已添加 ${addedCount} 名成员，${skippedCount} 人已在团队中`);
    } else {
      toast.success(`已添加 ${addedCount} 名成员`);
    }
    setMemberFormOpen(false);
    setMemberUserIds([]);
    setMemberRole(ReportTeamRole.Member);
    setMemberJobTitle('');
    await loadTeams();
    await reloadListAndSummaryIfNeeded();
  };

  const handleRemoveMember = async (targetUserId: string) => {
    if (!selectedTeamId) return;
    if (pendingRemoveUserId !== targetUserId) {
      setPendingRemoveUserId(targetUserId);
      return;
    }
    setRemovingUserId(targetUserId);
    const res = await removeReportTeamMember({ teamId: selectedTeamId, userId: targetUserId });
    setRemovingUserId(null);
    if (!res.success) {
      toast.error(res.error?.message || '移除失败');
      return;
    }
    toast.success('成员已移除');
    setPendingRemoveUserId(null);
    await loadTeams();
    await reloadListAndSummaryIfNeeded();
  };

  const openReportDetail = (reportId: string) => {
    if (!selectedTeamId) {
      navigate(`/report-agent/report/${reportId}`);
      return;
    }
    const params = new URLSearchParams({
      teamId: selectedTeamId,
      weekYear: String(weekYear),
      weekNumber: String(weekNumber),
      scope: teamScope,
    });
    navigate(`/report-agent/report/${reportId}?${params.toString()}`);
  };

  return (
    <div className="h-full min-h-0 flex gap-4">
      <WeekNavRail
        selectedYear={weekYear}
        selectedWeek={weekNumber}
        selectedMemberUserId={selectedMemberUserId}
        currentWeekMembers={currentWeekMembers}
        currentWeekLoading={reportsLoading}
        hasTeam={!!selectedTeamId}
        teamName={selectedTeam?.name}
        onSelectWeek={jumpToWeek}
        onSelectMember={handleSelectMember}
      />
      <div
        className="flex-1 min-w-0 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1"
        style={{ overscrollBehavior: 'contain' }}
      >
      {memberDrawerVisible && selectedTeam && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => closeMemberDrawer()}>
          <div
            className={`absolute inset-0 backdrop-blur-sm transition-opacity duration-200 ${isLight ? 'bg-slate-900/20' : 'bg-black/50'}`}
            style={{ opacity: memberDrawerOpen ? 1 : 0 }}
          />
          <div
            className="relative h-full flex-none surface p-0 overflow-y-auto overflow-x-hidden"
            style={{
              width: 'min(560px, 92vw)',
              minWidth: 'min(560px, 92vw)',
              maxWidth: 'min(560px, 92vw)',
              opacity: memberDrawerOpen ? 1 : 0,
              transform: memberDrawerOpen ? 'translateX(0)' : 'translateX(20px)',
              transition: `transform 240ms ${DRAWER_ENTER_EASING}, opacity ${DRAWER_CLOSE_MS}ms ease`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="sticky top-0 z-10 surface-inset px-4 py-3 flex items-center justify-between"
              style={{ boxShadow: '0 8px 24px -18px rgba(0,0,0,0.55)' }}
            >
              <div>
                <div className="text-[15px] font-semibold">团队成员</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{selectedTeam.name}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => closeMemberDrawer()}><X size={14} /></Button>
            </div>
            <div className="p-4 space-y-3">
              {!reportsView?.canViewAllMembers && (
                <div className="surface-inset rounded-xl px-3 py-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  当前团队未公开成员周报，仅展示你本人信息。
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>成员数：{members.length}</div>
                {canManageMembers && (
                  <Button variant="secondary" size="sm" onClick={() => setMemberFormOpen((v) => !v)}>
                    <UserPlus size={12} /> 添加成员
                  </Button>
                )}
              </div>
              {canManageMembers && memberFormOpen && (
                <div className="surface-inset rounded-xl p-3 space-y-3">
                  <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>新增成员</div>
                  <UserMultiSearchSelect
                    value={memberUserIds}
                    onChange={setMemberUserIds}
                    excludeUserIds={(reportsView?.members ?? []).map((m) => m.userId)}
                    placeholder="搜索并选择成员..."
                  />
                  <select className="surface-inset w-full rounded-xl px-3 py-2.5 text-[13px]" value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                    <option value={ReportTeamRole.Member}>成员</option>
                    <option value={ReportTeamRole.Deputy}>副负责人</option>
                    <option value={ReportTeamRole.Leader}>负责人</option>
                  </select>
                  <input className="surface-inset w-full rounded-xl px-3 py-2.5 text-[13px]" placeholder="岗位（可选）" value={memberJobTitle} onChange={(e) => setMemberJobTitle(e.target.value)} />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setMemberFormOpen(false)}>取消</Button>
                    <Button variant="primary" size="sm" onClick={handleAddMember} disabled={memberSaving || memberUserIds.length === 0}>
                      {memberSaving ? '添加中...' : memberUserIds.length > 1 ? `添加 ${memberUserIds.length} 人` : '确认添加'}
                    </Button>
                  </div>
                </div>
              )}
              {members.map((member) => {
                const cfg = statusConfig[member.reportStatus] || statusConfig[WeeklyReportStatus.NotStarted];
                const StatusIcon = cfg.icon;
                const canRemove = canManageMembers && reportsView?.canViewAllMembers && member.role !== ReportTeamRole.Leader;
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
                      {canRemove && (
                        pendingRemoveUserId === member.userId ? (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setPendingRemoveUserId(null)}
                              disabled={removingUserId === member.userId}
                            >
                              取消
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveMember(member.userId)}
                              disabled={removingUserId === member.userId}
                              className="hover:text-red-300"
                            >
                              {removingUserId === member.userId ? '移除中...' : '确认移除'}
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveMember(member.userId)}
                            className="hover:text-red-300"
                            title="移除成员"
                          >
                            <UserMinus size={12} />
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedMemberUserId && selectedTeamId ? (
        <MemberReportInlineView
          reportId={selectedMember?.reportId}
          teamId={selectedTeamId}
          weekYear={weekYear}
          weekNumber={weekNumber}
          memberName={selectedMember?.userName}
          memberUserId={selectedMemberUserId}
          onBack={handleBackFromMember}
          onSelectSibling={handleSelectSiblingFromDetail}
        />
      ) : (
      <>
      <GlassCard variant="subtle" className="px-5 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="surface-inset rounded-xl p-1 flex items-center gap-1">
            <button
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200"
              style={{
                background: teamScope === 'managed' ? (isLight ? 'rgba(59,130,246,.18)' : 'rgba(59,130,246,.15)') : 'transparent',
                color: teamScope === 'managed' ? (isLight ? 'rgba(29,78,216,1)' : 'rgba(59,130,246,.95)') : 'var(--text-secondary)',
              }}
              onClick={() => setTeamScope('managed')}
            >
              我管理的团队 ({managedTeams.length})
            </button>
            <button
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200"
              style={{
                background: teamScope === 'joined' ? (isLight ? 'rgba(34,197,94,.18)' : 'rgba(34,197,94,.15)') : 'transparent',
                color: teamScope === 'joined' ? (isLight ? 'rgba(21,128,61,1)' : 'rgba(34,197,94,.95)') : 'var(--text-secondary)',
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
            <span className="text-[13px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
              {weekYear} 年第 {weekNumber} 周
            </span>
            {selectedTeamId && (
              <Button variant="secondary" size="sm" onClick={openMemberDrawer}>
                <Users size={13} />
                团队成员
              </Button>
            )}
            {selectedTeamId && canAccessTeamAiSummary && (
              <Button variant="secondary" size="sm" onClick={() => setShareDialogOpen(true)}>
                <Share2 size={13} />
                分享
              </Button>
            )}
          </div>
        </div>
      </GlassCard>

      {selectedTeamId && selectedTeam && (
        <ShareTeamWeekDialog
          open={shareDialogOpen}
          teamId={selectedTeamId}
          teamName={selectedTeam.name}
          weekYear={weekYear}
          weekNumber={weekNumber}
          onClose={() => setShareDialogOpen(false)}
        />
      )}

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

      {hasScopedTeams && selectedTeamId && (viewMode === 'report_list' || viewMode === 'issues') && (
        <GlassCard variant="subtle" className="surface-raised p-0 overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--border-primary)' }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                {viewMode === 'issues' ? <AlertCircle size={16} /> : <FileText size={16} />}
                <span className="text-[16px] font-semibold tracking-tight">
                  {viewMode === 'issues' ? '团队问题视图' : '团队周报列表'}
                </span>
              </div>
              <div className="mt-2 flex items-center flex-wrap gap-2 text-[11px]">
                <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: 'var(--text-secondary)' }}>
                  团队人数 {reportsView?.stats.totalMembers ?? 0}
                </span>
                <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: isLight ? 'rgba(21,128,61,1)' : 'rgba(34,197,94,.95)' }}>
                  已提交 {reportsView?.stats.submittedCount ?? 0}
                </span>
                <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: isLight ? 'rgba(194,65,12,1)' : 'rgba(249,115,22,.95)' }}>
                  待提交 {reportsView?.stats.pendingCount ?? 0}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* 周报 / 问题 视图切换 */}
              <div
                className="inline-flex items-center p-0.5 rounded-lg"
                style={{
                  background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'var(--bg-tertiary)',
                  border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
                }}
              >
                {([
                  { key: 'report_list' as const, label: '周报' },
                  { key: 'issues' as const, label: '问题' },
                ]).map((opt) => {
                  const active = viewMode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      className="whitespace-nowrap px-3 py-1 rounded-md text-[12px] font-medium transition-all duration-200"
                      style={{
                        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                        background: active ? (isLight ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)') : 'transparent',
                        boxShadow: active && isLight ? '0 1px 2px rgba(15, 23, 42, 0.06), 0 0 0 1px rgba(15, 23, 42, 0.08)' : 'none',
                      }}
                      onClick={() => setViewMode(opt.key)}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {canAccessTeamAiSummary && (
                <Button variant="secondary" size="sm" onClick={handleEnterSummary}>
                  <Sparkles size={13} />
                  团队周报AI分析
                </Button>
              )}
            </div>
          </div>
          <div className="px-5 py-4 max-h-[540px] overflow-auto">
            {viewMode === 'issues' ? (
              <TeamIssuesPanel teamId={selectedTeamId} weekYear={weekYear} weekNumber={weekNumber} />
            ) : reportsLoading ? (
              <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : (
              <div className="flex flex-col gap-3">
                {reportsView?.message && (
                  <div className="surface-inset rounded-xl px-3 py-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {reportsView.message}
                  </div>
                )}
                {(reportsView?.items ?? []).length === 0 ? (
                  <div className="surface-inset rounded-xl px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    本周暂无可查看的已提交周报
                  </div>
                ) : (
                  reportsView?.items.map((item) => {
                    const cfg = statusConfig[item.status] || statusConfig[WeeklyReportStatus.Submitted];
                    const StatusIcon = cfg.icon;
                    return (
                      <button
                        key={item.reportId}
                        className="surface-row rounded-xl px-4 py-3 text-left flex items-center justify-between"
                        onClick={() => openReportDetail(item.reportId)}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium truncate">{item.userName || item.userId}</div>
                          <div className="mt-1 flex items-center flex-wrap gap-2 text-[11px]">
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full font-medium" style={{ color: cfg.color, background: cfg.bg }}>
                              <StatusIcon size={10} />
                              {cfg.label}
                            </span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              提交于 {item.submittedAt ? new Date(item.submittedAt).toLocaleString() : '-'}
                            </span>
                          </div>
                        </div>
                        <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); openReportDetail(item.reportId); }}>
                          <ExternalLink size={13} />
                          查看
                        </Button>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </GlassCard>
      )}

      {hasScopedTeams && selectedTeamId && viewMode === 'ai_summary' && canAccessTeamAiSummary && (
        <GlassCard variant="subtle" className="surface-raised p-0 overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <Sparkles size={16} />
                <span className="text-[16px] font-semibold tracking-tight">团队周报AI分析</span>
              </div>
              <div className="mt-2 flex items-center flex-wrap gap-2 text-[11px]">
                <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {weekYear} 年第 {weekNumber} 周
                </span>
                <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {summaryView?.visibilityScope === 'self_only' ? '个人汇总视图' : '团队汇总视图'}
                </span>
                {summaryView?.summary && (
                  <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: 'var(--text-muted)' }}>
                    更新于 {new Date(summaryView.summary.updatedAt).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setViewMode('report_list')}>
                返回周报列表
              </Button>
              {summaryView?.canGenerateSummary && (
                <Button variant="primary" size="sm" onClick={handleGenerateSummary} disabled={generatingSummary}>
                  {generatingSummary ? <MapSpinner size={13} /> : <Sparkles size={13} className="mr-1" />}
                  {summaryView?.summary ? '重新生成' : '生成汇总'}
                </Button>
              )}
            </div>
          </div>
          <div className="px-5 py-4 max-h-[540px] overflow-auto">
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
      </>
      )}
      </div>
    </div>
  );
}
