import { ArrowLeft, UserX } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import ReportDetailPage from '../ReportDetailPage';

export interface MemberReportInlineViewProps {
  reportId?: string;
  teamId: string;
  weekYear: number;
  weekNumber: number;
  memberName?: string;
  memberUserId: string;
  onBack: () => void;
  onSelectSibling: (reportId: string, userId: string) => void;
}

export function MemberReportInlineView({
  reportId,
  teamId,
  weekYear,
  weekNumber,
  memberName,
  memberUserId,
  onBack,
  onSelectSibling,
}: MemberReportInlineViewProps) {
  if (!reportId) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-4">
        <GlassCard variant="subtle" className="px-5 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {memberName || memberUserId}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {weekYear} 年第 {weekNumber} 周
              </div>
            </div>
          </div>
        </GlassCard>
        <GlassCard variant="subtle" className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 py-12">
          <UserX size={32} style={{ color: 'var(--text-muted)' }} />
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            该成员本周尚未提交周报
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            可左侧切换其他周或其他成员
          </div>
          <Button variant="secondary" size="sm" onClick={onBack} className="mt-2">
            返回本周列表
          </Button>
        </GlassCard>
      </div>
    );
  }

  return (
    <ReportDetailPage
      reportIdOverride={reportId}
      teamIdOverride={teamId}
      weekYearOverride={weekYear}
      weekNumberOverride={weekNumber}
      onBack={onBack}
      onSelectSibling={onSelectSibling}
      hideSiblings={true}
    />
  );
}
