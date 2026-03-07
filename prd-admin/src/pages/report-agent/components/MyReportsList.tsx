import { useState, useMemo } from 'react';
import { Plus, FileText, ChevronLeft, ChevronRight, Calendar, CheckCircle2, Clock, AlertCircle, Send, Pencil } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { ReportEditor } from './ReportEditor';

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

export function MyReportsList() {
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
      {/* Week selector — clean, centered */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar size={15} style={{ color: 'var(--text-muted)' }} />
          <Button variant="ghost" size="sm" onClick={handlePrevWeek}>
            <ChevronLeft size={14} />
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {weekYear} 年第 {weekNumber} 周
            </span>
            {isCurrentWeek && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ color: 'rgba(59, 130, 246, 0.9)', background: 'rgba(59, 130, 246, 0.1)' }}
              >
                本周
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={handleNextWeek}>
            <ChevronRight size={14} />
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

      {/* Reports grid */}
      {filteredReports.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ minHeight: 400 }}>
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <FileText size={28} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            </div>
            <div>
              <div className="text-[15px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                本周暂无周报
              </div>
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                点击"写周报"开始记录本周工作
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={handleCreateReport}>
              <Plus size={12} /> 创建周报
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredReports.map((report) => {
            const cfg = statusConfig[report.status] || statusConfig[WeeklyReportStatus.Draft];
            const StatusIcon = cfg.icon;
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
                  background: 'var(--surface-glass)',
                  backdropFilter: 'blur(12px)',
                  border: '1px solid var(--border-primary)',
                  borderLeft: `3px solid ${cfg.borderColor}`,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
                onClick={() => handleEditReport(report.id)}
              >
                <div className="p-4">
                  {/* Header: team + status */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {report.teamName || '未知团队'}
                      </div>
                    </div>
                    <span
                      className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 ml-2"
                      style={{ color: cfg.color, backgroundColor: cfg.bg }}
                    >
                      <StatusIcon size={10} />
                      {cfg.label}
                    </span>
                  </div>

                  {/* Section summary */}
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {report.sections.length} 个章节
                    </span>
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {totalItems} 条内容
                    </span>
                  </div>

                  {/* Progress bar */}
                  {report.status === WeeklyReportStatus.Draft && totalItems > 0 && (
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          完成度
                        </span>
                        <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                          {progress}%
                        </span>
                      </div>
                      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${progress}%`,
                            background: progress === 100
                              ? 'rgba(34, 197, 94, 0.7)'
                              : 'rgba(59, 130, 246, 0.6)',
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Return reason */}
                  {report.returnReason && (
                    <div
                      className="text-[11px] px-2.5 py-1.5 rounded-lg leading-relaxed"
                      style={{ color: 'rgba(239, 68, 68, 0.85)', backgroundColor: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.1)' }}
                    >
                      {report.returnReason}
                    </div>
                  )}

                  {/* Submitted/reviewed time */}
                  {report.submittedAt && (
                    <div className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                      {report.status === WeeklyReportStatus.Reviewed ? '审阅于' : '提交于'}{' '}
                      {new Date(report.reviewedAt || report.submittedAt).toLocaleDateString('zh-CN')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
