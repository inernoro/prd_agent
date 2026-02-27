import { useMemo, useState, useEffect, useCallback, useRef, type DragEvent, type ClipboardEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from '@/components/design/Button';
import { glassPanel } from '@/lib/glassStyles';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  deleteDefect,
  processDefect,
  rejectDefect,
  closeDefect,
  sendDefectMessage,
  getDefectMessages,
  addDefectAttachment,
} from '@/services';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { DefectStatus, DefectSeverity, DefectAttachmentType } from '@/services/contracts/defectAgent';
import type { DefectAttachment, DefectMessage } from '@/services/contracts/defectAgent';
import { parseContentToSegments, stripImgTags } from '@/lib/defectContentUtils';
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
  MessageCircle,
  Bot,
} from 'lucide-react';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';

const statusLabels: Record<string, string> = {
  [DefectStatus.Draft]: '草稿',
  [DefectStatus.Pending]: '待处理',
  [DefectStatus.Working]: '处理中',
  [DefectStatus.Resolved]: '已解决',
  [DefectStatus.Rejected]: '已驳回',
};

const statusColors: Record<string, string> = {
  [DefectStatus.Draft]: 'rgba(150,150,150,0.9)',
  [DefectStatus.Pending]: 'rgba(255,180,70,0.9)',
  [DefectStatus.Working]: 'rgba(100,180,255,0.9)',
  [DefectStatus.Resolved]: 'rgba(100,200,120,0.9)',
  [DefectStatus.Rejected]: 'rgba(255,100,100,0.9)',
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

function formatMsgTimestamp(ts: string | null | undefined) {
  const s = String(ts ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const sec = pad2(d.getSeconds());
  return `${y}.${mo}.${day} ${h}:${mi}:${sec}`;
}

function isImageAttachment(att: DefectAttachment): boolean {
  return att.mimeType?.startsWith('image/') || false;
}

function isLogAttachment(att: DefectAttachment): boolean {
  return att.type === DefectAttachmentType.LogRequest || att.type === DefectAttachmentType.LogError;
}

export function DefectDetailPanel() {
  const {
    defects,
    selectedDefectId,
    setSelectedDefectId,
    updateDefectInList,
    removeDefectFromList,
    loadDefects,
    loadStats,
  } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const { isMobile } = useBreakpoint();

  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [comment, setComment] = useState('');
  const [commentFocused, setCommentFocused] = useState(false);
  const [sendingComment, setSendingComment] = useState(false);
  const [messages, setMessages] = useState<DefectMessage[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<DefectAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [attachmentCache, setAttachmentCache] = useState<Record<string, DefectAttachment>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const defect = useMemo(
    () => defects.find((d) => d.id === selectedDefectId),
    [defects, selectedDefectId]
  );

  const loadMessages = useCallback(async () => {
    if (!selectedDefectId) return;
    const res = await getDefectMessages({ id: selectedDefectId });
    if (res.success && res.data) {
      setMessages(res.data.messages || []);
      if (defect && userId) {
        if (defect.reporterId === userId && defect.reporterUnread) {
          updateDefectInList({ ...defect, reporterUnread: false });
        } else if (defect.assigneeId === userId && defect.assigneeUnread) {
          updateDefectInList({ ...defect, assigneeUnread: false });
        }
      }
    }
  }, [selectedDefectId, defect, userId, updateDefectInList]);

  useEffect(() => {
    if (selectedDefectId) {
      loadMessages();
    } else {
      setMessages([]);
    }
    setPendingAttachments([]);
  }, [selectedDefectId, loadMessages]);

  useEffect(() => {
    if (!defect) {
      setAttachmentCache({});
      return;
    }
    const next: Record<string, DefectAttachment> = {};
    (defect.attachments || []).forEach((att) => {
      next[att.id] = att;
    });
    setAttachmentCache(next);
  }, [defect]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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
    const text = comment.trim();
    if (!text && pendingAttachments.length === 0) return;
    setSendingComment(true);
    try {
      const res = await sendDefectMessage({
        id: defect.id,
        content: text,
        attachmentIds: pendingAttachments.map((att) => att.id),
      });
      if (res.success) {
        setComment('');
        setPendingAttachments([]);
        loadMessages();
        loadDefects();
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
    const confirmed = await systemDialog.confirm({
      title: '完成缺陷',
      message: '确定要将该缺陷标记为已完成吗？',
      confirmText: '确定',
      cancelText: '取消',
    });
    if (!confirmed) return;

    const res = await closeDefect({ id: defect.id });
    if (res.success && res.data) {
      updateDefectInList(res.data.defect);
      toast.success('缺陷已完成');
      loadStats();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  // Determine available actions based on status
  const canDelete = defect.status === DefectStatus.Draft;
  const canProcess = defect.status === DefectStatus.Pending;
  const _statusLabel = statusLabels[defect.status] || defect.status;
  const _statusColor = statusColors[defect.status] || 'var(--text-muted)';
  void _statusLabel; void _statusColor; // 预留给未来使用
  const severityLabel = severityLabels[defect.severity] || defect.severity;
  const severityColor = severityColors[defect.severity] || 'var(--text-muted)';

  // 分离图片、日志和其他附件
  const imageAttachments = (defect.attachments || []).filter(isImageAttachment);
  const logAttachments = (defect.attachments || []).filter(isLogAttachment);
  const otherAttachments = (defect.attachments || []).filter((att) => !isImageAttachment(att) && !isLogAttachment(att));
  const hasScreenshots = imageAttachments.length > 0;
  const hasExtraSections =
    imageAttachments.length > 0 ||
    logAttachments.length > 0 ||
    otherAttachments.length > 0 ||
    Boolean(defect.resolution) ||
    Boolean(defect.rejectReason);

  // 解析内容中的 [IMG] 标签
  const contentSegments = parseContentToSegments(defect.rawContent || '');
  const contentLength = stripImgTags(defect.rawContent || '').trim().length;
  const isShortContent = contentLength > 0 && contentLength <= 120;

  // 是否显示聊天面板（非草稿状态）
  const showChat = defect.status !== DefectStatus.Draft;

  const handlePickAttachments = () => {
    fileInputRef.current?.click();
  };

  const uploadAttachmentFiles = useCallback(
    async (files: File[]) => {
      if (!files || files.length === 0) return;
      setUploadingAttachments(true);
      try {
        const added: DefectAttachment[] = [];
        for (const file of files) {
          const res = await addDefectAttachment({ id: defect.id, file });
          if (res.success && res.data?.attachment) {
            const att = res.data.attachment;
            added.push(att);
            setAttachmentCache((prev) => ({ ...prev, [att.id]: att }));
          } else {
            toast.error(res.error?.message || '附件上传失败');
          }
        }
        if (added.length > 0) {
          setPendingAttachments((prev) => [...prev, ...added]);
        }
      } finally {
        setUploadingAttachments(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [defect.id]
  );

  const handleAttachmentFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await uploadAttachmentFiles(Array.from(files));
  };

  const handleCommentDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (uploadingAttachments) return;
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;
      uploadAttachmentFiles(files);
    },
    [uploadAttachmentFiles, uploadingAttachments]
  );

  const handleCommentDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleCommentPaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      const files: File[] = [];
      for (const item of e.clipboardData.items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        uploadAttachmentFiles(files);
      }
    },
    [uploadAttachmentFiles]
  );

  const handleRemovePendingAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((att) => att.id !== id));
  };

  return (
    <DialogPrimitive.Root open={!!defect} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-100"
          style={{ background: 'rgba(0, 0, 0, 0.5)' }}
        />

        {/* 弹窗内容 - 液态玻璃样式 */}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={
            isMobile
              ? 'fixed inset-0 z-110 overflow-hidden flex flex-col'
              : 'fixed top-1/2 left-1/2 z-110 overflow-hidden rounded-2xl flex prd-dialog-content'
          }
          style={{
            ...(isMobile
              ? { width: '100vw', height: '100vh' }
              : {
                  width: showChat ? '900px' : '600px',
                  height: showChat ? '620px' : '520px',
                  minHeight: showChat ? '620px' : '520px',
                  maxWidth: '95vw',
                  maxHeight: '85vh',
                }),
            ...glassPanel,
            boxShadow: isMobile
              ? 'none'
              : '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
          }}
        >
        <DialogPrimitive.Title className="sr-only">缺陷详情</DialogPrimitive.Title>
        {/* 左侧：缺陷信息 */}
        <div className={`flex flex-col ${showChat ? (isMobile ? 'w-full' : 'w-[55%]') : 'w-full'}`}>
          {/* Header - 固定高度 52px */}
          <div
            className="flex items-center justify-between px-5 h-[52px] flex-shrink-0"
            style={{ borderBottom: '1px solid var(--nested-block-border)' }}
          >
            {/* 左侧：Bug icon + 缺陷编号 */}
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded flex-shrink-0"
              style={{
                background: 'var(--bg-input-hover)',
              }}
            >
              <Bug size={14} style={{ color: 'var(--accent-primary)' }} />
              <span
                className="text-[12px] font-mono"
                style={{ color: 'var(--text-muted)' }}
              >
                {defect.defectNo}
              </span>
            </div>
            {/* 右侧：时间 + 关闭按钮 */}
            <div className="flex items-center gap-3">
              <div
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--text-muted)' }}
              >
                <Clock size={12} />
                <span>{formatDateTime(defect.createdAt)}</span>
              </div>
              <button
                onClick={handleClose}
                className="p-1.5 rounded-lg hover:bg-white/5 transition-colors flex-shrink-0"
              >
                <X size={16} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 px-5 py-4 overflow-y-auto space-y-4">
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
                      className="flex-shrink-0 w-[100px] h-[70px] rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-white/30 transition-all"
                      style={{
                        background: 'var(--nested-block-bg)',
                        border: '1px solid var(--border-default)',
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
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] hover:bg-white/10 hover:ring-2 hover:ring-white/30 transition-all"
                      style={{
                        background: 'var(--bg-card-hover)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-subtle)',
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

            {/* 系统日志附件 */}
            {logAttachments.length > 0 && (
              <div>
                <div
                  className="text-[11px] mb-2 font-medium flex items-center gap-1.5"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <FileText size={12} />
                  系统日志 ({logAttachments.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {logAttachments.map((att) => (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] hover:ring-2 hover:ring-white/30 transition-all"
                      style={{
                        background: att.type === DefectAttachmentType.LogError
                          ? 'rgba(255, 100, 100, 0.08)'
                          : 'rgba(100, 200, 255, 0.08)',
                        color: 'var(--text-secondary)',
                        border: att.type === DefectAttachmentType.LogError
                          ? '1px solid rgba(255, 100, 100, 0.15)'
                          : '1px solid rgba(100, 200, 255, 0.15)',
                      }}
                      title="点击查看系统日志"
                    >
                      <FileText size={12} style={{
                        color: att.type === DefectAttachmentType.LogError
                          ? 'rgba(255, 120, 120, 0.8)'
                          : 'rgba(100, 200, 255, 0.8)',
                      }} />
                      <span className="max-w-[180px] truncate">{att.fileName}</span>
                      <ExternalLink size={12} style={{ opacity: 0.6 }} />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Description with [IMG] support */}
            <div
              className={hasExtraSections ? undefined : 'flex flex-col gap-2 flex-1 min-h-0'}
              style={{ marginTop: imageAttachments.length === 0 ? -6 : 0 }}
            >
              <div
                className="text-[11px] mb-2 font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                问题描述
              </div>
              <div
                className="text-[13px] leading-relaxed p-4 rounded-xl"
                style={{
                  background: 'rgba(255,255,255,0)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--nested-block-border)',
                  minHeight: hasScreenshots
                    ? (isShortContent ? '220px' : '360px')
                    : (isShortContent ? '240px' : '440px'),
                  overflowX: 'hidden',
                  overflowY: 'visible',
                  wordBreak: 'break-word',
                }}
              >
                {contentSegments.length > 0 ? (
                  contentSegments.map((seg, idx) =>
                    seg.type === 'text' ? (
                      <span key={idx} style={{ whiteSpace: 'pre-wrap' }}>{seg.content}</span>
                    ) : (
                      <button
                        key={idx}
                        type="button"
                        className="inline-block align-middle mx-1 rounded-lg overflow-hidden hover:ring-2 hover:ring-white/30 transition-all"
                        style={{
                          width: '100px',
                          height: '70px',
                          background: 'var(--nested-block-bg)',
                          border: '1px solid var(--border-default)',
                        }}
                        onClick={() => setLightboxImage(seg.content)}
                        title={seg.name || '点击查看大图'}
                      >
                        <img
                          src={seg.content}
                          alt={seg.name || '图片'}
                          className="w-full h-full object-cover"
                        />
                      </button>
                    )
                  )
                ) : (
                  <span>(无描述)</span>
                )}
              </div>
            </div>

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

          {/* Actions - 最小高度 60px，与右侧对齐 */}
          <div
            className={`px-5 min-h-[60px] flex ${isMobile ? 'flex-col gap-2 py-3' : 'items-center justify-between'} flex-shrink-0`}
            style={{ borderTop: '1px solid var(--nested-block-border)' }}
          >
            {/* Left: 严重程度 + 人员信息 + 删除按钮 */}
            <div className={`flex items-center gap-3 ${isMobile ? 'flex-wrap' : ''}`}>
              {/* 严重程度 */}
              <div
                className="flex items-center gap-2 text-[12px]"
                style={{ color: 'var(--text-muted)' }}
              >
                <span>严重程度</span>
                <span
                  className="px-2.5 py-1 rounded text-[12px]"
                  style={{ background: `${severityColor}20`, color: severityColor }}
                >
                  {severityLabel}
                </span>
              </div>
              <span
                className="h-5 w-px"
                style={{ background: 'rgba(255,255,255,0.1)' }}
              />
              {/* 提交人 */}
              <div
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded flex-shrink-0 text-[11px]"
                style={{
                  background: 'var(--bg-input-hover)',
                  color: 'var(--text-muted)',
                  border: userId && defect.reporterId === userId
                    ? '1px solid rgba(255, 255, 255, 0.5)'
                    : '1px solid var(--border-subtle)',
                }}
                title={defect.reporterName || '未知'}
              >
                <img
                  src={resolveAvatarUrl({ avatarFileName: defect.reporterAvatarFileName ?? undefined })}
                  alt={defect.reporterName || '未知'}
                  className="h-4 w-4 rounded-full object-cover"
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = resolveNoHeadAvatarUrl();
                  }}
                />
                <span className="truncate max-w-[60px]">{defect.reporterName || '未知'}</span>
              </div>
              <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} className="flex-shrink-0" />
              {/* 被指派人 */}
              <div
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded flex-shrink-0 text-[11px]"
                style={{
                  background: 'var(--bg-input-hover)',
                  color: 'var(--text-muted)',
                  border: userId && defect.assigneeId === userId
                    ? '1px solid rgba(255, 255, 255, 0.5)'
                    : '1px solid var(--border-subtle)',
                }}
                title={defect.assigneeName || '未指派'}
              >
                <img
                  src={resolveAvatarUrl({ avatarFileName: defect.assigneeAvatarFileName ?? undefined })}
                  alt={defect.assigneeName || '未指派'}
                  className="h-4 w-4 rounded-full object-cover"
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = resolveNoHeadAvatarUrl();
                  }}
                />
                <span className="truncate max-w-[60px]">{defect.assigneeName || '未指派'}</span>
              </div>
              {/* 删除按钮 */}
              {canDelete && !confirmingDelete && (
                <>
                  <span
                    className="h-5 w-px"
                    style={{ background: 'rgba(255,255,255,0.1)' }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleDeleteClick}
                    className="text-red-400 hover:text-red-300"
                  >
                    <Trash2 size={14} />
                    删除
                  </Button>
                </>
              )}
              {canDelete && confirmingDelete && (
                <>
                  <span
                    className="h-5 w-px"
                    style={{ background: 'rgba(255,255,255,0.1)' }}
                  />
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
              <button
                type="button"
                className="h-7 w-7 rounded-full flex items-center justify-center transition-all hover:ring-2 hover:ring-white/20"
                style={{
                  border: '1px solid rgba(255, 100, 100, 0.55)',
                  color: 'rgba(255, 100, 100, 0.95)',
                }}
                title="拒绝"
                onClick={handleReject}
              >
                <XCircle size={14} />
              </button>
              <button
                type="button"
                className="h-7 w-7 rounded-full flex items-center justify-center transition-all hover:ring-2 hover:ring-white/20"
                style={{
                  border: '1px solid rgba(120, 220, 180, 0.45)',
                  color: 'rgba(120, 220, 180, 0.95)',
                }}
                title="完成"
                onClick={handleCloseDefect}
              >
                <CheckCircle size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* 右侧：聊天面板 */}
        {showChat && (
          <div
            className={`${isMobile ? 'w-full' : 'w-[45%]'} flex flex-col`}
            style={{
              borderLeft: isMobile ? 'none' : '1px solid var(--nested-block-border)',
              borderTop: isMobile ? '1px solid var(--nested-block-border)' : 'none',
            }}
          >
            {/* Chat Header - 与左侧 Header 高度对齐 (52px) */}
            <div
              className="px-4 h-[52px] flex items-center gap-2 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--nested-block-border)' }}
            >
              <MessageCircle size={14} style={{ color: 'var(--text-muted)' }} />
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                评论
              </span>
              {messages.length > 0 && (
                <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                  {messages.filter(m => m.role === 'user').length}
                </span>
              )}
            </div>

            {/* Chat Messages */}
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
              style={{
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(255,255,255,0.2) transparent',
              }}
            >
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <MessageCircle size={32} style={{ color: 'rgba(255,255,255,0.15)' }} className="mx-auto mb-2" />
                    <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      暂无评论
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                      发送评论参与讨论
                    </div>
                  </div>
                </div>
              ) : (
                messages.map((msg) => {
                  const isSelf = Boolean(userId && msg.userId && msg.userId === userId);
                  const isUser = msg.role === 'user';
                  const isAssistant = msg.role === 'assistant';
                  const msgSegments = parseContentToSegments(msg.content);
                  const msgAttachments = (msg.attachmentIds || [])
                    .map((id) => attachmentCache[id])
                    .filter(Boolean);
                  const avatarSrc = !isAssistant
                    ? resolveAvatarUrl({ avatarFileName: msg.avatarFileName ?? null })
                    : null;
                  const displayName = msg.userName || (isAssistant ? 'AI 助手' : '用户');

                  return (
                    <div key={msg.id} className={`flex flex-col gap-1 ${isSelf ? 'items-end' : 'items-start'}`}>
                      {/* 发送者信息：头像 + 名字 */}
                      <div className={`flex items-center gap-1.5 px-1 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}>
                        {/* 头像 */}
                        <div
                          className="w-5 h-5 rounded-full flex-shrink-0 overflow-hidden flex items-center justify-center"
                          style={{
                            background: isAssistant ? 'rgba(100,180,255,0.2)' : 'rgba(255,180,70,0.15)',
                            border: '1px solid var(--border-default)',
                          }}
                        >
                          {avatarSrc ? (
                            <img src={avatarSrc} alt={displayName} className="w-full h-full object-cover" />
                          ) : isAssistant ? (
                            <Bot size={12} style={{ color: 'rgba(100,180,255,0.9)' }} />
                          ) : (
                            <User size={12} style={{ color: 'rgba(255,180,70,0.9)' }} />
                          )}
                        </div>
                        {/* 名字 */}
                        <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                          {displayName}
                        </span>
                      </div>

                      {/* 消息气泡 */}
                      {msgSegments.length > 0 && (
                        <div
                          className="group relative max-w-[90%] rounded-[10px] px-3 py-2 text-[12px] leading-relaxed"
                          style={{
                            background: isUser ? 'rgb(50, 45, 35)' : 'rgb(35, 35, 40)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {/* 渲染内容，支持 [IMG] */}
                          {msgSegments.map((seg, idx) =>
                            seg.type === 'text' ? (
                              <span key={idx} style={{ whiteSpace: 'pre-wrap' }}>{seg.content}</span>
                            ) : (
                              <button
                                key={idx}
                                type="button"
                                className="block w-full mt-2 rounded-lg overflow-hidden hover:ring-2 hover:ring-white/30 transition-all"
                                style={{
                                  maxWidth: '180px',
                                  background: 'var(--nested-block-bg)',
                                  border: '1px solid var(--border-default)',
                                }}
                                onClick={() => setLightboxImage(seg.content)}
                                title={seg.name || '点击查看大图'}
                              >
                                <img
                                  src={seg.content}
                                  alt={seg.name || '图片'}
                                  className="w-full object-contain"
                                  style={{ maxHeight: '120px' }}
                                />
                              </button>
                            )
                          )}
                        </div>
                      )}

                      {msgAttachments.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {msgAttachments.map((att) =>
                            isImageAttachment(att) ? (
                              <button
                                key={att.id}
                                type="button"
                                className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] hover:ring-2 hover:ring-white/30 transition-all"
                                style={{
                                  background: 'var(--bg-input-hover)',
                                  border: '1px solid var(--border-subtle)',
                                  color: 'var(--text-secondary)',
                                }}
                                onClick={() => att.url && setLightboxImage(att.url)}
                              >
                                <img
                                  src={att.url}
                                  alt={att.fileName}
                                  className="h-8 w-8 rounded object-cover"
                                />
                                <span className="max-w-[160px] truncate">{att.fileName}</span>
                              </button>
                            ) : (
                              <a
                                key={att.id}
                                href={att.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] hover:ring-2 hover:ring-white/30 transition-all"
                                style={{
                                  background: 'var(--bg-input-hover)',
                                  border: '1px solid var(--border-subtle)',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                <FileText size={14} style={{ color: 'var(--text-muted)' }} />
                                <span className="max-w-[160px] truncate">{att.fileName}</span>
                              </a>
                            )
                          )}
                        </div>
                      )}

                      {/* 时间戳 */}
                      <span
                        className="text-[9px] tabular-nums select-none px-1"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {formatMsgTimestamp(msg.createdAt)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Chat Input - 与左侧 Footer 高度对齐 (min 60px) */}
            <div
              className="px-4 min-h-[60px] flex items-center flex-shrink-0"
              style={{ borderTop: '1px solid var(--nested-block-border)' }}
            >
              <div className="w-full space-y-2">
                {pendingAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {pendingAttachments.map((att) => (
                      <div
                        key={att.id}
                        className="group relative flex items-center gap-2 rounded-lg px-2 py-1 text-[11px]"
                        style={{
                          background: 'var(--bg-input-hover)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {isImageAttachment(att) ? (
                          <img
                            src={att.url}
                            alt={att.fileName}
                            className="h-6 w-6 rounded object-cover"
                          />
                        ) : (
                          <FileText size={14} style={{ color: 'var(--text-muted)' }} />
                        )}
                        <span className="max-w-[160px] truncate">{att.fileName}</span>
                        <button
                          type="button"
                          className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] text-white group-hover:inline-flex"
                          onClick={() => handleRemovePendingAttachment(att.id)}
                          aria-label="移除附件"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-2 transition-all duration-200"
                  style={{
                    background: 'var(--bg-input)',
                    border: commentFocused
                      ? '1px solid rgba(214, 178, 106, 0.55)'
                      : '1px solid var(--border-subtle)',
                    boxShadow: commentFocused 
                      ? '0 0 0 2px rgba(214, 178, 106, 0.15)' 
                      : 'none',
                  }}
                  onDrop={handleCommentDrop}
                  onDragOver={handleCommentDragOver}
                >
                  <button
                    type="button"
                    onClick={handlePickAttachments}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-40"
                    disabled={uploadingAttachments || sendingComment}
                    title="添加图片或附件"
                  >
                    <Paperclip size={14} style={{ color: 'var(--text-muted)' }} />
                  </button>
                  <input
                    type="text"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && (comment.trim() || pendingAttachments.length > 0)) {
                        e.preventDefault();
                        handleSendComment();
                      }
                    }}
                    onPaste={handleCommentPaste}
                    onFocus={() => setCommentFocused(true)}
                    onBlur={() => setCommentFocused(false)}
                    placeholder="添加评论..."
                    className="flex-1 bg-transparent outline-none text-[13px] no-focus-ring"
                    style={{ color: 'var(--text-primary)' }}
                    disabled={sendingComment}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => handleAttachmentFiles(e.target.files)}
                  />
                  <button
                    onClick={handleSendComment}
                    disabled={(!comment.trim() && pendingAttachments.length === 0) || sendingComment}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-40"
                  >
                    <Send size={14} style={{ color: 'var(--accent-primary)' }} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogPrimitive.Content>

      {/* Image Lightbox - 独立 Portal 保证在最顶层 */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center p-8"
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
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
