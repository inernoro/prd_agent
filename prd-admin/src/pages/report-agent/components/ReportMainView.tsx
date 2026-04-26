import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Plus, Calendar, FileText,
  CheckCircle2, Clock, AlertCircle, Send, Pencil,
  CalendarCheck, ArrowRight,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import type { WeeklyReport } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { ReportEditor } from './ReportEditor';
import { DailyLogInline } from './DailyLogInline';
import { TeamIssuesView } from './TeamIssuesView';
import { useDataTheme } from '../hooks/useDataTheme';
import { getSemantic, LIGHT_SEMANTIC } from '../hooks/lightModeColors';

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

interface StatusConfig {
  label: string;
  color: string;
  bg: string;
  borderColor: string;
  icon: React.ElementType;
}

/**
 * 周报状态 chip 配置 — 按主题返回语义色,浅色下走 getSemantic() 保证 WCAG AA 对比度。
 * 暗色下保持原视觉,避免回归破坏。
 */
function buildStatusConfig(isLight: boolean): Record<string, StatusConfig> {
  if (isLight) {
    const slate  = getSemantic(true, 'slate');
    const blue   = getSemantic(true, 'blue');
    const green  = getSemantic(true, 'green');
    const red    = getSemantic(true, 'red');
    return {
      [WeeklyReportStatus.Draft]:      { label: '草稿',   color: slate.color, bg: slate.bg, borderColor: slate.border, icon: Pencil },
      [WeeklyReportStatus.Submitted]:  { label: '已提交', color: blue.color,  bg: blue.bg,  borderColor: blue.border,  icon: Send },
      [WeeklyReportStatus.Reviewed]:   { label: '已审阅', color: green.color, bg: green.bg, borderColor: green.border, icon: CheckCircle2 },
      [WeeklyReportStatus.Returned]:   { label: '已退回', color: red.color,   bg: red.bg,   borderColor: red.border,   icon: AlertCircle },
      [WeeklyReportStatus.NotStarted]: { label: '未开始', color: LIGHT_SEMANTIC.slate, bg: LIGHT_SEMANTIC.bgSlate, borderColor: LIGHT_SEMANTIC.borderSlate, icon: Clock },
    };
  }
  return {
    [WeeklyReportStatus.Draft]:      { label: '草稿',   color: 'rgba(156, 163, 175, 0.9)', bg: 'rgba(156, 163, 175, 0.08)', borderColor: 'rgba(156, 163, 175, 0.4)',  icon: Pencil },
    [WeeklyReportStatus.Submitted]:  { label: '已提交', color: 'rgba(59, 130, 246, 0.9)',  bg: 'rgba(59, 130, 246, 0.08)',  borderColor: 'rgba(59, 130, 246, 0.5)',   icon: Send },
    [WeeklyReportStatus.Reviewed]:   { label: '已审阅', color: 'rgba(34, 197, 94, 0.9)',   bg: 'rgba(34, 197, 94, 0.08)',   borderColor: 'rgba(34, 197, 94, 0.5)',    icon: CheckCircle2 },
    [WeeklyReportStatus.Returned]:   { label: '已退回', color: 'rgba(239, 68, 68, 0.9)',   bg: 'rgba(239, 68, 68, 0.08)',   borderColor: 'rgba(239, 68, 68, 0.5)',    icon: AlertCircle },
    [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156, 163, 175, 0.7)', bg: 'rgba(156, 163, 175, 0.05)', borderColor: 'rgba(156, 163, 175, 0.2)',  icon: Clock },
  };
}

// ────── component ──────

