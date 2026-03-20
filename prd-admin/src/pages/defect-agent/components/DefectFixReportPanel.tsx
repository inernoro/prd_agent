import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import { listDefectFixReports, acceptDefectFixItem, rejectDefectFixItem } from '@/services';
import { toast } from '@/lib/toast';
import { glassPanel } from '@/lib/glassStyles';
import type { DefectFixReport, DefectFixReportItem } from '@/services/contracts/defectAgent';

interface DefectFixReportPanelProps {
  open: boolean;
  onClose: () => void;
  shareId: string;
  shareTitle?: string;
}

export function DefectFixReportPanel({ open, onClose, shareId, shareTitle }: DefectFixReportPanelProps) {
  const [reports, setReports] = useState<DefectFixReport[]>([]);
  const [loading, setLoading] = useState(true);

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDefectFixReports({ shareId });
      if (res.success && res.data) setReports(res.data.items);
    } catch { /* ignore */ }
    setLoading(false);
  }, [shareId]);

  useEffect(() => {
    if (open) loadReports();
  }, [open, loadReports]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={shareTitle ? `分析报告 — ${shareTitle}` : '分析报告'}
      maxWidth={720}
      content={
        <div className="mt-2 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {loading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</p>}
          {!loading && reports.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无分析报告</p>
          )}
          {reports.map((report) => (
            <ReportCard key={report.id} report={report} onUpdate={loadReports} />
          ))}
        </div>
      }
    />
  );
}

function ReportCard({ report, onUpdate }: { report: DefectFixReport; onUpdate: () => void }) {
  const statusLabel = report.status === 'completed' ? '已完成' : report.status === 'partial' ? '部分审核' : '待审核';
  const statusColor = report.status === 'completed'
    ? 'rgba(120,220,180,0.9)'
    : report.status === 'partial'
      ? 'rgba(255,200,60,0.9)'
      : 'var(--text-muted)';

  return (
    <div className="rounded-xl p-4 space-y-3" style={glassPanel}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {report.agentName || '未知 Agent'}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {new Date(report.createdAt).toLocaleString()}
          </span>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: statusColor, border: `1px solid ${statusColor}` }}>
          {statusLabel}
        </span>
      </div>

      {report.items.map((item) => (
        <ReportItemRow key={item.defectId} item={item} reportId={report.id} onUpdate={onUpdate} />
      ))}
    </div>
  );
}

function ReportItemRow({ item, reportId, onUpdate }: { item: DefectFixReportItem; reportId: string; onUpdate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [markResolved, setMarkResolved] = useState(false);
  const [acting, setActing] = useState(false);

  const scoreColor = item.confidenceScore >= 80
    ? 'rgba(120,220,180,0.9)'
    : item.confidenceScore >= 50
      ? 'rgba(255,200,60,0.9)'
      : 'rgba(255,100,100,0.9)';

  const handleAccept = async () => {
    setActing(true);
    try {
      const res = await acceptDefectFixItem({ reportId, defectId: item.defectId, reviewNote: reviewNote || undefined, markResolved });
      if (res.success) {
        toast.success('已接受');
        onUpdate();
      } else {
        toast.error(res.error?.message || '操作失败');
      }
    } catch { toast.error('操作失败'); }
    setActing(false);
  };

  const handleReject = async () => {
    setActing(true);
    try {
      const res = await rejectDefectFixItem({ reportId, defectId: item.defectId, reviewNote: reviewNote || undefined });
      if (res.success) {
        toast.success('已拒绝');
        onUpdate();
      } else {
        toast.error(res.error?.message || '操作失败');
      }
    } catch { toast.error('操作失败'); }
    setActing(false);
  };

  const isReviewed = item.acceptStatus !== 'pending';

  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{item.defectNo}</span>
          <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{item.defectTitle}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Confidence score bar */}
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div className="h-full rounded-full" style={{ width: `${item.confidenceScore}%`, background: scoreColor }} />
            </div>
            <span className="text-xs font-medium" style={{ color: scoreColor }}>{item.confidenceScore}%</span>
          </div>

          {isReviewed && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                color: item.acceptStatus === 'accepted' ? 'rgba(120,220,180,0.9)' : 'rgba(255,100,100,0.9)',
                background: item.acceptStatus === 'accepted' ? 'rgba(120,220,180,0.1)' : 'rgba(255,100,100,0.1)',
              }}
            >
              {item.acceptStatus === 'accepted' ? '已接受' : '已拒绝'}
            </span>
          )}

          <button type="button" onClick={() => setExpanded(!expanded)} className="p-0.5">
            {expanded ? <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 pt-1">
          {item.analysis && (
            <div>
              <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>分析</p>
              <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{item.analysis}</p>
            </div>
          )}
          {item.fixSuggestion && (
            <div>
              <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>修复建议</p>
              <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{item.fixSuggestion}</p>
            </div>
          )}

          {isReviewed && item.reviewNote && (
            <div>
              <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>审核备注</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {item.reviewedByName}: {item.reviewNote}
              </p>
            </div>
          )}

          {!isReviewed && (
            <div className="space-y-2 pt-1">
              <input
                placeholder="审核备注（可选）"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                className="w-full h-8 rounded-lg px-3 text-sm"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={markResolved}
                    onChange={(e) => setMarkResolved(e.target.checked)}
                    className="rounded"
                  />
                  同时标记缺陷为已解决
                </label>
                <div className="flex gap-2">
                  <Button variant="danger" size="xs" onClick={handleReject} disabled={acting}>
                    <X size={12} /> 拒绝
                  </Button>
                  <Button variant="primary" size="xs" onClick={handleAccept} disabled={acting}>
                    <Check size={12} /> 接受
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
