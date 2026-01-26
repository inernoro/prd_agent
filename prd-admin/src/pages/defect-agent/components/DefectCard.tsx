import { GlassCard } from '@/components/design/GlassCard';
import { useDefectStore } from '@/stores/defectStore';
import type { DefectReport } from '@/services/contracts/defectAgent';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import { ArrowRight, Clock } from 'lucide-react';

interface DefectCardProps {
  defect: DefectReport;
}

const statusLabels: Record<string, string> = {
  [DefectStatus.Draft]: '草稿',
  [DefectStatus.Pending]: '待处理',
  [DefectStatus.Working]: '处理中',
  [DefectStatus.Resolved]: '已解决',
  [DefectStatus.Rejected]: '已驳回',
  [DefectStatus.Closed]: '已关闭',
};

const statusColors: Record<string, string> = {
  [DefectStatus.Draft]: 'rgba(150,150,150,0.9)',
  [DefectStatus.Pending]: 'rgba(255,180,70,0.9)',
  [DefectStatus.Working]: 'rgba(100,180,255,0.9)',
  [DefectStatus.Resolved]: 'rgba(100,200,120,0.9)',
  [DefectStatus.Rejected]: 'rgba(255,100,100,0.9)',
  [DefectStatus.Closed]: 'rgba(120,120,120,0.9)',
};

const severityLabels: Record<string, string> = {
  [DefectSeverity.Critical]: '致命',
  [DefectSeverity.Major]: '严重',
  [DefectSeverity.Minor]: '一般',
  [DefectSeverity.Trivial]: '轻微',
};

const severityColors: Record<string, string> = {
  [DefectSeverity.Critical]: 'rgba(255,80,80,0.9)',
  [DefectSeverity.Major]: 'rgba(255,140,60,0.9)',
  [DefectSeverity.Minor]: 'rgba(255,200,80,0.9)',
  [DefectSeverity.Trivial]: 'rgba(150,200,100,0.9)',
};

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString();
}

export function DefectCard({ defect }: DefectCardProps) {
  const { selectedDefectId, setSelectedDefectId } = useDefectStore();
  const isSelected = selectedDefectId === defect.id;

  const title = defect.title || defect.rawContent?.slice(0, 50) || '无标题';
  const statusLabel = statusLabels[defect.status] || defect.status;
  const statusColor = statusColors[defect.status] || 'var(--text-muted)';
  const severityLabel = severityLabels[defect.severity] || defect.severity;
  const severityColor = severityColors[defect.severity] || 'var(--text-muted)';

  return (
    <GlassCard
      glow={isSelected}
      className="p-0 overflow-hidden cursor-pointer transition-all"
      style={{
        border: isSelected
          ? '1px solid rgba(214,178,106,0.4)'
          : '1px solid rgba(255,255,255,0.06)',
      }}
      onClick={() => setSelectedDefectId(isSelected ? null : defect.id)}
    >
      <div className="px-3 py-2.5">
        {/* Header: DefectNo + Severity + Status */}
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: 'var(--text-muted)',
            }}
          >
            {defect.defectNo}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: `${severityColor}20`, color: severityColor }}
          >
            {severityLabel}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded ml-auto"
            style={{ background: `${statusColor}20`, color: statusColor }}
          >
            {statusLabel}
          </span>
        </div>

        {/* Title */}
        <div
          className="text-[13px] font-medium truncate mb-1.5"
          style={{ color: 'var(--text-primary)' }}
        >
          {title}
        </div>

        {/* Footer: Reporter -> Assignee + Time */}
        <div
          className="flex items-center gap-2 text-[11px]"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>{defect.reporterName || '未知'}</span>
          <ArrowRight size={10} />
          <span>{defect.assigneeName || '未指派'}</span>
          <span className="ml-auto flex items-center gap-1">
            <Clock size={10} />
            {formatDate(defect.createdAt)}
          </span>
        </div>
      </div>
    </GlassCard>
  );
}
