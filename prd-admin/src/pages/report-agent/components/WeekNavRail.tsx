import { useMemo, useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, CalendarDays, CornerUpLeft, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import type { TeamDashboardMember } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportTeamRole } from '@/services/contracts/reportAgent';

const ISO_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INITIAL_VISIBLE = 8;
const LOAD_MORE_STEP = 8;
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七'];

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

// ISO 周年的总周数：12月28日一定在该年最后一个 ISO 周内
function getISOWeeksInYear(year: number): number {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  return getISOWeek(dec28).weekNumber;
}

function formatDateShort(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

// 中文周名：取周一所在月份 + Math.ceil(day/7)，例：周一 4/20 → "4月第三周"
function formatChineseWeekName(monday: Date): string {
  const month = monday.getUTCMonth() + 1;
  const weekOfMonth = Math.ceil(monday.getUTCDate() / 7);
  const cn = CN_NUM[weekOfMonth - 1] ?? String(weekOfMonth);
  return `${month}月第${cn}周`;
}

export interface WeekEntry {
  weekYear: number;
  weekNumber: number;
  periodStart: Date;
  periodEnd: Date;
  isCurrent: boolean;
  chineseName: string;
}

function listISOWeeksBackFrom(
  anchor: { weekYear: number; weekNumber: number },
  count: number,
  nowIso: { weekYear: number; weekNumber: number }
): WeekEntry[] {
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
      chineseName: formatChineseWeekName(monday),
    });
  }
  return out;
}

interface YearGroup {
  year: number;
  weeks: WeekEntry[];
}

function groupWeeksByYear(weeks: WeekEntry[]): YearGroup[] {
  const map = new Map<number, WeekEntry[]>();
  for (const w of weeks) {
    const arr = map.get(w.weekYear);
    if (arr) arr.push(w);
    else map.set(w.weekYear, [w]);
  }
  // 年降序；年内周号降序（最新在前）
  return Array.from(map.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, ws]) => ({
      year,
      weeks: ws.slice().sort((a, b) => b.weekNumber - a.weekNumber),
    }));
}

const memberStatusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  [WeeklyReportStatus.Submitted]: { label: '待审阅', color: 'rgba(59,130,246,.9)', icon: AlertCircle },
  [WeeklyReportStatus.Reviewed]: { label: '已审阅', color: 'rgba(34,197,94,.9)', icon: CheckCircle2 },
  [WeeklyReportStatus.Viewed]: { label: '已查看', color: 'rgba(14,165,233,.9)', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]: { label: '已打回', color: 'rgba(239,68,68,.9)', icon: AlertCircle },
  [WeeklyReportStatus.Overdue]: { label: '逾期', color: 'rgba(239,68,68,.9)', icon: AlertCircle },
  [WeeklyReportStatus.Draft]: { label: '草稿', color: 'rgba(156,163,175,.92)', icon: Clock },
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156,163,175,.82)', icon: Clock },
};

const SUBMITTED_STATUSES = new Set<string>([
  WeeklyReportStatus.Submitted,
  WeeklyReportStatus.Reviewed,
  WeeklyReportStatus.Viewed,
]);

function getMemberRoleLabel(role?: string | null): string {
  if (role === ReportTeamRole.Leader) return '负责人';
  if (role === ReportTeamRole.Deputy) return '副负责人';
  return '成员';
}

export interface WeekNavRailProps {
  selectedYear: number;
  selectedWeek: number;
  selectedMemberUserId: string | null;
  currentWeekMembers: TeamDashboardMember[];
  currentWeekLoading: boolean;
  hasTeam: boolean;
  teamName?: string;
  onSelectWeek: (year: number, week: number) => void;
  onSelectMember: (member: TeamDashboardMember) => void;
}

