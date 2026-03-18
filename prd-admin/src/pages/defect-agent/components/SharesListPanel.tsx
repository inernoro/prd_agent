import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Eye, Trash2, FileText } from 'lucide-react';
import { listDefectShares, revokeDefectShare } from '@/services';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { glassPanel } from '@/lib/glassStyles';
import { DefectFixReportPanel } from './DefectFixReportPanel';
import type { DefectShareLink } from '@/services/contracts/defectAgent';

interface SharesListPanelProps {
  open: boolean;
  onClose: () => void;
  /** 自动打开某个 share 的报告 (从通知跳转) */
  autoOpenShareId?: string;
}

export function SharesListPanel({ open, onClose, autoOpenShareId }: SharesListPanelProps) {
  const [shares, setShares] = useState<DefectShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportShareId, setReportShareId] = useState<string | null>(null);
  const [reportShareTitle, setReportShareTitle] = useState<string | undefined>(undefined);

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDefectShares();
      if (res.success && res.data) setShares(res.data.items);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) loadShares();
  }, [open, loadShares]);

  // Auto-open report panel from notification
  useEffect(() => {
    if (autoOpenShareId && shares.length > 0) {
      const share = shares.find((s) => s.id === autoOpenShareId);
      if (share) {
        setReportShareId(share.id);
        setReportShareTitle(share.title ?? undefined);
      }
    }
  }, [autoOpenShareId, shares]);

  const handleRevoke = async (share: DefectShareLink) => {
    const confirmed = await systemDialog.confirm('确定要撤销此分享链接吗？撤销后外部 Agent 将无法访问。');
    if (!confirmed) return;

    try {
      const res = await revokeDefectShare({ id: share.id });
      if (res.success) {
        toast.success('已撤销');
        loadShares();
      } else {
        toast.error(res.error?.message || '撤销失败');
      }
    } catch { toast.error('撤销失败'); }
  };

  const handleCopy = (token: string) => {
    const url = `${window.location.origin}/api/defect-agent/share/view/${token}`;
    navigator.clipboard.writeText(url).catch(() => {});
    toast.success('链接已复制');
  };

  const scopeLabel = (s: DefectShareLink) => {
    if (s.shareScope === 'single') return '单个缺陷';
    if (s.shareScope === 'project') return `项目: ${s.projectName || '未知'}`;
    return `已选 ${s.defectIds.length} 个`;
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => !v && onClose()}
        title="分享管理"
        maxWidth={640}
        content={
          <div className="mt-2 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {loading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</p>}
            {!loading && shares.length === 0 && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无分享记录</p>
            )}
            {shares.map((share) => {
              const isExpired = share.isExpired || new Date(share.expiresAt) < new Date();
              const dimmed = isExpired || share.isRevoked;

              return (
                <div
                  key={share.id}
                  className="rounded-xl p-3 flex items-center gap-3"
                  style={{ ...glassPanel, opacity: dimmed ? 0.5 : 1 }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {share.title || '未命名分享'}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{scopeLabel(share)}</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {new Date(share.createdAt).toLocaleDateString()}
                      </span>
                      <span className="text-xs flex items-center gap-0.5" style={{ color: 'var(--text-muted)' }}>
                        <Eye size={10} /> {share.viewCount}
                      </span>
                      {(share.reportCount ?? 0) > 0 && (
                        <span className="text-xs flex items-center gap-0.5" style={{ color: 'rgba(120,220,180,0.9)' }}>
                          <FileText size={10} /> {share.reportCount} 报告
                        </span>
                      )}
                      {isExpired && (
                        <span className="text-xs" style={{ color: 'rgba(255,100,100,0.8)' }}>已过期</span>
                      )}
                      {share.isRevoked && (
                        <span className="text-xs" style={{ color: 'rgba(255,100,100,0.8)' }}>已撤销</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {(share.reportCount ?? 0) > 0 && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => { setReportShareId(share.id); setReportShareTitle(share.title ?? undefined); }}
                      >
                        查看报告
                      </Button>
                    )}
                    {!dimmed && (
                      <>
                        <Button variant="ghost" size="xs" onClick={() => handleCopy(share.token)}>
                          <Copy size={12} />
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => handleRevoke(share)} className="text-red-400">
                          <Trash2 size={12} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        }
      />

      {reportShareId && (
        <DefectFixReportPanel
          open={!!reportShareId}
          onClose={() => { setReportShareId(null); setReportShareTitle(undefined); }}
          shareId={reportShareId}
          shareTitle={reportShareTitle}
        />
      )}
    </>
  );
}
