import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import { deleteDefect } from '@/services';
import { toast } from '@/lib/toast';
import type { DefectReport, DefectAttachment } from '@/services/contracts/defectAgent';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import { ArrowRight, Clock, Eye, Trash2, Image as ImageIcon, X, AlertTriangle, AlertCircle, Info, MinusCircle } from 'lucide-react';

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

const severityConfig: Record<string, { label: string; color: string; bgColor: string; icon: typeof AlertTriangle }> = {
  [DefectSeverity.Critical]: {
    label: '致命',
    color: '#ef4444',
    bgColor: 'rgba(239,68,68,0.15)',
    icon: AlertTriangle,
  },
  [DefectSeverity.Major]: {
    label: '严重',
    color: '#f97316',
    bgColor: 'rgba(249,115,22,0.15)',
    icon: AlertCircle,
  },
  [DefectSeverity.Minor]: {
    label: '一般',
    color: '#eab308',
    bgColor: 'rgba(234,179,8,0.15)',
    icon: Info,
  },
  [DefectSeverity.Trivial]: {
    label: '轻微',
    color: '#22c55e',
    bgColor: 'rgba(34,197,94,0.15)',
    icon: MinusCircle,
  },
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

function getPreviewText(content: string | undefined | null, maxChars = 80) {
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

  const severity = severityConfig[defect.severity] || severityConfig[DefectSeverity.Minor];
  const SeverityIcon = severity.icon;

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
            'flex h-full',
          ].join(' ')}
          onClick={() => setSelectedDefectId(isSelected ? null : defect.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSelectedDefectId(isSelected ? null : defect.id);
            }
          }}
        >
          {/* 左侧严重性颜色条 */}
          <div
            className="w-1.5 flex-shrink-0"
            style={{ background: severity.color }}
          />

          {/* 主内容区 */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Header: 严重性 + 状态 + 编号 */}
            <div className="px-3 pt-3 pb-2 flex items-center gap-2">
              {/* 严重性标签 */}
              <div
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium"
                style={{ background: severity.bgColor, color: severity.color }}
              >
                <SeverityIcon size={12} />
                {severity.label}
              </div>

              {/* 状态标签 */}
              <span
                className="text-[10px] px-2 py-0.5 rounded"
                style={{ background: `${statusColor}20`, color: statusColor }}
              >
                {statusLabel}
              </span>

              {/* 缺陷编号 */}
              <span
                className="text-[10px] font-mono ml-auto"
                style={{ color: 'var(--text-muted)' }}
              >
                {defect.defectNo}
              </span>
            </div>

            {/* 标题 */}
            <div className="px-3 pb-2">
              <div
                className="font-medium text-[14px] leading-snug line-clamp-2"
                style={{ color: 'var(--text-primary)' }}
              >
                {title}
              </div>
            </div>

            {/* 描述预览 */}
            <div className="px-3 pb-2 flex-1 min-h-0">
              <div
                className="text-[12px] line-clamp-2"
                style={{ color: 'var(--text-secondary)' }}
              >
                {getPreviewText(defect.rawContent)}
              </div>
            </div>

            {/* 图片缩略图 */}
            {imageAttachments.length > 0 && (
              <div className="px-3 pb-2 flex gap-1.5">
                {imageAttachments.slice(0, 3).map((att) => (
                  <div
                    key={att.id}
                    className="w-10 h-10 rounded overflow-hidden flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-white/30 transition-all"
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
                        <ImageIcon size={14} style={{ color: 'var(--text-muted)' }} />
                      </div>
                    )}
                  </div>
                ))}
                {imageAttachments.length > 3 && (
                  <div
                    className="w-10 h-10 rounded flex-shrink-0 flex items-center justify-center text-[10px]"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    +{imageAttachments.length - 3}
                  </div>
                )}
              </div>
            )}

            {/* 底部：人员 + 时间 + 操作 */}
            <div
              className="px-3 py-2 flex items-center border-t text-[11px]"
              style={{ borderColor: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
            >
              {/* 操作按钮（悬浮显示） */}
              <div
                className={[
                  'flex items-center gap-1 mr-2',
                  'opacity-0 pointer-events-none transition-opacity duration-100',
                  'group-hover:opacity-100 group-hover:pointer-events-auto',
                ].join(' ')}
              >
                <Button
                  size="xs"
                  variant="secondary"
                  className="h-5 w-5 p-0 rounded gap-0"
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
                  className="h-5 w-5 p-0 rounded gap-0 hover:!bg-red-500/20"
                  onClick={handleDelete}
                  disabled={deleting}
                  title="删除缺陷"
                  style={{ color: 'rgba(255,100,100,0.9)' }}
                >
                  <Trash2 size={10} />
                </Button>
              </div>

              {/* 人员信息 */}
              <div className="flex items-center gap-1 flex-1 min-w-0">
                <span className="truncate max-w-[50px]">{defect.reporterName || '未知'}</span>
                <ArrowRight size={10} className="flex-shrink-0 opacity-50" />
                <span className="truncate max-w-[50px]">{defect.assigneeName || '未指派'}</span>
              </div>

              {/* 时间 */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <Clock size={10} />
                {formatDate(defect.createdAt)}
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-8"
          style={{ background: 'rgba(0,0,0,0.85)' }}
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
            style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