export function WeekNavRail({
  selectedYear,
  selectedWeek,
  selectedMemberUserId,
  currentWeekMembers,
  currentWeekLoading,
  hasTeam,
  teamName,
  onSelectWeek,
  onSelectMember,
}: WeekNavRailProps) {
  const nowIso = useMemo(() => getISOWeek(new Date()), []);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  // 折叠状态：Set 缺席 = 展开，有则折叠
  const [collapsedYears, setCollapsedYears] = useState<Set<number>>(
    () => new Set() // 初始化时在 effect 里填充为"非当前年"
  );
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<string>>(() => new Set());
  const initializedRef = useRef(false);

  // 跳转选择器状态
  const [jumpYear, setJumpYear] = useState<number>(selectedYear);
  const [jumpWeek, setJumpWeek] = useState<number>(selectedWeek);

  // 锚点：max(当前选中周, 当前 ISO 周)，保证跳到未来周时列表也能覆盖
  const anchor = useMemo(() => {
    const selectedMonday = getISOWeekMonday(selectedYear, selectedWeek).getTime();
    const nowMonday = getISOWeekMonday(nowIso.weekYear, nowIso.weekNumber).getTime();
    return selectedMonday > nowMonday ? { weekYear: selectedYear, weekNumber: selectedWeek } : nowIso;
  }, [selectedYear, selectedWeek, nowIso]);

  const weeks = useMemo(
    () => listISOWeeksBackFrom(anchor, visibleCount, nowIso),
    [anchor, visibleCount, nowIso]
  );

  const yearGroups = useMemo(() => groupWeeksByYear(weeks), [weeks]);

  // 初次 mount：把"非当前年"的年折叠，把"非选中周"的周折叠
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const allYears = new Set(weeks.map((w) => w.weekYear));
    const collapsedY = new Set<number>();
    for (const y of allYears) {
      if (y !== nowIso.weekYear) collapsedY.add(y);
    }
    setCollapsedYears(collapsedY);
    const collapsedW = new Set<string>();
    for (const w of weeks) {
      const key = `${w.weekYear}-${w.weekNumber}`;
      if (!(w.weekYear === selectedYear && w.weekNumber === selectedWeek)) {
        collapsedW.add(key);
      }
    }
    setCollapsedWeeks(collapsedW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保证已选中周在可见范围内
  useEffect(() => {
    const inList = weeks.some((w) => w.weekYear === selectedYear && w.weekNumber === selectedWeek);
    if (!inList) {
      const anchorMonday = getISOWeekMonday(anchor.weekYear, anchor.weekNumber).getTime();
      const selMonday = getISOWeekMonday(selectedYear, selectedWeek).getTime();
      const diffWeeks = Math.max(0, Math.round((anchorMonday - selMonday) / ISO_WEEK_MS));
      setVisibleCount((prev) => Math.max(prev, diffWeeks + 1));
    }
  }, [weeks, selectedYear, selectedWeek, anchor]);

  // 当选中周变化时：确保它所在年+周展开（跳转后自动露出）
  useEffect(() => {
    setCollapsedYears((prev) => {
      if (!prev.has(selectedYear)) return prev;
      const next = new Set(prev);
      next.delete(selectedYear);
      return next;
    });
    const weekKey = `${selectedYear}-${selectedWeek}`;
    setCollapsedWeeks((prev) => {
      if (!prev.has(weekKey)) return prev;
      const next = new Set(prev);
      next.delete(weekKey);
      return next;
    });
  }, [selectedYear, selectedWeek]);

  // 跳转选择器：跟随选中周变化
  useEffect(() => {
    setJumpYear(selectedYear);
    setJumpWeek(selectedWeek);
  }, [selectedYear, selectedWeek]);

  const currentWeekSubmittedMembers = useMemo(() => {
    return currentWeekMembers
      .filter((m) => SUBMITTED_STATUSES.has(m.reportStatus))
      .slice()
      .sort((a, b) => {
        // 按 submittedAt 倒序；无时间的 fallback 按 userName
        const ta = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
        const tb = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
        if (ta !== tb) return tb - ta;
        return (a.userName || '').localeCompare(b.userName || '');
      });
  }, [currentWeekMembers]);

  // 年下拉候选：当前可见范围内的所有年 + 当前 ISO 年 + 当前 ISO 年+1
  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    for (const w of weeks) years.add(w.weekYear);
    years.add(nowIso.weekYear);
    years.add(nowIso.weekYear + 1);
    return Array.from(years).sort((a, b) => b - a);
  }, [weeks, nowIso]);

  // 周下拉候选：取决于 jumpYear（该年全部周）
  const weekOptions = useMemo(() => {
    const maxWeek = getISOWeeksInYear(jumpYear);
    const list: { weekNumber: number; label: string }[] = [];
    for (let w = maxWeek; w >= 1; w--) {
      const monday = getISOWeekMonday(jumpYear, w);
      list.push({
        weekNumber: w,
        label: `W${w} · ${formatChineseWeekName(monday)}`,
      });
    }
    return list;
  }, [jumpYear]);

  // 当年变化导致 jumpWeek 超出范围时夹紧
  useEffect(() => {
    const maxWeek = getISOWeeksInYear(jumpYear);
    if (jumpWeek > maxWeek) setJumpWeek(maxWeek);
    if (jumpWeek < 1) setJumpWeek(1);
  }, [jumpYear, jumpWeek]);

  const handleJump = () => {
    onSelectWeek(jumpYear, jumpWeek);
  };

  const handleBackToCurrent = () => {
    onSelectWeek(nowIso.weekYear, nowIso.weekNumber);
  };

  const toggleYearCollapsed = (year: number) => {
    setCollapsedYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  };

  const toggleWeekCollapsed = (year: number, week: number) => {
    const key = `${year}-${week}`;
    setCollapsedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleWeekHeaderClick = (year: number, week: number) => {
    // 点周头部 = 切换展开 + 设为当前周（同步右侧）
    toggleWeekCollapsed(year, week);
    if (year !== selectedYear || week !== selectedWeek) {
      onSelectWeek(year, week);
    }
  };

  return (
    <aside
      className="flex-none flex flex-col min-h-0 surface rounded-2xl overflow-hidden"
      style={{ width: 280, border: '1px solid var(--border-primary)' }}
    >
      {/* 顶部：年/周选择器 */}
      <div
        className="shrink-0 px-3 py-3 flex flex-col gap-2"
        style={{ borderBottom: '1px solid var(--border-primary)' }}
      >
        <div className="flex items-center gap-1.5">
          <CalendarDays size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>周导航</span>
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={jumpYear}
            onChange={(e) => setJumpYear(Number.parseInt(e.target.value, 10))}
            className="shrink-0 rounded-lg px-2 py-1.5 text-[12px] surface-inset"
            style={{ border: '1px solid var(--border-primary)', width: 72 }}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <select
            value={jumpWeek}
            onChange={(e) => setJumpWeek(Number.parseInt(e.target.value, 10))}
            className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-[12px] surface-inset"
            style={{ border: '1px solid var(--border-primary)' }}
          >
            {weekOptions.map((opt) => (
              <option key={opt.weekNumber} value={opt.weekNumber}>{opt.label}</option>
            ))}
          </select>
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

      {/* 年/周两级列表 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
        style={{ overscrollBehavior: 'contain' }}
      >
        {yearGroups.map((group) => {
          const yearCollapsed = collapsedYears.has(group.year);
          return (
            <div key={group.year} className="mb-2">
              {/* 年标题 */}
              <button
                type="button"
                onClick={() => toggleYearCollapsed(group.year)}
                className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg text-left hover:opacity-90 transition-all"
                style={{ background: 'transparent' }}
              >
                {yearCollapsed ? (
                  <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                ) : (
                  <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                )}
                <span
                  className="text-[13px] font-semibold"
                  style={{ color: 'var(--text-primary)' }}
                >
                  【{group.year}】 – {teamName || '团队工作周报'}
                </span>
              </button>

              {/* 周列表 */}
              {!yearCollapsed && (
                <div className="mt-0.5">
                  {group.weeks.map((week) => {
                    const weekKey = `${week.weekYear}-${week.weekNumber}`;
                    const isSelected = week.weekYear === selectedYear && week.weekNumber === selectedWeek;
                    const isExpanded = !collapsedWeeks.has(weekKey);
                    return (
                      <div key={weekKey} className="mb-1 ml-4">
                        {/* 周头部（单行：箭头独立，点头部=展开+选中）*/}
                        <div
                          className="w-full flex items-stretch rounded-lg transition-all"
                          style={{
                            background: isSelected ? 'rgba(59,130,246,.12)' : 'transparent',
                            border: isSelected ? '1px solid rgba(59,130,246,.35)' : '1px solid transparent',
                          }}
                        >
                          {/* 展开箭头（单独按钮，只切 UI 折叠） */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleWeekCollapsed(week.weekYear, week.weekNumber);
                            }}
                            className="shrink-0 px-1.5 py-2 hover:opacity-80"
                            style={{ color: 'var(--text-muted)' }}
                            title={isExpanded ? '收起' : '展开'}
                          >
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                          {/* 周头部主体（切换右侧 + 展开） */}
                          <button
                            type="button"
                            onClick={() => handleWeekHeaderClick(week.weekYear, week.weekNumber)}
                            className="flex-1 min-w-0 py-2 pr-2 text-left hover:opacity-90"
                          >
                            <div
                              className="text-[12px] font-medium flex items-center gap-1.5"
                              style={{ color: isSelected ? 'rgba(59,130,246,.95)' : 'var(--text-primary)' }}
                            >
                              <span className="truncate">{week.chineseName}</span>
                              {week.isCurrent && (
                                <span
                                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full"
                                  style={{ color: 'rgba(34,197,94,.95)', background: 'rgba(34,197,94,.12)' }}
                                >
                                  本周
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {formatDateShort(week.periodStart)} - {formatDateShort(week.periodEnd)}
                            </div>
                          </button>
                        </div>

                        {/* 已提交成员列表（仅当前选中周会拉数据，其他周展开只显示"点击查看"提示） */}
                        {isExpanded && (
                          <div className="mt-1 ml-6 pl-2" style={{ borderLeft: '1px solid var(--border-primary)' }}>
                            {!isSelected ? (
                              <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>
                                点击本周名称加载提交记录
                              </div>
                            ) : !hasTeam ? (
                              <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>请先选择团队</div>
                            ) : currentWeekLoading ? (
                              <div className="flex items-center gap-1.5 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                <MapSpinner size={12} />
                                加载中...
                              </div>
                            ) : currentWeekSubmittedMembers.length === 0 ? (
                              <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>
                                本周暂无已提交周报
                              </div>
                            ) : (
                              currentWeekSubmittedMembers.map((member) => {
                                const cfg = memberStatusConfig[member.reportStatus] || memberStatusConfig[WeeklyReportStatus.Submitted];
                                const StatusIcon = cfg.icon;
                                const isMemberSelected = selectedMemberUserId === member.userId;
                                return (
                                  <button
                                    key={member.userId}
                                    type="button"
                                    onClick={() => onSelectMember(member)}
                                    className="w-full flex items-start gap-1.5 px-2 py-1.5 rounded-lg text-left transition-all hover:opacity-95"
                                    style={{
                                      background: isMemberSelected ? 'rgba(168,85,247,.14)' : 'transparent',
                                      border: isMemberSelected ? '1px solid rgba(168,85,247,.35)' : '1px solid transparent',
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
