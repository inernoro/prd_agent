import { useMemo, useState } from 'react';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import {
  deleteDefect,
  processDefect,
  resolveDefect,
  rejectDefect,
  closeDefect,
  sendDefectMessage,
} from '@/services';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import type { DefectAttachment } from '@/services/contracts/defectAgent';
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
  Trash2,
  Bug,
  Image as ImageIcon,
  FileText,
  Send,
  User,
} from 'lucide-react';

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

function formatDateTime(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function isImageAttachment(att: DefectAttachment): boolean {
  return att.mimeType?.startsWith('image/') || false;
}

export function DefectDetailPanel() {
  const {
    defects,
    selectedDefectId,
    setSelectedDefectId,
    updateDefectInList,
    removeDefectFromList,
    loadStats,
  } = useDefectStore();

  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [comment, setComment] = useState('');
  const [sendingComment, setSendingComment] = useState(false);

  const defect = useMemo(
    () => defects.find((d) => d.id === selectedDefectId),
    [defects, selectedDefectId]
  );

  if (!defect) return null;

  const handleClose = () => setSelectedDefectId(null);

  const handleDeleteClick = () => {
    setConfirmingDelete(true);
  };

  const handleDeleteConfirm = async () => {
    const res = await deleteDefect({ id: defect.id });
    if (res.success) {
      removeDefectFromList(defect.id);
      setSelectedDefectId(null);
      toast.success('已移入回收站');
      loadStats();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
    setConfirmingDelete(false);
  };

  const handleDeleteCancel = () => {
    setConfirmingDelete(false);
  };

  const handleSendComment = async () => {
    if (!comment.trim()) return;
    setSendingComment(true);
    try {
      const res = await sendDefectMessage({ id: defect.id, content: comment.trim() });
      if (res.success) {
        setComment('');
        toast.success('评论已发送');
      } else {
        toast.error(res.error?.message || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    } finally {
      setSendingComment(false);
    }
  };

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
    const reason = await systemDialog.prompt({
      title: '驳回缺陷',
      message: '请输入驳回原因：',
      placeholder: '如：无法复现、信息不足等',
      confirmText: '驳回',
      cancelText: '取消',
    });
    if (!reason) return;

    const res = await rejectDefect({ id: defect.id, reason });
    if (res.success && res.data) {
      updateDefectInList(res.data.defect);
      toast.success('已驳回');
      loadStats();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleCloseDefect = async () => {
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
  const canDelete = defect.status === DefectStatus.Draft;
  const canProcess = defect.status === DefectStatus.Pending;
  const canResolve = defect.status === DefectStatus.Working;
  const canReject =
    defect.status === DefectStatus.Pending ||
    defect.status === DefectStatus.Working;
  const canCloseDefect =
    defect.status === DefectStatus.Resolved ||
    defect.status === DefectStatus.Rejected;

  const statusLabel = statusLabels[defect.status] || defect.status;
  const statusColor = statusColors[defect.status] || 'var(--text-muted)';
  const severityLabel = severityLabels[defect.severity] || defect.severity;
  const severityColor = severityColors[defect.severity] || 'var(--text-muted)';

  // 分离图片和其他附件
  const imageAttachments = (defect.attachments || []).filter(isImageAttachment);
  const otherAttachments = (defect.attachments || []).filter((att) => !isImageAttachment(att));

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0, 0, 0, 0.5)' }}
        onClick={handleClose}
      />

      {/* 弹窗内容 - 液态玻璃样式 */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[600px] max-h-[85vh] overflow-hidden rounded-2xl flex flex-col"
        style={{
          background:
            'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
          backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
          border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
          boxShadow:
            '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <div className="flex items-center gap-3">
            <Bug size={18} style={{ color: 'var(--accent-primary)' }} />
            <span
              className="text-[12px] font-mono px-2 py-1 rounded"
              style={{
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text-muted)',
              }}
            >
              {defect.defectNo}
            </span>
            <span
              className="text-[11px] px-2 py-1 rounded"
              style={{ background: `${statusColor}20`, color: statusColor }}
            >
              {statusLabel}
            </span>
            <div
              className="w-px h-4 mx-1"
              style={{ background: 'rgba(255,255,255,0.1)' }}
            />
            {/* 提交人 → 被指派人 */}
            <div className="flex items-center gap-2">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(100,180,255,0.2)' }}
              >
                <User size={12} style={{ color: 'rgba(100,180,255,0.9)' }} />
              </div>
              <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {defect.reporterName || '未知'}
              </span>
              <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} />
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(255,180,70,0.2)' }}
              >
                <User size={12} style={{ color: 'rgba(255,180,70,0.9)' }} />
              </div>
              <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>
                {defect.assigneeName || '未指派'}
              </span>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <div
              className="text-[16px] font-semibold leading-relaxed"
              style={{ color: 'var(--text-primary)' }}
            >
              {defect.title || '无标题'}
            </div>
          </div>

          {/* Meta Info */}
          <div
            className="flex flex-wrap items-center gap-4 text-[12px] p-3 rounded-xl"
            style={{ background: 'rgba(255,255,255,0.03)' }}
          >
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--text-muted)' }}>严重程度</span>
              <span
                className="px-2 py-0.5 rounded"
                style={{ background: `${severityColor}20`, color: severityColor }}
              >
                {severityLabel}
              </span>
            </div>
            <div
              className="w-px h-4"
              style={{ background: 'rgba(255,255,255,0.1)' }}
            />
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--text-muted)' }}>提交人</span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {defect.reporterName || '未知'}
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <div
              className="text-[11px] mb-2 font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              问题描述
            </div>
            <div
              className="text-[13px] leading-relaxed whitespace-pre-wrap p-4 rounded-xl overflow-y-auto"
              style={{
                background: 'rgba(255,255,255,0.03)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.06)',
                minHeight: '120px',
                maxHeight: '200px',
              }}
            >
              {defect.rawContent || '(无描述)'}
            </div>
          </div>

          {/* 截图/图片附件 - 横向滚动列表 */}
          {imageAttachments.length > 0 && (
            <div>
              <div
                className="text-[11px] mb-2 font-medium flex items-center gap-1.5"
                style={{ color: 'var(--text-muted)' }}
              >
                <ImageIcon size={12} />
                截图 ({imageAttachments.length})
              </div>
              <div
                className="flex gap-2 overflow-x-auto pb-2"
                style={{
                  scrollbarWidth: 'thin',
                  scrollbarColor: 'rgba(255,255,255,0.2) transparent',
                }}
              >
                {imageAttachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex-shrink-0 w-[120px] h-[80px] rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-white/30 transition-all"
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                    onClick={() => att.url && setLightboxImage(att.url)}
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
                        <ImageIcon size={24} style={{ color: 'var(--text-muted)' }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 其他附件 */}
          {otherAttachments.length > 0 && (
            <div>
              <div
                className="text-[11px] mb-2 font-medium flex items-center gap-1.5"
                style={{ color: 'var(--text-muted)' }}
              >
                <Paperclip size={12} />
                附件 ({otherAttachments.length})
              </div>
              <div className="flex flex-wrap gap-2">
                {otherAttachments.map((att) => (
                  <a
                    key={att.id}
                    href={att.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] hover:bg-white/10 transition-colors"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      color: 'var(--text-secondary)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <FileText size={12} />
                    <span className="max-w-[150px] truncate">{att.fileName}</span>
                    <ExternalLink size={12} style={{ opacity: 0.6 }} />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Resolution / Reject Reason */}
          {defect.resolution && (
            <div>
              <div
                className="text-[11px] mb-2 font-medium"
                style={{ color: 'rgba(100,200,120,0.9)' }}
              >
                解决说明
              </div>
              <div
                className="text-[12px] p-3 rounded-lg"
                style={{
                  background: 'rgba(100,200,120,0.1)',
                  color: 'var(--text-secondary)',
                }}
              >
                {defect.resolution}
              </div>
            </div>
          )}

          {defect.rejectReason && (
            <div>
              <div
                className="text-[11px] mb-2 font-medium"
                style={{ color: 'rgba(255,100,100,0.9)' }}
              >
                驳回原因
              </div>
              <div
                className="text-[12px] p-3 rounded-lg"
                style={{
                  background: 'rgba(255,100,100,0.1)',
                  color: 'var(--text-secondary)',
                }}
              >
                {defect.rejectReason}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div
            className="text-[11px] space-y-1.5 pt-2"
            style={{ color: 'var(--text-muted)' }}
          >
            <div className="flex items-center gap-2">
              <Clock size={12} />
              <span>创建于 {formatDateTime(defect.createdAt)}</span>
            </div>
            {defect.resolvedAt && (
              <div className="flex items-center gap-2">
                <CheckCircle size={12} style={{ color: 'rgba(100,200,120,0.9)' }} />
                <span>解决于 {formatDateTime(defect.resolvedAt)}</span>
              </div>
            )}
            {defect.closedAt && (
              <div className="flex items-center gap-2">
                <Archive size={12} />
                <span>关闭于 {formatDateTime(defect.closedAt)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Comment Input - 非草稿状态显示 */}
        {defect.status !== DefectStatus.Draft && (
          <div
            className="px-5 py-3 flex-shrink-0"
            style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}
          >
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && comment.trim()) {
                    e.preventDefault();
                    handleSendComment();
                  }
                }}
                placeholder="添加评论..."
                className="flex-1 bg-transparent outline-none text-[13px]"
                style={{ color: 'var(--text-primary)' }}
                disabled={sendingComment}
              />
              <button
                onClick={handleSendComment}
                disabled={!comment.trim() || sendingComment}
                className="p-1.5 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-40"
              >
                <Send size={14} style={{ color: 'var(--accent-primary)' }} />
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div
          className="px-5 py-4 flex items-center justify-between flex-shrink-0"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          {/* Left: Delete */}
          <div className="flex items-center gap-2">
            {canDelete && !confirmingDelete && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDeleteClick}
                className="text-red-400 hover:text-red-300"
              >
                <Trash2 size={14} />
                删除
              </Button>
            )}
            {canDelete && confirmingDelete && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDeleteCancel}
                >
                  取消
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDeleteConfirm}
                  className="text-red-400 hover:text-red-300 border-red-500/30"
                >
                  确认删除
                </Button>
              </>
            )}
          </div>

          {/* Right: Status Actions */}
          <div className="flex items-center gap-2">
            {canProcess && (
              <Button variant="primary" size="sm" onClick={handleProcess}>
                <Play size={14} />
                开始处理
              </Button>
            )}
            {canResolve && (
              <Button variant="primary" size="sm" onClick={handleResolve}>
                <CheckCircle size={14} />
                标记解决
              </Button>
            )}
            {canReject && (
              <Button variant="secondary" size="sm" onClick={handleReject}>
                <XCircle size={14} />
                驳回
              </Button>
            )}
            {canCloseDefect && (
              <Button variant="secondary" size="sm" onClick={handleCloseDefect}>
                <Archive size={14} />
                关闭
              </Button>
            )}
            {!canProcess && !canResolve && !canReject && !canCloseDefect && !canDelete && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                无可用操作
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-8"
          style={{ background: 'rgba(0,0,0,0.9)' }}
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
