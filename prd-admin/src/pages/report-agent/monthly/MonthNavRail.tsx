import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CalendarDays, CheckCircle2, AlertCircle } from 'lucide-react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { MonthlyTeamOverviewItem } from '@/services/contracts/reportAgentMonthly';
import { useDataTheme } from '../hooks/useDataTheme';
import { useStatusChipConfig } from '../hooks/useStatusChipConfig';
import { currentYearMonth } from './monthlyMeta';

const INITIAL_VISIBLE = 6;
const LOAD_MORE_STEP = 6;

const MEMBER_STATUS_LABELS: Record<string, { label: string; icon: typeof CheckCircle2 }> = {
  submitted: { label: '已提交', icon: AlertCircle },
  viewed: { label: '负责人已查看', icon: CheckCircle2 },
};

function roleLabel(role?: string | null) {
  if (role === 'leader') return '负责人';
  if (role === 'deputy') return '副负责人';
  return '成员';
}

interface MonthEntry {
  year: number;
  month: number;
  isCurrent: boolean;
}

/** 从锚点月往前列 count 个月（倒序） */
function listMonthsBackFrom(anchor: { year: number; month: number }, count: number, now: { year: number; month: number }): MonthEntry[] {
  const out: MonthEntry[] = [];
  const base = anchor.year * 12 + (anchor.month - 1);
  for (let i = 0; i < count; i++) {
    const idx = base - i;
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    out.push({ year, month, isCurrent: year === now.year && month === now.month });
  }
  return out;
}

export interface MonthNavRailProps {
  selectedYear: number;
  selectedMonth: number;
  selectedMemberUserId: string | null;
  /** 选中月的成员（只展示已提交的） */
  members: MonthlyTeamOverviewItem[];
  loading: boolean;
  teamName?: string;
  onSelectMonth: (year: number, month: number) => void;
  onSelectMember: (member: MonthlyTeamOverviewItem) => void;
}

/**
 * 团队月报的月导航：与周报团队页的 WeekNavRail 同一套交互——
 * 年 / 月两级树，选中月展开后列出已提交成员，点成员在右侧直接看他的月报。
 */
