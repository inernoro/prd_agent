import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Plus, Calendar, FileText,
  CheckCircle2, Clock, AlertCircle, Send, Pencil,
  ArrowRight, LayoutGrid, CalendarDays, ChevronRight,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import type { WeeklyReport } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { ReportEditor } from './ReportEditor';
import { useDataTheme } from '../hooks/useDataTheme';
import { useStatusChipConfig } from '../hooks/useStatusChipConfig';
import { formatWeekDateRange, formatWeekLabelWithRange } from '../utils/weekRange';

// ────── helpers ──────

interface WeekRef {
  weekYear: number;
  weekNumber: number;
}

function getISOWeek(date: Date): WeekRef {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

function getPreviousWeek(week: WeekRef): WeekRef {
  if (week.weekNumber <= 1) {
    return { weekYear: week.weekYear - 1, weekNumber: 52 };
  }
  return { weekYear: week.weekYear, weekNumber: week.weekNumber - 1 };
}

function getWeekKey(week: WeekRef): string {
  return `${week.weekYear}-${String(week.weekNumber).padStart(2, '0')}`;
}

function parseWeekKey(weekKey: string): WeekRef {
  const [year, week] = weekKey.split('-').map(Number);
  return {
    weekYear: Number.isFinite(year) ? year : new Date().getFullYear(),
    weekNumber: Number.isFinite(week) ? week : 1,
  };
}

// formatWeekLabel/formatWeekDateRange 共享自 utils/weekRange.ts（用户反馈："第 X 周"看不出是哪几天）
const formatWeekLabel = formatWeekLabelWithRange;

// 「我的周报」列表视图模式 sessionStorage key（cards / timeline）
const REPORT_VIEW_MODE_KEY = 'report-agent:my-reports-view-mode';

// 颜色三元组(color/bg/border)统一走 useStatusChipConfig() — SSOT;
// label / icon 各页面自管,因为不同页面 icon 风格略有差异。
const STATUS_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
  [WeeklyReportStatus.Draft]:      { label: '草稿',   icon: Pencil },
  [WeeklyReportStatus.Submitted]:  { label: '已提交', icon: Send },
  [WeeklyReportStatus.Reviewed]:   { label: '已审阅', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]:   { label: '已退回', icon: AlertCircle },
  [WeeklyReportStatus.NotStarted]: { label: '未开始', icon: Clock },
};

// ────── component ──────

