import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Plus, Calendar, FileText,
  CheckCircle2, Clock, AlertCircle, Send, Pencil,
  ArrowRight,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import type { WeeklyReport } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { ReportEditor } from './ReportEditor';
import { useDataTheme } from '../hooks/useDataTheme';
import { useStatusChipConfig } from '../hooks/useStatusChipConfig';

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

function formatWeekLabel(week: WeekRef): string {
  return `${week.weekYear} 年第 ${week.weekNumber} 周`;
}

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
        <ReportHistoryStrip
          groupedReports={groupedReports}
          onOpen={handleEditReport}
        />
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

  // 摊平所有周报，最近的在最左
  const flat = useMemo(() => {
    const all: ReportLite[] = [];
    for (const g of groupedReports) all.push(...g.items);
    return all;
  }, [groupedReports]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          ← 左右滑动查看历史周报 · 共 {flat.length} 份
        </span>
      </div>
      <div className="relative">
        {/* 时间轴细线（横向，所有卡片底部对齐的水平线） */}
        <div
          className="absolute left-0 right-0 pointer-events-none"
          style={{
            bottom: 16,
            height: 1,
            background: isLight ? 'var(--hairline)' : 'rgba(148,163,184,0.18)',
          }}
        />
        <div
          className="flex gap-3 overflow-x-auto pb-5 pt-2"
          style={{
            scrollbarWidth: 'thin',
            scrollSnapType: 'x proximity',
            // 右侧渐隐遮罩提示"还有更多"
            maskImage: 'linear-gradient(to right, black 0%, black 95%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black 95%, transparent 100%)',
          }}
        >
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
      className="group relative flex flex-col rounded-xl cursor-pointer transition-all duration-200 hover:translate-y-[-2px]"
      style={{
        flex: '0 0 auto',
        width: 220,
        scrollSnapAlign: 'start',
        background: isLight ? '#FFFFFF' : 'var(--surface-glass)',
        backdropFilter: isLight ? undefined : 'blur(12px)',
        WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
        border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
        borderTop: `3px solid ${colors.border}`,
        boxShadow: isLight ? 'var(--shadow-card-sm)' : 'var(--shadow-card)',
      }}
      onClick={onClick}
      title={report.teamName ? `${report.teamName} · 第 ${report.weekNumber} 周` : `第 ${report.weekNumber} 周`}
    >
      <div className="p-3 flex flex-col gap-2 flex-1">
        {/* 周次标签（最显眼） */}
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {report.weekYear}
            </span>
            <span className="text-[15px] font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
              W{String(report.weekNumber).padStart(2, '0')}
            </span>
          </div>
          <span
            className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-[2px] rounded-full font-semibold"
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
