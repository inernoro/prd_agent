import { useState, useMemo, useCallback } from 'react';
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

const statusConfig: Record<string, { label: string; color: string; bg: string; borderColor: string; icon: React.ElementType }> = {
  [WeeklyReportStatus.Draft]:      { label: '草稿',   color: 'rgba(156, 163, 175, 0.9)', bg: 'rgba(156, 163, 175, 0.08)', borderColor: 'rgba(156, 163, 175, 0.4)',  icon: Pencil },
  [WeeklyReportStatus.Submitted]:  { label: '已提交', color: 'rgba(59, 130, 246, 0.9)',  bg: 'rgba(59, 130, 246, 0.08)',  borderColor: 'rgba(59, 130, 246, 0.5)',   icon: Send },
  [WeeklyReportStatus.Reviewed]:   { label: '已审阅', color: 'rgba(34, 197, 94, 0.9)',   bg: 'rgba(34, 197, 94, 0.08)',   borderColor: 'rgba(34, 197, 94, 0.5)',    icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]:   { label: '已退回', color: 'rgba(239, 68, 68, 0.9)',   bg: 'rgba(239, 68, 68, 0.08)',   borderColor: 'rgba(239, 68, 68, 0.5)',    icon: AlertCircle },
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156, 163, 175, 0.5)', bg: 'rgba(156, 163, 175, 0.05)', borderColor: 'rgba(156, 163, 175, 0.2)',  icon: Clock },
};

// ────── component ──────

export function ReportMainView() {
  const {
    reports, teams, templates,
    showReportEditor, setShowReportEditor,
    setSelectedReportId, loadReports,
  } = useReportAgentStore();

  const now = useMemo(() => getISOWeek(new Date()), []);
  const prevWeek = useMemo(() => getPreviousWeek(now), [now]);
  const [weekFilterMode, setWeekFilterMode] = useState<'all' | 'specific'>('all');
  const [selectedWeekKey, setSelectedWeekKey] = useState(getWeekKey(now));
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [showDailyLog, setShowDailyLog] = useState(false);

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
      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                我的周报
              </div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                共 {reports.length} 份 · 默认展示全部周报
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className="whitespace-nowrap px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{
                  color: weekFilterMode === 'all' ? 'rgba(59, 130, 246, 0.95)' : 'var(--text-secondary)',
                  background: weekFilterMode === 'all' ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-secondary)',
                  border: `1px solid ${weekFilterMode === 'all' ? 'rgba(59, 130, 246, 0.2)' : 'var(--border-primary)'}`,
                }}
                onClick={() => setWeekFilterMode('all')}
              >
                全部
              </button>
              <button
                className="whitespace-nowrap px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{
                  color:
                    weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(now)
                      ? 'rgba(59, 130, 246, 0.95)'
                      : 'var(--text-secondary)',
                  background:
                    weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(now)
                      ? 'rgba(59, 130, 246, 0.1)'
                      : 'var(--bg-secondary)',
                  border:
                    weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(now)
                      ? '1px solid rgba(59, 130, 246, 0.2)'
                      : '1px solid var(--border-primary)',
                }}
                onClick={() => {
                  setWeekFilterMode('specific');
                  setSelectedWeekKey(getWeekKey(now));
                }}
              >
                本周
              </button>
              <button
                className="whitespace-nowrap px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{
                  color:
                    weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(prevWeek)
                      ? 'rgba(59, 130, 246, 0.95)'
                      : 'var(--text-secondary)',
                  background:
                    weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(prevWeek)
                      ? 'rgba(59, 130, 246, 0.1)'
                      : 'var(--bg-secondary)',
                  border:
                    weekFilterMode === 'specific' && selectedWeekKey === getWeekKey(prevWeek)
                      ? '1px solid rgba(59, 130, 246, 0.2)'
                      : '1px solid var(--border-primary)',
                }}
                onClick={() => {
                  setWeekFilterMode('specific');
                  setSelectedWeekKey(getWeekKey(prevWeek));
                }}
              >
                上周
              </button>
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
            {hasTeam && hasTemplate && (
              <Button variant="primary" size="sm" onClick={handleCreateReport} className="whitespace-nowrap">
                <Plus size={14} /> 写周报
              </Button>
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
        background: 'var(--surface-glass)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid var(--border-primary)`,
        borderLeft: `3px solid ${cfg.borderColor}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
      }}
      onClick={onClick}
    >
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {report.teamName || '未知团队'}
            </div>
          </div>
          <div className="flex items-center gap-2 ml-2">
            <span
              className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full flex-shrink-0 font-medium"
              style={{ color: cfg.color, backgroundColor: cfg.bg }}
            >
              <StatusIcon size={11} />
              {cfg.label}
            </span>
          </div>
        </div>

        {/* Section previews — horizontal layout for compactness */}
        <div className="flex flex-wrap gap-2 mb-3">
          {report.sections.map((s, i) => {
            const filled = s.items.filter(it => it.content.trim()).length;
            const total = s.items.length;
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px]"
                style={{
                  background: filled === total && total > 0 ? 'rgba(34, 197, 94, 0.06)' : 'var(--bg-tertiary)',
                  color: filled === total && total > 0 ? 'rgba(34, 197, 94, 0.8)' : 'var(--text-muted)',
                }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: filled > 0 ? 'rgba(34, 197, 94, 0.6)' : 'rgba(156, 163, 175, 0.3)' }}
                />
                {s.templateSection?.title || `章节 ${i + 1}`}
                <span style={{ opacity: 0.6 }}>{filled}/{total}</span>
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        {totalItems > 0 && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${progress}%`,
                  background: progress === 100
                    ? 'rgba(34, 197, 94, 0.7)'
                    : `linear-gradient(90deg, ${cfg.borderColor}, ${cfg.borderColor.replace(/[\d.]+\)$/, '0.3)')})`,
                }}
              />
            </div>
            <span className="text-[10px] font-medium flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
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
        <FileText size={32} style={{ color: 'rgba(59, 130, 246, 0.6)' }} className="mb-3" />
        <div className="text-[16px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
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
