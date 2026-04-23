import { useMemo, useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, CalendarDays, CornerUpLeft, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import type { TeamDashboardMember } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportTeamRole } from '@/services/contracts/reportAgent';

const ISO_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

function getISOWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow + 1);
  const result = new Date(week1Monday);
  result.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return result;
}

export interface WeekEntry {
  weekYear: number;
  weekNumber: number;
  periodStart: Date;
  periodEnd: Date;
  isCurrent: boolean;
}

function listISOWeeksBackFrom(anchor: { weekYear: number; weekNumber: number }, count: number, nowIso: { weekYear: number; weekNumber: number }): WeekEntry[] {
  const out: WeekEntry[] = [];
  const anchorMonday = getISOWeekMonday(anchor.weekYear, anchor.weekNumber);
  for (let i = 0; i < count; i++) {
    const monday = new Date(anchorMonday.getTime() - i * ISO_WEEK_MS);
    const { weekYear, weekNumber } = getISOWeek(monday);
    const periodEnd = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
    out.push({
      weekYear,
      weekNumber,
      periodStart: monday,
      periodEnd,
      isCurrent: weekYear === nowIso.weekYear && weekNumber === nowIso.weekNumber,
    });
  }
  return out;
}

function formatDateShort(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

function parseWeekInput(input: string, currentYear: number): { weekYear: number; weekNumber: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // YYYY-Www / YYYY-ww / YYYY Www (space)
  const isoWeekMatch = trimmed.match(/^(\d{4})[-\s/]?[Ww]?(\d{1,2})$/);
  if (isoWeekMatch) {
    const y = Number.parseInt(isoWeekMatch[1], 10);
    const w = Number.parseInt(isoWeekMatch[2], 10);
    if (y >= 2000 && y <= 2100 && w >= 1 && w <= 53) return { weekYear: y, weekNumber: w };
  }

  // YYYY/MM/DD or YYYY-MM-DD
  const dateMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (dateMatch) {
    const y = Number.parseInt(dateMatch[1], 10);
    const m = Number.parseInt(dateMatch[2], 10);
    const d = Number.parseInt(dateMatch[3], 10);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
      return getISOWeek(dt);
    }
  }

  // 纯周号
  if (/^\d{1,2}$/.test(trimmed)) {
    const w = Number.parseInt(trimmed, 10);
    if (w >= 1 && w <= 53) return { weekYear: currentYear, weekNumber: w };
  }

  return null;
}

const memberStatusConfig: Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156,163,175,.82)', bg: 'rgba(156,163,175,.08)', icon: Clock },
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

export interface WeekNavRailProps {
  selectedYear: number;
  selectedWeek: number;
  selectedMemberUserId: string | null;
  currentWeekMembers: TeamDashboardMember[];
  currentWeekLoading: boolean;
  hasTeam: boolean;
  onSelectWeek: (year: number, week: number) => void;
  onSelectMember: (member: TeamDashboardMember) => void;
}

const INITIAL_VISIBLE = 8;
const LOAD_MORE_STEP = 8;

