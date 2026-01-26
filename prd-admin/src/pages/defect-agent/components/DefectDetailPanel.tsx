import { useMemo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import {
  processDefect,
  resolveDefect,
  rejectDefect,
  closeDefect,
} from '@/services';
import { toast } from '@/lib/toast';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import {
  X,
  ArrowRight,
  Clock,
  Paperclip,
  Play,
  CheckCircle,
  XCircle,
  Archive,
  ExternalLink,
} from 'lucide-react';

const statusLabels: Record<string, string> = {
  [DefectStatus.Draft]: '草稿',
  [DefectStatus.Pending]: '待处理',
  [DefectStatus.Working]: '处理中',
  [DefectStatus.Resolved]: '已解决',
  [DefectStatus.Rejected]: '已驳回',
  [DefectStatus.Closed]: '已关闭',
};

const severityLabels: Record<string, string> = {
  [DefectSeverity.Critical]: '致命',
  [DefectSeverity.Major]: '严重',
  [DefectSeverity.Minor]: '一般',
  [DefectSeverity.Trivial]: '轻微',
};

function formatDateTime(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

export function DefectDetailPanel() {
  const {
    defects,
    selectedDefectId,
    setSelectedDefectId,
    updateDefectInList,
    loadStats,
  } = useDefectStore();

  const defect = useMemo(
    () => defects.find((d) => d.id === selectedDefectId),
    [defects, selectedDefectId]
  );

  if (!defect) {
    return (
      <GlassCard glow className="h-full flex items-center justify-center">
        <div
          className="text-[12px]"
          style={{ color: 'var(--text-muted)' }}
        >
          选择一个缺陷查看详情
        </div>
      </GlassCard>
    );
  }

  const handleProcess = async () => {
    const res = await processDefect({ id: defect.id });
    if (res.success && res.data) {
      updateDefectInList(res.data.defect);
      toast.success('已开始处理');
      loadStats();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleResolve = async () => {
    const res = await resolveDefect({ id: defect.id });
    if (res.success && res.data) {
      updateDefectInList(res.data.defect);
      toast.success('已标记为解决');
      loadStats();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleReject = async () => {
    const res = await rejectDefect({ id: defect.id, reason: '无法复现' });
    if (res.success && res.data) {
      updateDefectInList(res.data.defect);
      toast.success('已驳回');
      loadStats();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleClose = async () => {
    const res = await closeDefect({ id: defect.id });
    if (res.success && res.data) {
      updateDefectInList(res.data.defect);
      toast.success('已关闭');
      loadStats();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  // Determine available actions based on status
  const canProcess = defect.status === DefectStatus.Pending;
  const canResolve = defect.status === DefectStatus.Working;
  const canReject =
    defect.status === DefectStatus.Pending ||
    defect.status === DefectStatus.Working;
  const canClose =
    defect.status === DefectStatus.Resolved ||
    defect.status === DefectStatus.Rejected;

  return (
    <GlassCard glow className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 border-b flex-shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-mono px-1.5 py-0.5 rounded"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: 'var(--text-muted)',
            }}
          >
            {defect.defectNo}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              background: 'rgba(214,178,106,0.15)',
              color: 'rgba(214,178,106,0.9)',
            }}
          >
            {statusLabels[defect.status] || defect.status}
          </span>
        </div>
        <button
          onClick={() => setSelectedDefectId(null)}
          className="p-1 rounded hover:bg-white/10 transition-colors"
        >
          <X size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {/* Title */}
        <div>
          <div
            className="text-[10px] mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            标题
          </div>
          <div
            className="text-[13px] font-medium"
            style={{ color: 'var(--text-primary)' }}
          >
            {defect.title || defect.rawContent?.slice(0, 50) || '无标题'}
          </div>
        </div>

        {/* Meta */}
        <div className="flex items-center gap-4 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span style={{ color: 'var(--text-muted)' }}>严重程度:</span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {severityLabels[defect.severity] || defect.severity}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span style={{ color: 'var(--text-muted)' }}>
              {defect.reporterName}
            </span>
            <ArrowRight size={10} style={{ color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              {defect.assigneeName || '未指派'}
            </span>
          </div>
        </div>

        {/* Description */}
        <div>
          <div
            className="text-[10px] mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            描述
          </div>
          <div
            className="text-[12px] whitespace-pre-wrap p-2 rounded"
            style={{
              background: 'rgba(255,255,255,0.03)',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {defect.rawContent || '(无描述)'}
          </div>
        </div>

        {/* Attachments */}
        {defect.attachments && defect.attachments.length > 0 && (
          <div>
            <div
              className="text-[10px] mb-1 flex items-center gap-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <Paperclip size={10} />
              附件 ({defect.attachments.length})
            </div>
            <div className="flex flex-wrap gap-2">
              {defect.attachments.map((att) => (
                <a
                  key={att.id}
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] hover:bg-white/10 transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <Paperclip size={10} />
                  <span className="max-w-[120px] truncate">{att.fileName}</span>
                  <ExternalLink size={10} />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div className="text-[10px] space-y-1" style={{ color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-1.5">
            <Clock size={10} />
            创建: {formatDateTime(defect.createdAt)}
          </div>
          {defect.resolvedAt && (
            <div className="flex items-center gap-1.5">
              <CheckCircle size={10} />
              解决: {formatDateTime(defect.resolvedAt)}
            </div>
          )}
          {defect.closedAt && (
            <div className="flex items-center gap-1.5">
              <Archive size={10} />
              关闭: {formatDateTime(defect.closedAt)}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {(canProcess || canResolve || canReject || canClose) && (
        <div
          className="px-3 py-2.5 border-t flex flex-wrap gap-2 flex-shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          {canProcess && (
            <Button variant="secondary" size="sm" onClick={handleProcess}>
              <Play size={12} />
              开始处理
            </Button>
          )}
          {canResolve && (
            <Button variant="primary" size="sm" onClick={handleResolve}>
              <CheckCircle size={12} />
              已解决
            </Button>
          )}
          {canReject && (
            <Button variant="secondary" size="sm" onClick={handleReject}>
              <XCircle size={12} />
              驳回
            </Button>
          )}
          {canClose && (
            <Button variant="secondary" size="sm" onClick={handleClose}>
              <Archive size={12} />
              关闭
            </Button>
          )}
        </div>
      )}
    </GlassCard>
  );
}