export function MonthNavRail({
  selectedYear,
  selectedMonth,
  selectedMemberUserId,
  members,
  loading,
  teamName,
  onSelectMonth,
  onSelectMember,
}: MonthNavRailProps) {
  const isLight = useDataTheme() === 'light';
  const statusColors = useStatusChipConfig(isLight);
  const now = useMemo(() => currentYearMonth(), []);
  const isMobile = useIsMobile();
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [expandedYears, setExpandedYears] = useState<Set<number>>(() => new Set([now.year]));
  const [collapsedSelected, setCollapsedSelected] = useState(false);

  const months = useMemo(() => listMonthsBackFrom(now, visibleCount, now), [now, visibleCount]);

  // 保证选中月在可见范围内
  useEffect(() => {
    const diff = now.year * 12 + now.month - (selectedYear * 12 + selectedMonth);
    if (diff + 1 > visibleCount) setVisibleCount(diff + 1);
    setExpandedYears((prev) => (prev.has(selectedYear) ? prev : new Set(prev).add(selectedYear)));
    setCollapsedSelected(false);
  }, [selectedYear, selectedMonth, now, visibleCount]);

  const yearGroups = useMemo(() => {
    const map = new Map<number, MonthEntry[]>();
    for (const m of months) {
      const arr = map.get(m.year);
      if (arr) arr.push(m);
      else map.set(m.year, [m]);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [months]);

  const submitted = useMemo(
    () => members.filter((m) => !!m.reportId),
    [members]
  );

  const yearOptions = useMemo(() => {
    const ys = new Set<number>(months.map((m) => m.year));
    ys.add(now.year);
    return Array.from(ys).sort((a, b) => b - a);
  }, [months, now]);

  const monthOptions = useMemo(() => {
    const max = selectedYear === now.year ? now.month : 12;
    return Array.from({ length: max }, (_, i) => max - i);
  }, [selectedYear, now]);

  const handleMonthClick = (year: number, month: number) => {
    const isSelected = year === selectedYear && month === selectedMonth;
    if (isSelected) setCollapsedSelected((v) => !v);
    else onSelectMonth(year, month);
  };

  return (
    <aside
      className="flex-none flex flex-col min-h-0 surface rounded-2xl overflow-hidden w-full lg:w-[280px]"
      style={{ border: '1px solid var(--border-primary)' }}
      data-testid="month-nav-rail"
    >
      <div
        className="shrink-0 px-3 py-3 flex flex-col gap-2"
        style={{ borderBottom: isMobile && !mobileTreeOpen ? 'none' : '1px solid var(--border-primary)' }}
      >
        <div className="flex items-center gap-1.5">
          <CalendarDays size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>月导航</span>
          {isMobile && (
            <button
              type="button"
              onClick={() => setMobileTreeOpen((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-1 surface-inset"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}
            >
              月列表
              {mobileTreeOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={selectedYear}
            onChange={(e) => {
              const y = Number.parseInt(e.target.value, 10);
              onSelectMonth(y, y === now.year ? Math.min(selectedMonth, now.month) : selectedMonth);
            }}
            className="shrink-0 rounded-lg px-2 py-1.5 text-[12px] surface-inset"
            style={{ border: '1px solid var(--border-primary)', width: 84 }}
            aria-label="选择年份"
          >
            {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select
            value={selectedMonth}
            onChange={(e) => onSelectMonth(selectedYear, Number.parseInt(e.target.value, 10))}
            className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-[12px] surface-inset"
            style={{ border: '1px solid var(--border-primary)' }}
            aria-label="选择月份"
          >
            {monthOptions.map((m) => <option key={m} value={m}>{m} 月</option>)}
          </select>
        </div>
      </div>

      <div
        className={`${isMobile && !mobileTreeOpen ? 'hidden' : ''} flex-1 min-h-0 overflow-y-auto px-2 py-2 max-h-[320px] lg:max-h-none`}
        style={{ overscrollBehavior: 'contain' }}
      >
        {yearGroups.map(([year, entries]) => {
          const yearOpen = expandedYears.has(year);
          return (
            <div key={year} className="mb-2">
              <button
                type="button"
                onClick={() => setExpandedYears((prev) => {
                  const next = new Set(prev);
                  if (next.has(year)) next.delete(year);
                  else next.add(year);
                  return next;
                })}
                className="w-full flex items-center gap-1.5 px-2 py-2 rounded-lg text-left hover-bg-soft"
              >
                {yearOpen ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  【{year}】 – {teamName || '团队月报'}
                </span>
              </button>

              {yearOpen && (
                <div className="mt-0.5">
                  {entries.map((m) => {
                    const isSelected = m.year === selectedYear && m.month === selectedMonth;
                    const isExpanded = isSelected && !collapsedSelected;
                    return (
                      <div key={`${m.year}-${m.month}`} className="mb-1 ml-4">
                        <button
                          type="button"
                          onClick={() => handleMonthClick(m.year, m.month)}
                          className="w-full flex items-center gap-1.5 py-2 px-2 rounded-lg text-left hover-bg-soft"
                          style={{
                            background: isSelected ? 'var(--status-going-soft)' : 'transparent',
                            border: `1px solid ${isSelected ? 'var(--status-going-border)' : 'transparent'}`,
                          }}
                        >
                          {isExpanded
                            ? <ChevronDown size={12} style={{ color: 'var(--status-going)', flexShrink: 0 }} />
                            : <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                          <span
                            className="text-[12px] font-medium flex-1 min-w-0 truncate"
                            style={{ color: isSelected ? 'var(--status-going)' : 'var(--text-primary)' }}
                          >
                            {m.month} 月月报
                          </span>
                          {m.isCurrent && (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: 'var(--status-done)', background: 'var(--status-done-soft)' }}>
                              本月
                            </span>
                          )}
                        </button>

                        {isExpanded && (
                          <div className="mt-1 ml-6 pl-2" style={{ borderLeft: '1px solid var(--border-primary)' }}>
                            {loading ? (
                              <div className="flex items-center gap-1.5 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                <MapSpinner size={12} /> 加载中...
                              </div>
                            ) : submitted.length === 0 ? (
                              <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>本月暂无已提交月报</div>
                            ) : (
                              submitted.map((member) => {
                                const colors = statusColors[member.status] || statusColors.submitted;
                                const meta = MEMBER_STATUS_LABELS[member.status] || MEMBER_STATUS_LABELS.submitted;
                                const StatusIcon = meta.icon;
                                const active = selectedMemberUserId === member.userId;
                                return (
                                  <button
                                    key={member.userId}
                                    type="button"
                                    onClick={() => onSelectMember(member)}
                                    className="w-full flex items-start gap-1.5 px-2 py-1.5 rounded-lg text-left hover-bg-soft"
                                    style={{
                                      background: active ? 'var(--status-going-soft)' : 'transparent',
                                      border: `1px solid ${active ? 'var(--status-going-border)' : 'transparent'}`,
                                    }}
                                    data-testid="month-nav-member"
                                  >
                                    <StatusIcon size={10} style={{ color: colors.color, marginTop: 3 }} />
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[11.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                        {member.userName}
                                      </div>
                                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                        {roleLabel(member.role)} <span style={{ color: colors.color }}>· {meta.label}</span>
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
          className="w-full mt-2 py-2 rounded-lg text-[11px] surface-inset hover-bg-soft"
          style={{ color: 'var(--text-secondary)' }}
        >
          加载更早 {LOAD_MORE_STEP} 个月
        </button>
      </div>
    </aside>
  );
}
