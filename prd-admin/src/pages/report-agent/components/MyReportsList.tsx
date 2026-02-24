import { useState, useMemo } from 'react';
import { Plus, FileText, ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
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

const statusLabels: Record<string, { label: string; color: string }> = {
  [WeeklyReportStatus.Draft]: { label: '草稿', color: 'rgba(156, 163, 175, 0.9)' },
  [WeeklyReportStatus.Submitted]: { label: '已提交', color: 'rgba(59, 130, 246, 0.9)' },
  [WeeklyReportStatus.Reviewed]: { label: '已审阅', color: 'rgba(34, 197, 94, 0.9)' },
  [WeeklyReportStatus.Returned]: { label: '已退回', color: 'rgba(239, 68, 68, 0.9)' },
  [WeeklyReportStatus.NotStarted]: { label: '未开始', color: 'rgba(156, 163, 175, 0.5)' },
};

export function MyReportsList() {
  const { reports, showReportEditor, setShowReportEditor, setSelectedReportId, loadReports } = useReportAgentStore();

  const now = useMemo(() => getISOWeek(new Date()), []);
  const [weekYear, setWeekYear] = useState(now.weekYear);
  const [weekNumber, setWeekNumber] = useState(now.weekNumber);
  const [editingReportId, setEditingReportId] = useState<string | null>(null);

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
    <div className="flex flex-col gap-4">
      {/* Week selector */}
      <GlassCard variant="subtle" className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={handlePrevWeek}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {weekYear} 年第 {weekNumber} 周
            </span>
            <Button variant="ghost" size="sm" onClick={handleNextWeek}>
              <ChevronRight size={14} />
            </Button>
          </div>
          <Button variant="primary" size="sm" onClick={handleCreateReport}>
            <Plus size={14} /> 写周报
          </Button>
        </div>
      </GlassCard>

      {/* Reports grid */}
      {filteredReports.length === 0 ? (
        <GlassCard variant="subtle" className="flex-1 min-h-0">
          <div className="h-full flex items-center justify-center py-16">
            <div className="text-center">
              <FileText size={40} style={{ color: 'var(--text-muted)', opacity: 0.5, margin: '0 auto' }} />
              <div className="text-[13px] font-medium mt-3" style={{ color: 'var(--text-secondary)' }}>
                本周暂无周报
              </div>
              <Button variant="secondary" size="sm" className="mt-3" onClick={handleCreateReport}>
                <Plus size={12} /> 创建周报
              </Button>
            </div>
          </div>
        </GlassCard>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filteredReports.map((report) => {
            const statusInfo = statusLabels[report.status] || statusLabels[WeeklyReportStatus.Draft];
            return (
              <GlassCard
                key={report.id}
                className="p-4 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => handleEditReport(report.id)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {report.teamName || '未知团队'}
                  </div>
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-full"
                    style={{ color: statusInfo.color, backgroundColor: `${statusInfo.color}15` }}
                  >
                    {statusInfo.label}
                  </span>
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {report.sections.length} 个章节 · {report.sections.reduce((sum, s) => sum + s.items.length, 0)} 条内容
                </div>
                {report.returnReason && (
                  <div
                    className="mt-2 text-[11px] px-2 py-1 rounded"
                    style={{ color: 'rgba(239, 68, 68, 0.9)', backgroundColor: 'rgba(239, 68, 68, 0.08)' }}
                  >
                    退回原因: {report.returnReason}
                  </div>
                )}
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