export function ReportMainView() {
  const {
    reports, teams, templates,
    showReportEditor, setShowReportEditor,
    setSelectedReportId, loadReports,
    setActiveTab,
  } = useReportAgentStore();

  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  const now = useMemo(() => getISOWeek(new Date()), []);
  const prevWeek = useMemo(() => getPreviousWeek(now), [now]);
  const [weekFilterMode, setWeekFilterMode] = useState<'all' | 'specific'>('all');
  const [selectedWeekKey, setSelectedWeekKey] = useState(getWeekKey(now));
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  // 列表视图：cards = 4 列响应式网格；timeline = 左侧年/月/周折叠树 + 右侧周报卡片面板。
  // sessionStorage 持久化用户选择，下次进来仍是同一视图。
  const [viewMode, setViewMode] = useState<'cards' | 'timeline'>(() => {
    if (typeof window === 'undefined') return 'cards';
    return window.sessionStorage.getItem(REPORT_VIEW_MODE_KEY) === 'timeline' ? 'timeline' : 'cards';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(REPORT_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  const hasTeam = teams.length > 0;
  const hasTemplate = templates.length > 0;
  const createWeek = useMemo(
    () => (weekFilterMode === 'specific' ? parseWeekKey(selectedWeekKey) : now),
    [weekFilterMode, selectedWeekKey, now]
  );

  const weekOptions = useMemo(() => {
    const weekMap = new Map<string, WeekRef>();
    for (const report of reports) {
      weekMap.set(getWeekKey(report), { weekYear: report.weekYear, weekNumber: report.weekNumber });
    }
    weekMap.set(getWeekKey(now), now);
    weekMap.set(getWeekKey(prevWeek), prevWeek);
    return [...weekMap.values()].sort((a, b) => {
      if (a.weekYear !== b.weekYear) return b.weekYear - a.weekYear;
      return b.weekNumber - a.weekNumber;
    });
  }, [reports, now, prevWeek]);

  const filteredReports = useMemo(() => {
    const sorted = [...reports].sort((a, b) => {
      if (a.weekYear !== b.weekYear) return b.weekYear - a.weekYear;
      if (a.weekNumber !== b.weekNumber) return b.weekNumber - a.weekNumber;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    if (weekFilterMode === 'all') return sorted;
    const selectedWeek = parseWeekKey(selectedWeekKey);
    return sorted.filter((r) => r.weekYear === selectedWeek.weekYear && r.weekNumber === selectedWeek.weekNumber);
  }, [reports, weekFilterMode, selectedWeekKey]);

  const groupedReports = useMemo(() => {
    const map = new Map<string, { week: WeekRef; items: WeeklyReport[] }>();
    for (const report of filteredReports) {
      const key = getWeekKey(report);
      if (!map.has(key)) {
        map.set(key, { week: { weekYear: report.weekYear, weekNumber: report.weekNumber }, items: [] });
      }
      map.get(key)!.items.push(report);
    }
    return [...map.values()].sort((a, b) => {
      if (a.week.weekYear !== b.week.weekYear) return b.week.weekYear - a.week.weekYear;
      return b.week.weekNumber - a.week.weekNumber;
    });
  }, [filteredReports]);

  const hasReports = filteredReports.length > 0;

  const handleCreateReport = useCallback(() => {
    setEditingReportId(null);
    setShowReportEditor(true);
  }, [setShowReportEditor]);

  const handleEditReport = useCallback((id: string) => {
    setEditingReportId(id);
    setSelectedReportId(id);
    setShowReportEditor(true);
  }, [setSelectedReportId, setShowReportEditor]);

  // 兼容旧入口：外部派发的 'report-agent:open-daily-log' 事件改为切到顶级「日常记录」Tab
  useEffect(() => {
    const onOpenDailyLog = () => {
      setActiveTab('dailyLog');
    };
    window.addEventListener('report-agent:open-daily-log', onOpenDailyLog);
    return () => {
      window.removeEventListener('report-agent:open-daily-log', onOpenDailyLog);
    };
  }, [setActiveTab]);

  // ── Editor view ──
  if (showReportEditor) {
    return (
      <ReportEditor
        reportId={editingReportId}
        weekYear={createWeek.weekYear}
        weekNumber={createWeek.weekNumber}
        onClose={() => {
          setShowReportEditor(false);
          setEditingReportId(null);
          void loadReports();
        }}
      />
    );
  }

  // ── Main workspace ──
  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pb-6" style={{ scrollbarWidth: 'thin' }}>
      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex flex-col gap-3">
            <div>
              <div
                className="text-[20px] font-semibold"
                style={{
                  color: 'var(--text-primary)',
                  fontFamily: isLight ? 'var(--font-serif)' : undefined,
                  letterSpacing: isLight ? '-0.01em' : undefined,
                  lineHeight: 1.2,
                }}
              >
                我的周报
              </div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                共 {reports.length} 份 · 默认展示全部周报
              </div>
            </div>
            {/* Segmented control — 一个 track 内嵌 3 个 seg,选中为白 thumb */}
            <div className="flex items-center gap-2 flex-wrap">
              <div
                className="inline-flex items-center p-0.5 rounded-lg"
                style={{
                  background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'var(--bg-tertiary)',
                  border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
                }}
              >
                {([
                  { key: 'all', label: '全部', active: weekFilterMode === 'all', onClick: () => setWeekFilterMode('all') },
                  { key: 'now', label: '本周', active: weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(now), onClick: () => { setWeekFilterMode('specific'); setSelectedWeekKey(getWeekKey(now)); } },
                  { key: 'prev', label: '上周', active: weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(prevWeek), onClick: () => { setWeekFilterMode('specific'); setSelectedWeekKey(getWeekKey(prevWeek)); } },
                ] as const).map((seg) => (
                  <button
                    key={seg.key}
                    className="whitespace-nowrap px-3 py-1 rounded-md text-[12px] font-medium transition-all duration-200"
                    style={{
                      color: seg.active ? 'var(--text-primary)' : 'var(--text-muted)',
                      background: seg.active
                        ? (isLight ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)')
                        : 'transparent',
                      boxShadow: seg.active && isLight ? 'var(--shadow-card-active)' : 'none',
                    }}
                    onClick={seg.onClick}
                  >
                    {seg.label}
                  </button>
                ))}
              </div>
              <div
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
              >
                <Calendar size={13} style={{ color: 'var(--text-muted)' }} />
                <select
                  className="text-[12px] bg-transparent outline-none"
                  style={{ color: 'var(--text-primary)' }}
                  value={selectedWeekKey}
                  onChange={(e) => {
                    setWeekFilterMode('specific');
                    setSelectedWeekKey(e.target.value);
                  }}
                >
                  {weekOptions.map((week) => (
                    <option key={getWeekKey(week)} value={getWeekKey(week)}>
                      {formatWeekLabel(week)}
                    </option>
                  ))}
                </select>
              </div>
              {/* 视图切换：卡片 / 时间树 */}
              <div
                className="inline-flex items-center p-0.5 rounded-lg"
                style={{
                  background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'var(--bg-tertiary)',
                  border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
                }}
              >
                {([
                  { key: 'cards', icon: LayoutGrid, title: '卡片视图' },
                  { key: 'timeline', icon: CalendarDays, title: '时间树视图（按年/月/周展开）' },
                ] as const).map((v) => {
                  const Icon = v.icon;
                  const active = viewMode === v.key;
                  return (
                    <button
                      key={v.key}
                      className="px-2 py-1 rounded-md transition-all duration-200 flex items-center justify-center"
                      style={{
                        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                        background: active
                          ? (isLight ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)')
                          : 'transparent',
                        boxShadow: active && isLight ? 'var(--shadow-card-active)' : 'none',
                      }}
                      onClick={() => setViewMode(v.key)}
                      title={v.title}
                      aria-label={v.title}
                      aria-pressed={active}
                    >
                      <Icon size={14} />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* "写周报" 常驻显示,无模板时禁用 + 可见提示文字(title 在移动端不可达),避免普通成员看不到入口 */}
            {hasTeam && (
              <div className="flex flex-col items-end gap-1">
                <Button
                  variant="primary"
                  size="sm"
                  data-tour-id="report-template-picker"
                  onClick={handleCreateReport}
                  disabled={!hasTemplate}
                  className="whitespace-nowrap"
                  title={hasTemplate ? undefined : '当前团队还未配置周报模板，请联系团队负责人在"设置"中绑定模板'}
                >
                  <Plus size={14} /> 写周报
                </Button>
                {!hasTemplate && (
                  <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                    团队未配置模板，请联系负责人
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </GlassCard>

      {!hasTeam && !hasTemplate && (
        <OnboardingGuide hasTeam={hasTeam} hasTemplate={hasTemplate} />
      )}

      {hasReports ? (
        viewMode === 'cards' ? (
          <ReportHistoryStrip
            groupedReports={groupedReports}
            onOpen={handleEditReport}
          />
        ) : (
          <ReportTimelineView
            reports={filteredReports as ReportLite[]}
            onOpen={handleEditReport}
          />
        )
      ) : hasTeam && hasTemplate ? (
        <div className="flex-1 flex items-center justify-center" style={{ minHeight: 240 }}>
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <FileText size={28} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            </div>
            <div>
              <div className="text-[15px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                暂无周报
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {weekFilterMode === 'all'
                  ? '还没有任何周报，点击右上角开始创建'
                  : `${formatWeekLabel(parseWeekKey(selectedWeekKey))} 暂无周报`}
              </div>
            </div>
            {hasTeam && hasTemplate && (
              <Button variant="primary" onClick={handleCreateReport}>
                <Plus size={14} /> 写周报
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ────── Report History Strip（左右滑动的历史栏）──────

interface ReportLite {
  id: string;
  teamName?: string;
  status: string;
  sections: { templateSection?: { title?: string }; items: { content: string }[] }[];
  returnReason?: string;
  submittedAt?: string;
  reviewedAt?: string;
  updatedAt: string;
  weekYear: number;
  weekNumber: number;
}

function ReportHistoryStrip({
  groupedReports,
  onOpen,
}: {
  groupedReports: { week: WeekRef; items: ReportLite[] }[];
  onOpen: (id: string) => void;
}) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  // 摊平所有周报，最近的在最前
  const flat = useMemo(() => {
    const all: ReportLite[] = [];
    for (const g of groupedReports) all.push(...g.items);
    return all;
  }, [groupedReports]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          按周次倒序排列 · 共 {flat.length} 份
        </span>
      </div>
      {/*
        响应式网格：
        - <640px (sm 以下)：1 列（手机）
        - 640-1023px (sm-lg)：2 列（小平板）
        - 1024-1279px (lg-xl)：3 列（笔记本/小窗口）
        - ≥1280px (xl 及以上)：4 列（桌面）
        卡片高度统一由内容撑开，flex 内部 mt-auto 让进度条/日期靠下对齐。
      */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {flat.map((report) => (
          <MiniReportCard
            key={report.id}
            report={report}
            isLight={isLight}
            onClick={() => onOpen(report.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MiniReportCard({
  report,
  isLight,
  onClick,
}: {
  report: ReportLite;
  isLight: boolean;
  onClick: () => void;
}) {
  const statusColors = useStatusChipConfig(isLight);
  const colors = statusColors[report.status] || statusColors[WeeklyReportStatus.Draft];
  const meta = STATUS_LABELS[report.status] || STATUS_LABELS[WeeklyReportStatus.Draft];
  const StatusIcon = meta.icon;
  const totalItems = report.sections.reduce((sum, s) => sum + s.items.length, 0);
  const filledItems = report.sections.reduce(
    (sum, s) => sum + s.items.filter((i) => i.content.trim()).length, 0
  );
  const progress = totalItems > 0 ? Math.round((filledItems / totalItems) * 100) : 0;

  return (
    <div
      className="group relative flex flex-col rounded-xl cursor-pointer transition-all duration-200 hover:translate-y-[-2px] w-full min-w-0"
      style={{
        background: isLight ? '#FFFFFF' : 'var(--surface-glass)',
        backdropFilter: isLight ? undefined : 'blur(12px)',
        WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
        border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
        borderTop: `3px solid ${colors.border}`,
        boxShadow: isLight ? 'var(--shadow-card-sm)' : 'var(--shadow-card)',
      }}
      onClick={onClick}
      title={report.teamName ? `${report.teamName} · ${formatWeekDateRange(report)} (W${report.weekNumber})` : `${formatWeekDateRange(report)} (W${report.weekNumber})`}
    >
      <div className="p-3 flex flex-col gap-2 flex-1">
        {/* 周次标签（最显眼）：主显示日期范围，辅显示 W 周次 */}
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <div className="flex flex-col min-w-0">
            <span className="text-[15px] font-semibold leading-none truncate" style={{ color: 'var(--text-primary)' }}>
              {formatWeekDateRange(report)}
            </span>
            <span className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {report.weekYear} · W{String(report.weekNumber).padStart(2, '0')}
            </span>
          </div>
          <span
            className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-[2px] rounded-full font-semibold flex-shrink-0"
            style={{
              color: colors.color,
              backgroundColor: colors.bg,
            }}
          >
            <StatusIcon size={8} />
            {meta.label}
          </span>
        </div>

        {/* 团队名 */}
        <div
          className="text-[12px] font-medium truncate leading-snug"
          style={{
            color: 'var(--text-secondary)',
            fontFamily: isLight ? 'var(--font-serif)' : undefined,
          }}
        >
          {report.teamName || '未知团队'}
        </div>

        {/* 章节进度迷你点阵 */}
        <div className="flex flex-wrap gap-1 mt-auto">
          {report.sections.map((s, i) => {
            const filled = s.items.filter(it => it.content.trim()).length;
            const total = s.items.length;
            const isComplete = filled === total && total > 0;
            const isGoing = filled > 0 && !isComplete;
            const dotColor = isComplete
              ? 'rgba(34, 197, 94, 0.8)'
              : isGoing
                ? 'rgba(249, 115, 22, 0.7)'
                : 'rgba(148, 163, 184, 0.35)';
            return (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: dotColor }}
                title={`${s.templateSection?.title || `章节 ${i + 1}`}: ${filled}/${total}`}
              />
            );
          })}
        </div>

        {/* 进度条 */}
        {totalItems > 0 && (
          <div className="flex items-center gap-2">
            <div
              className="flex-1 h-[3px] rounded-full overflow-hidden"
              style={{ background: isLight ? 'var(--hairline)' : 'var(--bg-tertiary)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${progress}%`,
                  background: progress === 100
                    ? (isLight ? 'var(--status-done)' : 'rgba(34, 197, 94, 0.7)')
                    : (isLight ? 'rgba(15, 23, 42, 0.32)' : colors.border),
                }}
              />
            </div>
            <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
              {progress}%
            </span>
          </div>
        )}

        {/* 时间轴锚点 + 更新日期 */}
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{
              background: colors.border,
              boxShadow: `0 0 0 2px ${isLight ? '#FFFFFF' : 'var(--surface-glass)'}`,
            }}
          />
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {new Date(report.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ────── Report Timeline View（年/月/周折叠树 + 右侧周报内容预览）──────

function ReportTimelineView({
  reports,
  onOpen,
}: {
  reports: ReportLite[];
  onOpen: (id: string) => void;
}) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const statusColors = useStatusChipConfig(isLight);

  // 按 year → month → week 三层分组
  // 注意：一个 ISO 周可能跨月（如 W18 包含 4/27~5/3），归到「周一所在月」
  interface WeekGroup {
    weekYear: number;
    weekNumber: number;
    weekStart: Date; // 该周周一 UTC 日期
    monthForGroup: number; // 1-12，按周一所在月归类
    reports: ReportLite[];
  }
  interface MonthGroup {
    month: number;
    weeks: WeekGroup[];
  }
  interface YearGroup {
    year: number;
    months: MonthGroup[];
    totalReports: number;
  }
  const tree = useMemo<YearGroup[]>(() => {
    const byWeek = new Map<string, WeekGroup>();
    for (const r of reports) {
      const key = `${r.weekYear}-${r.weekNumber}`;
      if (!byWeek.has(key)) {
        const start = getISOWeekStartLocal(r.weekYear, r.weekNumber);
        byWeek.set(key, {
          weekYear: r.weekYear,
          weekNumber: r.weekNumber,
          weekStart: start,
          monthForGroup: start.getUTCMonth() + 1,
          reports: [],
        });
      }
      byWeek.get(key)!.reports.push(r);
    }
    // 按周一日期倒序
    const allWeeks = [...byWeek.values()].sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime());
    // 分组到 year → month
    const yearMap = new Map<number, Map<number, WeekGroup[]>>();
    for (const wg of allWeeks) {
      const y = wg.weekYear;
      if (!yearMap.has(y)) yearMap.set(y, new Map());
      const monthMap = yearMap.get(y)!;
      if (!monthMap.has(wg.monthForGroup)) monthMap.set(wg.monthForGroup, []);
      monthMap.get(wg.monthForGroup)!.push(wg);
    }
    const years: YearGroup[] = [];
    for (const [year, monthMap] of yearMap) {
      const months: MonthGroup[] = [];
      let total = 0;
      const sortedMonths = [...monthMap.keys()].sort((a, b) => b - a);
      for (const m of sortedMonths) {
        const weeks = monthMap.get(m)!;
        total += weeks.reduce((s, w) => s + w.reports.length, 0);
        months.push({ month: m, weeks });
      }
      years.push({ year, months, totalReports: total });
    }
    years.sort((a, b) => b.year - a.year);
    return years;
  }, [reports]);

  // 当前年/月/周（用于默认展开 + 高亮）
  const today = useMemo(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }, []);
  const currentISO = useMemo(() => getISOWeek(new Date()), []);

  // 默认展开当前年 + 当前月；其他全部折叠
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>();
    init.add(`Y-${today.year}`);
    init.add(`Y-${today.year}-M-${today.month}`);
    return init;
  });
  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 默认选中：第一个有报告的周（或当前周如果存在）
  const allWeekKeys = useMemo(() => tree.flatMap((y) => y.months.flatMap((m) => m.weeks)), [tree]);
  const defaultSelectedKey = useMemo(() => {
    const cur = allWeekKeys.find((w) => w.weekYear === currentISO.weekYear && w.weekNumber === currentISO.weekNumber);
    if (cur) return `${cur.weekYear}-${cur.weekNumber}`;
    return allWeekKeys[0] ? `${allWeekKeys[0].weekYear}-${allWeekKeys[0].weekNumber}` : null;
  }, [allWeekKeys, currentISO]);
  const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(defaultSelectedKey);
  useEffect(() => {
    // 当报告集变化导致原选中 key 不存在时，回退到默认
    if (!selectedWeekKey || !allWeekKeys.some((w) => `${w.weekYear}-${w.weekNumber}` === selectedWeekKey)) {
      setSelectedWeekKey(defaultSelectedKey);
    }
  }, [allWeekKeys, defaultSelectedKey, selectedWeekKey]);

  const selectedWeekGroup = useMemo(
    () => allWeekKeys.find((w) => `${w.weekYear}-${w.weekNumber}` === selectedWeekKey) ?? null,
    [allWeekKeys, selectedWeekKey],
  );

  const treeBg = isLight ? '#FFFFFF' : 'var(--surface-glass)';
  const treeBorder = isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)';

  return (
    <div className="flex gap-3" style={{ minHeight: 480 }}>
      {/* ── 左：年/月/周折叠树 ── */}
      <aside
        className="flex-none rounded-xl overflow-y-auto"
        style={{
          width: 240,
          maxHeight: 'calc(100vh - 260px)',
          background: treeBg,
          backdropFilter: isLight ? undefined : 'blur(12px)',
          WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
          border: treeBorder,
          scrollbarWidth: 'thin',
        }}
      >
        <div className="p-2 flex flex-col gap-0.5">
          {tree.map((yg) => {
            const yKey = `Y-${yg.year}`;
            const yOpen = expanded.has(yKey);
            return (
              <div key={yKey} className="flex flex-col">
                <button
                  type="button"
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => toggle(yKey)}
                >
                  <ChevronRight
                    size={12}
                    style={{
                      color: 'var(--text-muted)',
                      transform: yOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 150ms',
                    }}
                  />
                  <span>{yg.year}</span>
                  <span className="ml-auto text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                    {yg.totalReports}
                  </span>
                </button>
                {yOpen && (
                  <div className="ml-3 border-l flex flex-col gap-0.5" style={{ borderColor: isLight ? 'var(--hairline)' : 'rgba(148,163,184,0.18)' }}>
                    {yg.months.map((mg) => {
                      const mKey = `Y-${yg.year}-M-${mg.month}`;
                      const mOpen = expanded.has(mKey);
                      const mTotal = mg.weeks.reduce((s, w) => s + w.reports.length, 0);
                      return (
                        <div key={mKey} className="flex flex-col">
                          <button
                            type="button"
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] transition-colors hover:bg-[var(--bg-tertiary)]"
                            style={{ color: 'var(--text-secondary)' }}
                            onClick={() => toggle(mKey)}
                          >
                            <ChevronRight
                              size={11}
                              style={{
                                color: 'var(--text-muted)',
                                transform: mOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                                transition: 'transform 150ms',
                              }}
                            />
                            <span>{mg.month} 月</span>
                            <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>{mTotal}</span>
                          </button>
                          {mOpen && (
                            <div className="ml-3 flex flex-col gap-0.5">
                              {mg.weeks.map((wg) => {
                                const wKey = `${wg.weekYear}-${wg.weekNumber}`;
                                const isCurrent = wg.weekYear === currentISO.weekYear && wg.weekNumber === currentISO.weekNumber;
                                const isSelected = wKey === selectedWeekKey;
                                return (
                                  <button
                                    key={wKey}
                                    type="button"
                                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-all"
                                    style={{
                                      background: isSelected
                                        ? 'rgba(99, 102, 241, 0.12)'
                                        : 'transparent',
                                      color: isSelected
                                        ? 'rgba(129, 140, 248, 1)'
                                        : (isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)'),
                                      fontWeight: isSelected || isCurrent ? 600 : 400,
                                    }}
                                    onClick={() => setSelectedWeekKey(wKey)}
                                    title={isCurrent ? '当前周' : undefined}
                                  >
                                    <span
                                      className="w-1 h-1 rounded-full flex-shrink-0"
                                      style={{
                                        background: isCurrent
                                          ? 'rgba(99, 102, 241, 0.9)'
                                          : 'transparent',
                                      }}
                                    />
                                    <span>{formatWeekDateRange(wg)}</span>
                                    <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                                      W{String(wg.weekNumber).padStart(2, '0')}
                                    </span>
                                  </button>
                                );
                              })}
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
        </div>
      </aside>

      {/* ── 右：选中周的周报内容预览 ── */}
      <section
        className="flex-1 min-w-0 rounded-xl overflow-y-auto"
        style={{
          maxHeight: 'calc(100vh - 260px)',
          background: treeBg,
          backdropFilter: isLight ? undefined : 'blur(12px)',
          WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
          border: treeBorder,
          scrollbarWidth: 'thin',
        }}
      >
        {selectedWeekGroup ? (
          <div className="p-5 flex flex-col gap-5">
            <header className="flex items-baseline justify-between flex-wrap gap-2">
              <div className="flex items-baseline gap-2">
                <h2
                  className="text-[20px] font-semibold leading-tight"
                  style={{
                    color: 'var(--text-primary)',
                    fontFamily: isLight ? 'var(--font-serif)' : undefined,
                    letterSpacing: isLight ? '-0.015em' : undefined,
                  }}
                >
                  {formatWeekDateRange(selectedWeekGroup)}
                </h2>
                <span className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  W{String(selectedWeekGroup.weekNumber).padStart(2, '0')} · {selectedWeekGroup.weekYear}
                </span>
              </div>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                共 {selectedWeekGroup.reports.length} 份周报
              </span>
            </header>
            {selectedWeekGroup.reports.map((report) => (
              <TimelineReportItem
                key={report.id}
                report={report}
                isLight={isLight}
                statusColors={statusColors}
                onOpen={() => onOpen(report.id)}
              />
            ))}
          </div>
        ) : (
          <div className="p-8 flex flex-col items-center justify-center gap-2 text-center">
            <FileText size={28} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>选择左侧任意一周查看周报</div>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * 单份周报内容预览：状态 + 团队名 + 各章节内容缩略 + 进度。
 * 章节 items 直接展开内容（取前 N 字），点击右上「查看完整」跳转详情。
 */
function TimelineReportItem({
  report,
  isLight,
  statusColors,
  onOpen,
}: {
  report: ReportLite;
  isLight: boolean;
  statusColors: ReturnType<typeof useStatusChipConfig>;
  onOpen: () => void;
}) {
  const colors = statusColors[report.status] || statusColors[WeeklyReportStatus.Draft];
  const meta = STATUS_LABELS[report.status] || STATUS_LABELS[WeeklyReportStatus.Draft];
  const StatusIcon = meta.icon;
  const totalItems = report.sections.reduce((sum, s) => sum + s.items.length, 0);
  const filledItems = report.sections.reduce(
    (sum, s) => sum + s.items.filter((i) => i.content.trim()).length, 0,
  );
  const progress = totalItems > 0 ? Math.round((filledItems / totalItems) * 100) : 0;

  return (
    <article
      className="rounded-xl flex flex-col gap-3 p-4 transition-colors"
      style={{
        background: isLight ? 'rgba(15, 23, 42, 0.025)' : 'rgba(255, 255, 255, 0.03)',
        border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
        borderLeft: `3px solid ${colors.border}`,
      }}
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className="inline-flex items-center gap-1 text-[10px] px-2 py-[2px] rounded-full font-semibold uppercase flex-shrink-0"
            style={{
              color: colors.color,
              backgroundColor: colors.bg,
              letterSpacing: '0.08em',
            }}
          >
            <StatusIcon size={9} />
            {meta.label}
          </span>
          <h3
            className="text-[15px] font-semibold truncate"
            style={{
              color: 'var(--text-primary)',
              fontFamily: isLight ? 'var(--font-serif)' : undefined,
            }}
          >
            {report.teamName || '未知团队'}
          </h3>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="text-[11px] underline-offset-2 hover:underline transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          查看完整 →
        </button>
      </div>

      {/* 章节内容缩略 */}
      <div className="flex flex-col gap-2.5">
        {report.sections.map((s, i) => {
          const filled = s.items.filter((it) => it.content.trim()).length;
          const total = s.items.length;
          const isComplete = filled === total && total > 0;
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span
                  className="text-[11px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {s.templateSection?.title || `章节 ${i + 1}`}
                </span>
                <span
                  className="text-[10px] font-mono"
                  style={{
                    color: isComplete
                      ? 'rgba(34, 197, 94, 0.8)'
                      : filled > 0
                        ? 'rgba(249, 115, 22, 0.8)'
                        : 'rgba(148, 163, 184, 0.6)',
                  }}
                >
                  {filled}/{total}
                </span>
              </div>
              {s.items.length > 0 ? (
                <ul className="flex flex-col gap-0.5 pl-3">
                  {s.items.slice(0, 5).map((it, idx) => {
                    const content = it.content.trim();
                    const preview = content
                      ? (content.length > 120 ? `${content.slice(0, 120).replace(/\s+/g, ' ')}…` : content.replace(/\s+/g, ' '))
                      : '（未填写）';
                    return (
                      <li
                        key={idx}
                        className="text-[12px] leading-relaxed"
                        style={{
                          color: content ? 'var(--text-secondary)' : 'var(--text-muted)',
                          fontStyle: content ? undefined : 'italic',
                        }}
                      >
                        <span className="opacity-50 mr-1">·</span>{preview}
                      </li>
                    );
                  })}
                  {s.items.length > 5 && (
                    <li className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      还有 {s.items.length - 5} 条…
                    </li>
                  )}
                </ul>
              ) : (
                <span className="text-[11px] pl-3" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  无条目
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 退回原因 */}
      {report.returnReason && (
        <div
          className="text-[11px] px-3 py-2 rounded-lg leading-relaxed"
          style={{
            color: 'rgba(239, 68, 68, 0.85)',
            backgroundColor: 'rgba(239, 68, 68, 0.06)',
            border: '1px solid rgba(239, 68, 68, 0.1)',
          }}
        >
          {report.returnReason}
        </div>
      )}

      {/* 底部：进度条 + 更新时间 */}
      <div className="flex items-center gap-3 mt-1">
        <div
          className="flex-1 h-1 rounded-full overflow-hidden"
          style={{ background: isLight ? 'var(--hairline)' : 'var(--bg-tertiary)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progress}%`,
              background: progress === 100
                ? (isLight ? 'var(--status-done)' : 'rgba(34, 197, 94, 0.7)')
                : (isLight ? 'rgba(15, 23, 42, 0.32)' : colors.border),
            }}
          />
        </div>
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{progress}%</span>
        <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
          {new Date(report.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
        </span>
      </div>
    </article>
  );
}

// timeline 视图用的本地 ISO 周一计算（不依赖 react import；与 utils/weekRange 内部实现一致）
function getISOWeekStartLocal(weekYear: number, weekNumber: number): Date {
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Dow + 1);
  const weekStart = new Date(week1Mon);
  weekStart.setUTCDate(week1Mon.getUTCDate() + (weekNumber - 1) * 7);
  return weekStart;
}

// ────── Onboarding Guide ──────

function OnboardingGuide({ hasTeam, hasTemplate }: { hasTeam: boolean; hasTemplate: boolean }) {
  const { setActiveTab } = useReportAgentStore();
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  const steps = [
    {
      done: hasTeam,
      title: '创建团队',
      desc: '先组建你的周报团队',
      action: () => setActiveTab('settings'),
    },
    {
      done: hasTemplate,
      title: '选择模板',
      desc: '设置周报的模板结构',
      action: () => setActiveTab('settings'),
    },
    {
      done: false,
      title: '开始写周报',
      desc: '一切就绪，开始记录',
      action: undefined,
    },
  ];

  return (
    <GlassCard variant="subtle" className="p-6">
      <div className="flex flex-col items-center text-center mb-6">
        <FileText
          size={32}
          style={{ color: isLight ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.6)' }}
          className="mb-3"
        />
        <div
          className="text-[18px] font-semibold mb-1"
          style={{
            color: 'var(--text-primary)',
            fontFamily: isLight ? 'var(--font-serif)' : undefined,
            letterSpacing: isLight ? '-0.01em' : undefined,
          }}
        >
          快速开始
        </div>
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          3 步完成设置，让 AI 帮你写周报
        </div>
      </div>

      {/* Steps */}
      <div className="flex items-start justify-center gap-3 mb-6">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3">
            <button
              onClick={step.action}
              disabled={!step.action}
              className="flex flex-col items-center gap-2 p-4 rounded-xl w-[140px] transition-all duration-200 cursor-pointer hover:scale-[1.02]"
              style={{
                background: step.done ? 'rgba(34, 197, 94, 0.06)' : 'var(--bg-secondary)',
                border: `1px solid ${step.done ? 'rgba(34, 197, 94, 0.2)' : 'var(--border-primary)'}`,
                opacity: step.action ? 1 : 0.5,
              }}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[14px] font-bold"
                style={{
                  background: step.done ? 'rgba(34, 197, 94, 0.15)' : 'rgba(59, 130, 246, 0.1)',
                  color: step.done ? 'rgba(34, 197, 94, 0.9)' : 'rgba(59, 130, 246, 0.8)',
                }}
              >
                {step.done ? <CheckCircle2 size={16} /> : i + 1}
              </div>
              <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {step.title}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {step.desc}
              </div>
            </button>
            {i < steps.length - 1 && (
              <ArrowRight size={14} className="mt-6 flex-shrink-0" style={{ color: 'var(--text-muted)', opacity: 0.3 }} />
            )}
          </div>
        ))}
      </div>

    </GlassCard>
  );
}
