import { useState, useMemo } from 'react';
import { Plus, FileText, ChevronLeft, ChevronRight, Calendar, CheckCircle2, Clock, AlertCircle, Send, Pencil } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { ReportEditor } from './ReportEditor';
import { useDataTheme } from '../hooks/useDataTheme';
import { useStatusChipConfig } from '../hooks/useStatusChipConfig';

function getISOWeek(date: Date): { weekYear: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

// 状态 → 文案 / 图标(各页面自管,因为不同页面 icon 风格略有差异);
// 颜色三元组(color/bg/border)统一走 useStatusChipConfig(),保证多文件一致 + WCAG AA 对比度。
const STATUS_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
  [WeeklyReportStatus.Draft]:      { label: '草稿',   icon: Pencil },
  [WeeklyReportStatus.Submitted]:  { label: '已提交', icon: Send },
  [WeeklyReportStatus.Reviewed]:   { label: '已审阅', icon: CheckCircle2 },
  [WeeklyReportStatus.Returned]:   { label: '已退回', icon: AlertCircle },
  [WeeklyReportStatus.NotStarted]: { label: '未开始', icon: Clock },
};

export function MyReportsList() {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const statusColors = useStatusChipConfig(isLight);
  const { reports, showReportEditor, setShowReportEditor, setSelectedReportId, loadReports } = useReportAgentStore();

  const now = useMemo(() => getISOWeek(new Date()), []);
  const [weekYear, setWeekYear] = useState(now.weekYear);
  const [weekNumber, setWeekNumber] = useState(now.weekNumber);
  const [editingReportId, setEditingReportId] = useState<string | null>(null);

  const isCurrentWeek = weekYear === now.weekYear && weekNumber === now.weekNumber;

  const filteredReports = useMemo(() => {
    return reports.filter((r) => r.weekYear === weekYear && r.weekNumber === weekNumber);
  }, [reports, weekYear, weekNumber]);

  const handlePrevWeek = () => {
    if (weekNumber <= 1) {
      setWeekYear(weekYear - 1);
      setWeekNumber(52);
    } else {
      setWeekNumber(weekNumber - 1);
    }
  };

  const handleNextWeek = () => {
    if (weekNumber >= 52) {
      setWeekYear(weekYear + 1);
      setWeekNumber(1);
    } else {
      setWeekNumber(weekNumber + 1);
    }
  };

  const handleCreateReport = () => {
    setEditingReportId(null);
    setShowReportEditor(true);
  };

  const handleEditReport = (id: string) => {
    setEditingReportId(id);
    setSelectedReportId(id);
    setShowReportEditor(true);
  };

  if (showReportEditor) {
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

  return (
    <div className="flex flex-col gap-5">
      {/* Week selector — card-wrapped */}
      <GlassCard variant="subtle" className="px-5 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={handlePrevWeek}>
              <ChevronLeft size={15} />
            </Button>
            <div className="flex items-center gap-2">
              <span
                className="text-[17px] font-semibold"
                style={{
                  color: 'var(--text-primary)',
                  fontFamily: dataTheme === 'light' ? 'var(--font-serif)' : undefined,
                  letterSpacing: dataTheme === 'light' ? '-0.01em' : undefined,
                }}
              >
                {weekYear} 年第 {weekNumber} 周
              </span>
              {isCurrentWeek && (
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{
                    color: dataTheme === 'light' ? 'var(--accent-claude)' : 'rgba(59, 130, 246, 0.9)',
                    background: dataTheme === 'light' ? 'var(--accent-claude-soft)' : 'rgba(59, 130, 246, 0.1)',
                  }}
                >
                  本周
                </span>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={handleNextWeek}>
              <ChevronRight size={15} />
            </Button>
            {!isCurrentWeek && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setWeekYear(now.weekYear); setWeekNumber(now.weekNumber); }}
              >
                回到本周
              </Button>
            )}
          </div>
          <Button variant="primary" size="sm" onClick={handleCreateReport}>
            <Plus size={14} /> 写周报
          </Button>
        </div>
      </GlassCard>

      {/* Reports grid */}
      {filteredReports.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ minHeight: 360 }}>
          <div className="flex flex-col items-center gap-5 text-center max-w-sm">
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <FileText size={32} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            </div>
            <div>
              <div className="text-[16px] font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                本周暂无周报
              </div>
              <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                点击右上角"写周报"开始记录本周工作成果
              </div>
            </div>
            <Button variant="primary" onClick={handleCreateReport}>
              <Plus size={14} /> 创建周报
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredReports.map((report) => {
            const colors = statusColors[report.status] || statusColors[WeeklyReportStatus.Draft];
            const meta = STATUS_LABELS[report.status] || STATUS_LABELS[WeeklyReportStatus.Draft];
            const StatusIcon = meta.icon;
            const totalItems = report.sections.reduce((sum, s) => sum + s.items.length, 0);
            const filledItems = report.sections.reduce(
              (sum, s) => sum + s.items.filter((i) => i.content.trim()).length,
              0
            );
            const progress = totalItems > 0 ? Math.round((filledItems / totalItems) * 100) : 0;

            return (
              <div
                key={report.id}
                className="group cursor-pointer rounded-xl transition-all duration-200 hover:translate-y-[-2px]"
                style={{
                  // 浅色:纯白 + hairline,不用 glass(米底上 blur 无意义);暗色保持 glass 发光感
                  background: isLight ? '#FFFFFF' : 'var(--surface-glass)',
                  backdropFilter: isLight ? undefined : 'blur(12px)',
                  WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
                  border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
                  borderLeft: `3px solid ${colors.border}`,
                  boxShadow: 'var(--shadow-card)',
                }}
                onClick={() => handleEditReport(report.id)}
              >
                <div className="p-5">
                  {/* Header: team + status */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {report.teamName || '未知团队'}
                      </div>
                    </div>
                    <span
                      className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full flex-shrink-0 ml-2 font-medium"
                      style={{ color: colors.color, backgroundColor: colors.bg }}
                    >
                      <StatusIcon size={11} />
                      {meta.label}
                    </span>
                  </div>

                  {/* Section list preview */}
                  <div className="flex flex-col gap-1 mb-3">
                    {report.sections.slice(0, 3).map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{
                            background: s.items.some(it => it.content.trim())
                              ? 'rgba(34, 197, 94, 0.6)'
                              : 'rgba(156, 163, 175, 0.3)',
                          }}
                        />
                        <span className="text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>
                          {s.templateSection?.title || `章节 ${i + 1}`}
                        </span>
                        <span className="text-[10px] ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {s.items.filter(it => it.content.trim()).length}/{s.items.length}
                        </span>
                      </div>
                    ))}
                    {report.sections.length > 3 && (
                      <span className="text-[10px] ml-3.5" style={{ color: 'var(--text-muted)' }}>
                        +{report.sections.length - 3} 个章节
                      </span>
                    )}
                  </div>

                  {/* Progress bar — always show for better info density */}
                  {totalItems > 0 && (
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          完成度
                        </span>
                        <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                          {progress}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${progress}%`,
                            background: progress === 100
                              ? 'rgba(34, 197, 94, 0.7)'
                              : `linear-gradient(90deg, ${colors.border}, ${colors.border.replace(/[\d.]+\)$/, '0.3)')})`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Return reason */}
                  {report.returnReason && (
                    <div
                      className="text-[11px] px-3 py-2 rounded-lg leading-relaxed mb-3"
                      style={{ color: 'rgba(239, 68, 68, 0.85)', backgroundColor: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.1)' }}
                    >
                      {report.returnReason}
                    </div>
                  )}

                  {/* Footer: time */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {report.sections.length} 个章节 · {totalItems} 条内容
                    </span>
                    {report.submittedAt && (
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {report.status === WeeklyReportStatus.Reviewed ? '审阅于' : '提交于'}{' '}
                        {new Date(report.reviewedAt || report.submittedAt).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
