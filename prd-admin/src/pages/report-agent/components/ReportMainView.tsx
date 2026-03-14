import { useState, useMemo } from 'react';
import {
  Plus, ChevronLeft, ChevronRight, Calendar, FileText,
  CheckCircle2, Clock, AlertCircle, Send, Pencil,
  CalendarCheck, Zap, ArrowRight,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { ReportEditor } from './ReportEditor';
import { StatsCardPanel } from './StatsCardPanel';
import { DailyLogInline } from './DailyLogInline';
import { MOCK_ACTIVITY, MOCK_REPORT_SECTIONS } from '../mockData';

// ────── helpers ──────

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
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
    mockPreviewMode,
  } = useReportAgentStore();

  const now = useMemo(() => getISOWeek(new Date()), []);
  const [weekYear, setWeekYear] = useState(now.weekYear);
  const [weekNumber, setWeekNumber] = useState(now.weekNumber);
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [showDailyLog, setShowDailyLog] = useState(false);

  const isCurrentWeek = weekYear === now.weekYear && weekNumber === now.weekNumber;

  const filteredReports = useMemo(() => {
    return reports.filter((r) => r.weekYear === weekYear && r.weekNumber === weekNumber);
  }, [reports, weekYear, weekNumber]);

  // Mock reports for preview mode
  const mockReports = useMemo(() => {
    if (!mockPreviewMode) return [];
    return [{
      id: 'mock-report-1',
      userId: 'mock-user',
      userName: 'Mock User',
      teamId: 'mock-team',
      teamName: '产品研发组',
      templateId: 'mock-tpl',
      weekYear, weekNumber,
      periodStart: new Date().toISOString(),
      periodEnd: new Date().toISOString(),
      status: 'draft',
      sections: MOCK_REPORT_SECTIONS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }];
  }, [mockPreviewMode, weekYear, weekNumber]);

  const displayReports = mockPreviewMode ? mockReports : filteredReports;

  const hasTeam = teams.length > 0;
  const hasTemplate = templates.length > 0;
  const hasReports = displayReports.length > 0;

  const handlePrevWeek = () => {
    if (weekNumber <= 1) { setWeekYear(weekYear - 1); setWeekNumber(52); }
    else setWeekNumber(weekNumber - 1);
  };
  const handleNextWeek = () => {
    if (weekNumber >= 52) { setWeekYear(weekYear + 1); setWeekNumber(1); }
    else setWeekNumber(weekNumber + 1);
  };

  const handleCreateReport = () => {
    setEditingReportId(null);
    setShowReportEditor(true);
  };
  const handleEditReport = (id: string) => {
    if (mockPreviewMode) return; // don't open editor in mock mode
    setEditingReportId(id);
    setSelectedReportId(id);
    setShowReportEditor(true);
  };

  // ── Editor view ──
  if (showReportEditor && !mockPreviewMode) {
    return (
      <ReportEditor
        reportId={editingReportId}
        weekYear={weekYear}
        weekNumber={weekNumber}
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

      {/* ① Week selector — compact header */}
      <GlassCard variant="subtle" className="px-5 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={handlePrevWeek}>
              <ChevronLeft size={15} />
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {weekYear} 年第 {weekNumber} 周
              </span>
              {isCurrentWeek && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ color: 'rgba(59, 130, 246, 0.9)', background: 'rgba(59, 130, 246, 0.1)' }}
                >
                  本周
                </span>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={handleNextWeek}>
              <ChevronRight size={15} />
            </Button>
            {!isCurrentWeek && (
              <Button variant="ghost" size="sm" onClick={() => { setWeekYear(now.weekYear); setWeekNumber(now.weekNumber); }}>
                回到本周
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Daily log quick entry */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowDailyLog(true)}
            >
              <CalendarCheck size={13} /> 打卡
            </Button>
            {hasTeam && hasTemplate && (
              <Button variant="primary" size="sm" onClick={handleCreateReport} disabled={mockPreviewMode}>
                <Plus size={14} /> 写周报
              </Button>
            )}
          </div>
        </div>
      </GlassCard>

      {/* ② Stats overview — always visible */}
      <StatsCardPanel
        weekYear={weekYear}
        weekNumber={weekNumber}
        mockData={mockPreviewMode ? MOCK_ACTIVITY : undefined}
      />

      {/* ③ Onboarding guide — shown when missing prerequisites */}
      {!hasTeam && !hasTemplate && !mockPreviewMode && (
        <OnboardingGuide hasTeam={hasTeam} hasTemplate={hasTemplate} />
      )}

      {/* ④ Report cards */}
      {hasReports ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              本周周报
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {displayReports.length} 份
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {displayReports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                onClick={() => handleEditReport(report.id)}
                isMock={mockPreviewMode}
              />
            ))}
          </div>
        </div>
      ) : !mockPreviewMode && hasTeam && hasTemplate ? (
        /* Empty state — has prerequisites but no report this week */
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
                本周还没有周报
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                开始记录这周的工作成果吧
              </div>
            </div>
            <Button variant="primary" onClick={handleCreateReport}>
              <Plus size={14} /> 写周报
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ────── Report Card ──────

function ReportCard({ report, onClick, isMock }: {
  report: { id: string; teamName?: string; status: string; sections: { templateSection?: { title?: string }; items: { content: string }[] }[]; returnReason?: string; submittedAt?: string; reviewedAt?: string };
  onClick: () => void;
  isMock?: boolean;
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
      className={`group rounded-xl transition-all duration-200 ${isMock ? '' : 'cursor-pointer hover:translate-y-[-1px]'}`}
      style={{
        background: 'var(--surface-glass)',
        backdropFilter: 'blur(12px)',
        border: `1px solid var(--border-primary)`,
        borderLeft: `3px solid ${cfg.borderColor}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        opacity: isMock ? 0.85 : 1,
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
            {isMock && (
              <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: 'rgba(168, 85, 247, 0.8)', background: 'rgba(168, 85, 247, 0.1)' }}>
                Mock
              </span>
            )}
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
      </div>
    </div>
  );
}

// ────── Onboarding Guide ──────

function OnboardingGuide({ hasTeam, hasTemplate }: { hasTeam: boolean; hasTemplate: boolean }) {
  const { setActiveTab, setMockPreviewMode } = useReportAgentStore();

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
        <Zap size={32} style={{ color: 'rgba(59, 130, 246, 0.6)' }} className="mb-3" />
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

      {/* CTA: preview with mock data */}
      <div className="flex justify-center">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setMockPreviewMode(true)}
        >
          <Zap size={13} /> 先看效果 — 一键预览 Mock 数据
        </Button>
      </div>
    </GlassCard>
  );
}
