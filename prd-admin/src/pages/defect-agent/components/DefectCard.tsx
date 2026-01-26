import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import { deleteDefect } from '@/services';
import { toast } from '@/lib/toast';
import type { DefectReport, DefectAttachment } from '@/services/contracts/defectAgent';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import { Bug, ArrowRight, Clock, Eye, Trash2, Image as ImageIcon, X } from 'lucide-react';

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

function getPreviewText(content: string | undefined | null, maxChars = 100) {
  const raw = String(content ?? '').trim();
  if (!raw) return '(暂无描述)';
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars) + '...';
}

function isImageAttachment(att: DefectAttachment): boolean {
  return att.mimeType?.startsWith('image/') || false;
}

export function DefectCard({ defect }: DefectCardProps) {
  const { selectedDefectId, setSelectedDefectId, removeDefectFromList, loadStats } = useDefectStore();
  const [deleting, setDeleting] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const isSelected = selectedDefectId === defect.id;
  const title = defect.title || '无标题';
  const statusLabel = statusLabels[defect.status] || defect.status;
  const statusColor = statusColors[defect.status] || 'var(--text-muted)';
  const severityLabel = severityLabels[defect.severity] || defect.severity;
  const severityColor = severityColors[defect.severity] || 'var(--text-muted)';

  // Get image attachments for thumbnails
  const imageAttachments = (defect.attachments || []).filter(isImageAttachment);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定要删除此缺陷吗？此操作不可撤销。')) return;

    setDeleting(true);
    try {
      const res = await deleteDefect({ id: defect.id });
      if (res.success) {
        removeDefectFromList(defect.id);
        loadStats();
        toast.success('缺陷已删除');
      } else {
        toast.error(res.error?.message || '删除失败');
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(false);
    }
  };

  const handleImageClick = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    setLightboxImage(url);
  };

  return (
    <>
      <GlassCard glow={isSelected} className="p-0 overflow-hidden">
        <div
          role="button"
          tabIndex={0}
          title={title}
          className={[
            'group relative cursor-pointer select-none',
            'transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15',
            'flex flex-col h-full',
          ].join(' ')}
          onClick={() => setSelectedDefectId(isSelected ? null : defect.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSelectedDefectId(isSelected ? null : defect.id);
            }
          }}
        >
          {/* Header: DefectNo + Title */}
          <div className="p-3 pb-2 flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Bug size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-muted)',
                }}
              >
                {defect.defectNo}
              </span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                style={{ background: `${severityColor}20`, color: severityColor }}
              >
                {severityLabel}
              </span>
              {imageAttachments.length > 0 && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
                  style={{ background: 'rgba(100,180,255,0.15)', color: 'rgba(100,180,255,0.9)' }}
                >
                  <ImageIcon size={10} />
                  {imageAttachments.length}
                </span>
              )}
            </div>
            <div
              className="font-medium text-[13px] truncate mt-2"
              style={{ color: 'var(--text-primary)' }}
            >
              {title}
            </div>
          </div>

          {/* Content Preview */}
          <div className="px-3 pb-3 flex-1 min-h-0 overflow-hidden">
            <div
              className="h-full overflow-hidden border rounded-lg text-[11px] flex flex-col"
              style={{ borderColor: 'var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
            >
              {/* Image Thumbnails (if any) */}
              {imageAttachments.length > 0 && (
                <div
                  className="px-2 py-2 border-b flex gap-1.5 overflow-x-auto"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  {imageAttachments.slice(0, 4).map((att) => (
                    <div
                      key={att.id}
                      className="w-12 h-12 rounded-md overflow-hidden flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-white/30 transition-all"
                      style={{
                        background: 'rgba(0,0,0,0.3)',
                        border: '1px solid rgba(255,255,255,0.1)',
                      }}
                      onClick={(e) => att.url && handleImageClick(e, att.url)}
                      title="点击查看大图"
                    >
                      {att.url ? (
                        <img
                          src={att.url}
                          alt={att.fileName}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon size={16} style={{ color: 'var(--text-muted)' }} />
                        </div>
                      )}
                    </div>
                  ))}
                  {imageAttachments.length > 4 && (
                    <div
                      className="w-12 h-12 rounded-md flex-shrink-0 flex items-center justify-center text-[10px]"
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      +{imageAttachments.length - 4}
                    </div>
                  )}
                </div>
              )}

              {/* Preview Text */}
              <div
                className="p-2 flex-1 overflow-hidden line-clamp-2"
                style={{ color: 'var(--text-secondary)' }}
              >
                {getPreviewText(defect.rawContent)}
              </div>

              {/* Footer: Reporter -> Assignee + Actions */}
              <div
                className="px-2 py-1.5 text-[10px] border-t flex items-center"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
              >
                {/* Action buttons (visible on hover) */}
                <div
                  className={[
                    'flex items-center gap-1',
                    'opacity-0 pointer-events-none transition-opacity duration-100',
                    'group-hover:opacity-100 group-hover:pointer-events-auto',
                  ].join(' ')}
                >
                  <Button
                    size="xs"
                    variant="secondary"
                    className="h-5 w-5 p-0 rounded-md gap-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedDefectId(defect.id);
                    }}
                    title="查看详情"
                  >
                    <Eye size={10} />
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    className="h-5 w-5 p-0 rounded-md gap-0 hover:!bg-red-500/20"
                    onClick={handleDelete}
                    disabled={deleting}
                    title="删除缺陷"
                    style={{ color: 'rgba(255,100,100,0.9)' }}
                  >
                    <Trash2 size={10} />
                  </Button>
                </div>

                {/* Reporter -> Assignee */}
                <div className="flex-1 text-right truncate flex items-center justify-end gap-1">
                  <span className="truncate max-w-[60px]">{defect.reporterName || '未知'}</span>
                  <ArrowRight size={10} className="flex-shrink-0" />
                  <span className="truncate max-w-[60px]">{defect.assigneeName || '未指派'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom bar: Status + Time */}
          <div
            className="px-3 py-2 flex items-center justify-between border-t"
            style={{ borderColor: 'rgba(255,255,255,0.06)' }}
          >
            <span
              className="text-[10px] px-2 py-0.5 rounded-md"
              style={{ background: `${statusColor}20`, color: statusColor }}
            >
              {statusLabel}
            </span>
            <span
              className="text-[10px] flex items-center gap-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <Clock size={10} />
              {formatDate(defect.createdAt)}
            </span>
          </div>
        </div>
      </GlassCard>

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-8"
          style={{
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
          onClick={() => setLightboxImage(null)}
        >
          <button
            className="absolute top-4 right-4 p-2 rounded-lg hover:bg-white/10 transition-colors"
            onClick={() => setLightboxImage(null)}
          >
            <X size={24} style={{ color: '#fff' }} />
          </button>
          <img
            src={lightboxImage}
            alt="放大图片"
            className="max-w-full max-h-full object-contain rounded-lg"
            style={{
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