export function ReportMainView() {
  const {
    reports, teams, templates,
    showReportEditor, setShowReportEditor,
    setSelectedReportId, loadReports,
  } = useReportAgentStore();

  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  const now = useMemo(() => getISOWeek(new Date()), []);
  const prevWeek = useMemo(() => getPreviousWeek(now), [now]);
  const [weekFilterMode, setWeekFilterMode] = useState<'all' | 'specific'>('all');
  const [selectedWeekKey, setSelectedWeekKey] = useState(getWeekKey(now));
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [showDailyLog, setShowDailyLog] = useState(false);
  /** 顶层视图切换: 我的周报 vs 团队问题 */
  const [viewMode, setViewMode] = useState<'mine' | 'issues'>('mine');

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

  useEffect(() => {
    const onOpenDailyLog = () => {
      setShowDailyLog(true);
    };
    window.addEventListener('report-agent:open-daily-log', onOpenDailyLog);
    return () => {
      window.removeEventListener('report-agent:open-daily-log', onOpenDailyLog);
    };
  }, []);

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

  // ── Inline daily log view ──
  if (showDailyLog) {
    return (
      <DailyLogInline onClose={() => setShowDailyLog(false)} />
    );
  }

  // ── Main workspace ──
  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pb-6" style={{ scrollbarWidth: 'thin' }}>
      {/* 顶层视图切换:我的周报 / 团队问题 */}
      <div className="flex items-center gap-2">
        <div
          className="inline-flex items-center p-0.5 rounded-lg"
          style={{
            background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'var(--bg-tertiary)',
            border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
          }}
        >
          {([
            { key: 'mine', label: '我的周报' },
            { key: 'issues', label: '团队问题' },
          ] as const).map((opt) => {
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
      </div>

      {viewMode === 'issues' ? <TeamIssuesView /> : (
      <>
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
                      boxShadow: seg.active && isLight ? '0 1px 2px rgba(15, 23, 42, 0.06), 0 0 0 1px rgba(15, 23, 42, 0.08)' : 'none',
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowDailyLog(true)}
              className="whitespace-nowrap"
            >
              <CalendarCheck size={13} /> 日常记录
            </Button>
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
        <div className="flex flex-col gap-5">
          {groupedReports.map((group) => (
            <div key={getWeekKey(group.week)} className="flex flex-col gap-3">
              <div className="flex items-center justify-between px-1">
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {formatWeekLabel(group.week)}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {group.items.length} 份
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {group.items.map((report) => (
                  <ReportCard
                    key={report.id}
                    report={report}
                    onClick={() => handleEditReport(report.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
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
      </>
      )}
    </div>
  );
}

// ────── Report Card ──────

function ReportCard({ report, onClick }: {
  report: {
    id: string;
    teamName?: string;
    status: string;
    sections: { templateSection?: { title?: string }; items: { content: string }[] }[];
    returnReason?: string;
    submittedAt?: string;
    reviewedAt?: string;
    updatedAt: string;
  };
  onClick: () => void;
}) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const statusConfig = useMemo(() => buildStatusConfig(isLight), [isLight]);
  const cfg = statusConfig[report.status] || statusConfig[WeeklyReportStatus.Draft];
  const StatusIcon = cfg.icon;
  const totalItems = report.sections.reduce((sum, s) => sum + s.items.length, 0);
  const filledItems = report.sections.reduce(
    (sum, s) => sum + s.items.filter((i) => i.content.trim()).length, 0
  );
  const progress = totalItems > 0 ? Math.round((filledItems / totalItems) * 100) : 0;

  return (
    <div
      className="group rounded-xl transition-all duration-200 cursor-pointer hover:translate-y-[-1px]"
      style={{
        background: isLight ? '#FFFFFF' : 'var(--surface-glass)',
        backdropFilter: isLight ? undefined : 'blur(12px)',
        WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
        border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
        borderLeft: `3px solid ${cfg.borderColor}`,
        boxShadow: isLight ? '0 1px 2px rgba(15,23,42,0.04)' : '0 2px 8px rgba(0,0,0,0.04)',
      }}
      onClick={onClick}
    >
      <div className="p-5">
        {/* Header — editorial 风: eyebrow status + 大字号 serif 团队名 */}
        <div className="mb-3">
          {/* Eyebrow status tag — small caps 风 */}
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium uppercase"
              style={{
                color: cfg.color,
                backgroundColor: cfg.bg,
                border: isLight ? `1px solid ${cfg.borderColor}` : 'none',
                letterSpacing: '0.04em',
              }}
            >
              <StatusIcon size={10} />
              {cfg.label}
            </span>
          </div>
          <div
            className="text-[20px] font-semibold leading-tight truncate"
            style={{
              color: 'var(--text-primary)',
              fontFamily: isLight ? 'var(--font-serif)' : undefined,
              letterSpacing: isLight ? '-0.015em' : undefined,
            }}
          >
            {report.teamName || '未知团队'}
          </div>
        </div>

        {/* Section previews — 按完成率三色分级: 完成=moss / 进行=amber / 未填=slate */}
        <div className="flex flex-wrap gap-2 mb-3">
          {report.sections.map((s, i) => {
            const filled = s.items.filter(it => it.content.trim()).length;
            const total = s.items.length;
            const isComplete = filled === total && total > 0;
            const isGoing = filled > 0 && !isComplete;

            // 浅色下三色分级
            const chipColor = isLight
              ? (isComplete ? 'var(--status-done)' : isGoing ? 'var(--status-going)' : 'var(--status-idle)')
              : 'var(--text-muted)';
            const chipBg = isLight
              ? (isComplete ? 'var(--status-done-soft)' : isGoing ? 'var(--status-going-soft)' : 'var(--status-idle-soft)')
              : 'var(--bg-tertiary)';
            const chipBorder = isLight
              ? (isComplete ? 'var(--status-done-border)' : isGoing ? 'var(--status-going-border)' : 'var(--status-idle-border)')
              : 'transparent';
            // 暗色保持原来逻辑
            if (!isLight) {
              const filledDot = 'rgba(34, 197, 94, 0.6)';
              const emptyDot  = 'rgba(156, 163, 175, 0.3)';
              const completeBg = 'rgba(34, 197, 94, 0.06)';
              const completeText = 'rgba(34, 197, 94, 0.8)';
              return (
                <div
                  key={i}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px]"
                  style={{
                    background: isComplete ? completeBg : 'var(--bg-tertiary)',
                    color: isComplete ? completeText : 'var(--text-muted)',
                  }}
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: filled > 0 ? filledDot : emptyDot }}
                  />
                  {s.templateSection?.title || `章节 ${i + 1}`}
                  <span style={{ opacity: 0.6 }}>{filled}/{total}</span>
                </div>
              );
            }
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
                style={{
                  background: chipBg,
                  color: chipColor,
                  border: `1px solid ${chipBorder}`,
                }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: chipColor }}
                />
                {s.templateSection?.title || `章节 ${i + 1}`}
                <span className="font-mono" style={{ opacity: 0.7 }}>{filled}/{total}</span>
              </div>
            );
          })}
        </div>

        {/* Progress bar — 浅色下 100% 柔和墨绿, 进行中走 Claude 橙;暗色保持原色 */}
        {totalItems > 0 && (
          <div className="flex items-center gap-3">
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
                    : (isLight
                        ? 'var(--accent-claude)'
                        : `linear-gradient(90deg, ${cfg.borderColor}, ${cfg.borderColor.replace(/[\d.]+\)$/, '0.3)')})`),
                }}
              />
            </div>
            <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
              {progress}%
            </span>
          </div>
        )}

        {/* Return reason */}
        {report.returnReason && (
          <div
            className="text-[11px] px-3 py-2 rounded-lg leading-relaxed mt-3"
            style={{ color: 'rgba(239, 68, 68, 0.85)', backgroundColor: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.1)' }}
          >
            {report.returnReason}
          </div>
        )}
        <div className="text-[10px] mt-3" style={{ color: 'var(--text-muted)' }}>
          更新于 {new Date(report.updatedAt).toLocaleDateString('zh-CN')}
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
