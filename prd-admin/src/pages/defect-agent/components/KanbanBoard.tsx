import { useMemo } from 'react';
import { useDefectStore } from '@/stores/defectStore';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import type { DefectReport } from '@/services/contracts/defectAgent';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  MinusCircle,
  Clock,
} from 'lucide-react';

const columns = [
  { key: DefectStatus.Pending, label: '待处理', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  { key: DefectStatus.Working, label: '处理中', color: '#3b82f6', bg: 'rgba(59,130,246,0.08)' },
  { key: DefectStatus.Verifying, label: '待验收', color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)' },
  { key: DefectStatus.Resolved, label: '已解决', color: '#22c55e', bg: 'rgba(34,197,94,0.08)' },
  { key: DefectStatus.Closed, label: '已关闭', color: '#6b7280', bg: 'rgba(107,114,128,0.08)' },
];

const severityConfig: Record<string, { label: string; color: string; icon: typeof AlertTriangle }> = {
  [DefectSeverity.Critical]: { label: '致命', color: '#ef4444', icon: AlertTriangle },
  [DefectSeverity.Major]: { label: '严重', color: '#f97316', icon: AlertCircle },
  [DefectSeverity.Minor]: { label: '一般', color: '#eab308', icon: Info },
  [DefectSeverity.Trivial]: { label: '轻微', color: '#22c55e', icon: MinusCircle },
};

function formatTimeAgo(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}时`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}天`;
}

export function KanbanBoard() {
  const { defects, setSelectedDefectId } = useDefectStore();

  const grouped = useMemo(() => {
    const map: Record<string, DefectReport[]> = {};
    for (const col of columns) {
      map[col.key] = [];
    }
    for (const d of defects) {
      const status = d.status;
      if (map[status]) {
        map[status].push(d);
      }
      // draft and rejected go to pending column for visibility
      if (status === DefectStatus.Draft || status === DefectStatus.Rejected) {
        if (!map[status]) {
          map[DefectStatus.Pending]?.push(d);
        }
      }
    }
    return map;
  }, [defects]);

  if (defects.length === 0) {
    return (
      <div className="text-center py-16 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        暂无缺陷数据
      </div>
    );
  }

  return (
    <div className="flex gap-3 h-full min-h-0 overflow-x-auto pb-2">
      {columns.map((col) => {
        const items = grouped[col.key] || [];
        return (
          <div
            key={col.key}
            className="flex flex-col min-w-[220px] w-[220px] shrink-0"
          >
            {/* Column Header */}
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-t-xl"
              style={{ background: col.bg }}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: col.color }}
              />
              <span className="text-[12px] font-medium" style={{ color: col.color }}>
                {col.label}
              </span>
              <span
                className="text-[11px] ml-auto font-mono px-1.5 rounded"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                {items.length}
              </span>
            </div>

            {/* Column Body */}
            <div
              className="flex-1 min-h-0 overflow-y-auto space-y-2 px-1 py-2 rounded-b-xl"
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.04)',
                borderTop: 'none',
              }}
            >
              {items.length === 0 ? (
                <div
                  className="text-center py-6 text-[11px]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  --
                </div>
              ) : (
                items.map((defect) => (
                  <KanbanCard
                    key={defect.id}
                    defect={defect}
                    onClick={() => setSelectedDefectId(defect.id)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  defect,
  onClick,
}: {
  defect: DefectReport;
  onClick: () => void;
}) {
  const sev = severityConfig[defect.severity];
  const SevIcon = sev?.icon || Info;

  return (
    <div
      onClick={onClick}
      className="px-3 py-2.5 rounded-lg cursor-pointer transition-all hover:scale-[1.01]"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Defect No + Severity */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          {defect.defectNo}
        </span>
        {sev && (
          <SevIcon
            size={10}
            style={{ color: sev.color, marginLeft: 'auto' }}
          />
        )}
      </div>

      {/* Title */}
      <div
        className="text-[12px] font-medium leading-tight mb-2 line-clamp-2"
        style={{ color: 'var(--text-primary)' }}
      >
        {defect.title || defect.rawContent?.slice(0, 40) || '(无标题)'}
      </div>

      {/* Footer: avatar + time */}
      <div className="flex items-center gap-1.5">
        <img
          src={defect.assigneeAvatarFileName
            ? resolveAvatarUrl({ avatarFileName: defect.assigneeAvatarFileName })
            : resolveNoHeadAvatarUrl()}
          className="w-4 h-4 rounded-full"
          alt=""
        />
        <span className="text-[10px] truncate flex-1" style={{ color: 'var(--text-muted)' }}>
          {defect.assigneeName || '未分配'}
        </span>
        {defect.updatedAt && (
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <Clock size={9} />
            {formatTimeAgo(defect.updatedAt)}
          </span>
        )}
      </div>
    </div>
  );
}
