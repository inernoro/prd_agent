import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { getWeeklyReport } from '@/services';
import type { WeeklyReport } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';

interface Props {
  reportId: string;
  onClose: () => void;
  onReview?: () => void;
  onReturn?: () => void;
}

export function ReportDetailPanel({ reportId, onClose, onReview, onReturn }: Props) {
  const [report, setReport] = useState<WeeklyReport | null>(null);

  useEffect(() => {
    (async () => {
      const res = await getWeeklyReport({ id: reportId });
      if (res.success && res.data) {
        setReport(res.data.report);
      }
    })();
  }, [reportId]);

  if (!report) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
        <GlassCard className="p-6 w-[500px]">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
      <GlassCard className="p-0 w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <div>
            <div className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {report.userName} 的周报
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {report.teamName} · {report.weekYear} 年第 {report.weekNumber} 周
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
          {report.sections.map((section, idx) => (
            <div key={idx} className="mb-4">
              <div className="text-[13px] font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                {section.templateSection.title}
              </div>
              {section.items.length === 0 ? (
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>（未填写）</div>
              ) : (
                <ul className="space-y-1">
                  {section.items.map((item, iIdx) => (
                    <li key={iIdx} className="flex items-start gap-2">
                      <span className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>•</span>
                      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{item.content || '（空）'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {/* Footer actions */}
        {report.status === WeeklyReportStatus.Submitted && (onReview || onReturn) && (
          <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
            {onReturn && (
              <Button variant="secondary" size="sm" onClick={onReturn}>
                退回
              </Button>
            )}
            {onReview && (
              <Button variant="primary" size="sm" onClick={onReview}>
                审阅通过
              </Button>
            )}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