export function WeekNavRail({
  selectedYear,
  selectedWeek,
  selectedMemberUserId,
  currentWeekMembers,
  currentWeekLoading,
  hasTeam,
  onSelectWeek,
  onSelectMember,
}: WeekNavRailProps) {
  const nowIso = useMemo(() => getISOWeek(new Date()), []);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [filterInput, setFilterInput] = useState('');
  const [filterError, setFilterError] = useState(false);

  // 锚点：以 max(当前选中周, 当前 ISO 周) 为起点向前展开，保证用户跳到未来周时列表仍能包含它
  const anchor = useMemo(() => {
    const selectedMonday = getISOWeekMonday(selectedYear, selectedWeek).getTime();
    const nowMonday = getISOWeekMonday(nowIso.weekYear, nowIso.weekNumber).getTime();
    return selectedMonday > nowMonday ? { weekYear: selectedYear, weekNumber: selectedWeek } : nowIso;
  }, [selectedYear, selectedWeek, nowIso]);

  const weeks = useMemo(
    () => listISOWeeksBackFrom(anchor, visibleCount, nowIso),
    [anchor, visibleCount, nowIso]
  );

  // 保证"已选中周"始终在列表里（往前翻看历史时会自动出现）
  useEffect(() => {
    const inList = weeks.some((w) => w.weekYear === selectedYear && w.weekNumber === selectedWeek);
    if (!inList) {
      const anchorMonday = getISOWeekMonday(anchor.weekYear, anchor.weekNumber).getTime();
      const selMonday = getISOWeekMonday(selectedYear, selectedWeek).getTime();
      const diffWeeks = Math.max(0, Math.round((anchorMonday - selMonday) / ISO_WEEK_MS));
      setVisibleCount((prev) => Math.max(prev, diffWeeks + 1));
    }
  }, [weeks, selectedYear, selectedWeek, anchor]);

  const sortedMembers = useMemo(() => {
    return currentWeekMembers.slice().sort((a, b) => {
      const byStatus = getMemberPriority(a.reportStatus) - getMemberPriority(b.reportStatus);
      if (byStatus !== 0) return byStatus;
      return (a.userName || '').localeCompare(b.userName || '');
    });
  }, [currentWeekMembers]);

  const submittedStatuses = new Set<string>([
    WeeklyReportStatus.Submitted,
    WeeklyReportStatus.Reviewed,
    WeeklyReportStatus.Viewed,
  ]);

  const handleJump = () => {
    const parsed = parseWeekInput(filterInput, nowIso.weekYear);
    if (!parsed) {
      setFilterError(true);
      toast.warning('请输入 YYYY-Www 或 YYYY/MM/DD 或周号');
      return;
    }
    setFilterError(false);
    setFilterInput('');
    onSelectWeek(parsed.weekYear, parsed.weekNumber);
  };

  const handleBackToCurrent = () => {
    onSelectWeek(nowIso.weekYear, nowIso.weekNumber);
    setFilterInput('');
    setFilterError(false);
  };

  return (
    <aside
      className="flex-none flex flex-col min-h-0 surface rounded-2xl overflow-hidden"
      style={{ width: 260, border: '1px solid var(--border-primary)' }}
    >
      {/* 顶部：快速筛选 */}
      <div
        className="shrink-0 px-3 py-3 flex flex-col gap-2"
        style={{ borderBottom: '1px solid var(--border-primary)' }}
      >
        <div className="flex items-center gap-1.5">
          <CalendarDays size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>周导航</span>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={filterInput}
            onChange={(e) => {
              setFilterInput(e.target.value);
              if (filterError) setFilterError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleJump();
            }}
            placeholder="2026-W15 / 04/07"
            className="flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-[12px] surface-inset"
            style={{
              border: filterError ? '1px solid rgba(239,68,68,.6)' : '1px solid var(--border-primary)',
            }}
          />
          <Button variant="secondary" size="sm" onClick={handleJump}>跳转</Button>
        </div>
        <button
          type="button"
          onClick={handleBackToCurrent}
          className="flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] transition-all surface-inset hover:opacity-85"
          style={{ color: 'var(--text-secondary)' }}
        >
          <CornerUpLeft size={11} />
          跳回本周（{nowIso.weekYear} W{nowIso.weekNumber}）
        </button>
      </div>

      {/* 周列表 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
        style={{ overscrollBehavior: 'contain' }}
      >
        {weeks.map((week) => {
          const isSelected = week.weekYear === selectedYear && week.weekNumber === selectedWeek;
          return (
            <div key={`${week.weekYear}-${week.weekNumber}`} className="mb-1">
              <button
                type="button"
                onClick={() => onSelectWeek(week.weekYear, week.weekNumber)}
                className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg transition-all text-left hover:opacity-95"
                style={{
                  background: isSelected ? 'rgba(59,130,246,.12)' : 'transparent',
                  border: isSelected ? '1px solid rgba(59,130,246,.35)' : '1px solid transparent',
                }}
              >
                {isSelected ? (
                  <ChevronDown size={12} style={{ color: 'rgba(59,130,246,.95)' }} />
                ) : (
                  <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                )}
                <div className="flex-1 min-w-0">
                  <div
                    className="text-[12px] font-medium"
                    style={{ color: isSelected ? 'rgba(59,130,246,.95)' : 'var(--text-primary)' }}
                  >
                    {week.weekYear} W{week.weekNumber}
                    {week.isCurrent && (
                      <span
                        className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full"
                        style={{ color: 'rgba(34,197,94,.95)', background: 'rgba(34,197,94,.12)' }}
                      >
                        本周
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {formatDateShort(week.periodStart)} - {formatDateShort(week.periodEnd)}
                  </div>
                </div>
              </button>

              {isSelected && (
                <div className="mt-1 ml-3 pl-2" style={{ borderLeft: '1px solid var(--border-primary)' }}>
                  {!hasTeam ? (
                    <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>请先选择团队</div>
                  ) : currentWeekLoading ? (
                    <div className="flex items-center gap-1.5 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <MapSpinner size={12} />
                      加载成员...
                    </div>
                  ) : sortedMembers.length === 0 ? (
                    <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>本周暂无成员数据</div>
                  ) : (
                    sortedMembers.map((member) => {
                      const cfg = memberStatusConfig[member.reportStatus] || memberStatusConfig[WeeklyReportStatus.NotStarted];
                      const StatusIcon = cfg.icon;
                      const isMemberSelected = selectedMemberUserId === member.userId;
                      const hasSubmitted = submittedStatuses.has(member.reportStatus);
                      return (
                        <button
                          key={member.userId}
                          type="button"
                          onClick={() => onSelectMember(member)}
                          className="w-full flex items-start gap-1.5 px-2 py-1.5 rounded-lg text-left transition-all hover:opacity-95"
                          style={{
                            background: isMemberSelected ? 'rgba(168,85,247,.14)' : 'transparent',
                            border: isMemberSelected ? '1px solid rgba(168,85,247,.35)' : '1px solid transparent',
                            opacity: hasSubmitted ? 1 : 0.75,
                          }}
                        >
                          <StatusIcon size={10} style={{ color: cfg.color, marginTop: 3 }} />
                          <div className="flex-1 min-w-0">
                            <div
                              className="text-[11.5px] font-medium truncate"
                              style={{ color: isMemberSelected ? 'rgba(168,85,247,.95)' : 'var(--text-primary)' }}
                            >
                              {member.userName || member.userId}
                            </div>
                            <div className="text-[10px] mt-0.5 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                              <span>{getMemberRoleLabel(member.role)}</span>
                              <span style={{ color: cfg.color }}>· {cfg.label}</span>
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => setVisibleCount((c) => c + LOAD_MORE_STEP)}
          className="w-full mt-2 py-2 rounded-lg text-[11px] surface-inset hover:opacity-85 transition-opacity"
          style={{ color: 'var(--text-secondary)' }}
        >
          加载更早 {LOAD_MORE_STEP} 周
        </button>
      </div>
    </aside>
  );
}
