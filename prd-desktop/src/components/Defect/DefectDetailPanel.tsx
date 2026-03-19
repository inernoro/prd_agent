import { useEffect, useState, useRef } from 'react';
import { invoke } from '../../lib/tauri';
import { useDefectStore } from '../../stores/defectStore';
import { useAuthStore } from '../../stores/authStore';
import type { ApiResponse, DefectReport, DefectAttachment } from '../../types';

// ━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const statusLabel: Record<string, string> = {
  draft: '草稿',
  submitted: '待处理',
  assigned: '已分配',
  processing: '处理中',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭',
  verifying: '待验收',
};

const statusColor: Record<string, string> = {
  draft: 'rgba(150,150,150,0.9)',
  submitted: 'rgba(255,180,70,0.9)',
  assigned: 'rgba(255,180,70,0.9)',
  processing: 'rgba(100,180,255,0.9)',
  resolved: 'rgba(100,200,120,0.9)',
  rejected: 'rgba(255,100,100,0.9)',
  closed: 'rgba(160,160,160,0.9)',
  verifying: 'rgba(180,140,255,0.9)',
};

const severityLabel: Record<string, string> = {
  critical: '致命',
  major: '严重',
  minor: '一般',
  trivial: '轻微',
};

const severityColor: Record<string, string> = {
  critical: 'rgba(255,80,80,0.9)',
  major: 'rgba(255,140,60,0.9)',
  minor: 'rgba(255,200,80,0.9)',
  trivial: 'rgba(150,200,100,0.9)',
};

// ━━━ [IMG] tag parsing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface ContentSegment {
  type: 'text' | 'image';
  content: string;
  name?: string;
}

function parseContentToSegments(content: string): ContentSegment[] {
  const text = String(content ?? '');
  const segments: ContentSegment[] = [];
  const rx = /\[IMG([^\]]*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = rx.exec(text))) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) segments.push({ type: 'text', content: before });
    }
    const body = String(match[1] ?? '').trim();
    const srcMatch = /src=(\S+)/.exec(body);
    const nameMatch = /name=(\S+)/.exec(body);
    if (srcMatch) {
      try {
        segments.push({
          type: 'image',
          content: decodeURIComponent(srcMatch[1]),
          name: nameMatch ? decodeURIComponent(nameMatch[1]) : undefined,
        });
      } catch {
        segments.push({ type: 'image', content: srcMatch[1] });
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim();
    if (after) segments.push({ type: 'text', content: after });
  }

  return segments.length > 0 ? segments : text.trim() ? [{ type: 'text', content: text.trim() }] : [];
}

// ━━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatDateTime(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatMsgTimestamp(ts: string | null | undefined) {
  const s = String(ts ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function isImageAttachment(att: DefectAttachment): boolean {
  return att.mimeType?.startsWith('image/') || false;
}

function isLogAttachment(att: DefectAttachment): boolean {
  return att.type === 'log-request' || att.type === 'log-error';
}

// ━━━ Component ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Props {
  defect: DefectReport;
  onClose: () => void;
}

export default function DefectDetailPanel({ defect, onClose }: Props) {
  const { defectMessages, loadDefect, loadDefectMessages, updateDefectInList, removeDefectFromList, loadDefects, loadStats } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [resolveInput, setResolveInput] = useState('');
  const [rejectInput, setRejectInput] = useState('');
  const [verifyFailInput, setVerifyFailInput] = useState('');
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [showVerifyFailDialog, setShowVerifyFailDialog] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDefect(defect.id);
  }, [defect.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [defectMessages.length]);

  // Mark as read
  useEffect(() => {
    if (userId) {
      if (defect.reporterId === userId && defect.reporterUnread) {
        updateDefectInList({ ...defect, reporterUnread: false });
      } else if (defect.assigneeId === userId && defect.assigneeUnread) {
        updateDefectInList({ ...defect, assigneeUnread: false });
      }
    }
  }, [defect.id]);

  const isReporter = userId === defect.reporterId;
  const isAssignee = userId === defect.assigneeId;

  const handleSendMessage = async () => {
    if (!messageInput.trim() || sending) return;
    setSending(true);
    try {
      await invoke('send_defect_message', {
        id: defect.id,
        content: messageInput.trim(),
      });
      setMessageInput('');
      await loadDefectMessages(defect.id);
      await loadDefects();
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleAction = async (action: string, extraPayload?: Record<string, string>) => {
    setActionLoading(true);
    try {
      let resp: ApiResponse<{ defect: DefectReport }>;
      switch (action) {
        case 'process':
          resp = await invoke('process_defect', { id: defect.id });
          break;
        case 'resolve':
          resp = await invoke('resolve_defect', { id: defect.id, resolution: extraPayload?.resolution || '已修复' });
          break;
        case 'reject':
          resp = await invoke('reject_defect', { id: defect.id, reason: extraPayload?.reason || '不予修复' });
          break;
        case 'close':
          resp = await invoke('close_defect', { id: defect.id });
          break;
        case 'delete':
          await invoke('delete_defect', { id: defect.id });
          removeDefectFromList(defect.id);
          loadStats();
          onClose();
          setActionLoading(false);
          return;
        case 'verify_pass':
          resp = await invoke('verify_pass_defect', { id: defect.id });
          break;
        case 'verify_fail':
          resp = await invoke('verify_fail_defect', { id: defect.id, reason: extraPayload?.reason || '' });
          break;
        default:
          setActionLoading(false);
          return;
      }
      if (resp!.success && resp!.data) {
        const updated = (resp!.data as any).defect ?? resp!.data;
        updateDefectInList(updated as DefectReport);
        loadStats();
      }
      setShowResolveDialog(false);
      setShowRejectDialog(false);
      setShowVerifyFailDialog(false);
    } catch (err) {
      console.error(`Failed to ${action} defect:`, err);
    } finally {
      setActionLoading(false);
    }
  };

  const canProcess = ['submitted', 'assigned'].includes(defect.status);
  const canResolve = ['submitted', 'assigned', 'processing'].includes(defect.status);
  const canReject = !['draft', 'rejected', 'closed'].includes(defect.status);
  const canVerify = defect.status === 'verifying' && defect.reporterId === userId;
  const canClose = ['verifying', 'resolved', 'rejected'].includes(defect.status);
  const canDelete = defect.status === 'draft' || defect.status === 'resolved' || defect.status === 'closed';
  const showChat = defect.status !== 'draft';

  // Attachments
  const imageAttachments = (defect.attachments || []).filter(isImageAttachment);
  const logAttachments = (defect.attachments || []).filter(isLogAttachment);
  const otherAttachments = (defect.attachments || []).filter((a) => !isImageAttachment(a) && !isLogAttachment(a));

  // Content segments
  const contentSegments = parseContentToSegments(defect.rawContent || '');

  const sLabel = severityLabel[defect.severity ?? ''] ?? defect.severity ?? '';
  const sColor = severityColor[defect.severity ?? ''] ?? 'var(--text-muted)';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={lightboxImage ? () => setLightboxImage(null) : undefined}>
      <div
        className={`mx-4 ui-glass-panel rounded-xl shadow-xl flex overflow-hidden ${showChat ? 'w-full max-w-4xl h-[85vh]' : 'w-full max-w-2xl h-[80vh]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: Defect info */}
        <div className={`flex flex-col ${showChat ? 'w-[55%]' : 'w-full'}`}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 h-[52px] border-b border-black/5 dark:border-white/10 shrink-0">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-black/5 dark:bg-white/5">
                <svg className="w-3.5 h-3.5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 116 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6M12 20v-9" />
                </svg>
                <span className="text-[12px] font-mono text-text-secondary">{defect.defectNo}</span>
              </div>
              <span
                className="text-[11px] px-2 py-0.5 rounded"
                style={{ background: `${statusColor[defect.status] ?? 'rgba(150,150,150,0.9)'}20`, color: statusColor[defect.status] ?? 'var(--text-muted)' }}
              >
                {statusLabel[defect.status] || defect.status}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-text-secondary flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {formatDateTime(defect.createdAt)}
              </span>
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* Image attachments gallery */}
            {imageAttachments.length > 0 && (
              <div>
                <div className="text-[11px] mb-2 font-medium text-text-secondary flex items-center gap-1.5">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  截图 ({imageAttachments.length})
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
                  {imageAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex-shrink-0 w-[100px] h-[70px] rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-primary-500/30 transition-all"
                      style={{ background: 'rgba(128,128,128,0.1)', border: '1px solid rgba(128,128,128,0.15)' }}
                      onClick={() => att.url && setLightboxImage(att.url)}
                      title="点击查看大图"
                    >
                      {att.url ? (
                        <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-text-secondary text-[10px]">IMG</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Other attachments */}
            {otherAttachments.length > 0 && (
              <div>
                <div className="text-[11px] mb-2 font-medium text-text-secondary flex items-center gap-1.5">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  附件 ({otherAttachments.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {otherAttachments.map((att) => (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] hover:ring-2 hover:ring-white/20 transition-all"
                      style={{ background: 'rgba(128,128,128,0.08)', border: '1px solid rgba(128,128,128,0.1)' }}
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="max-w-[150px] truncate">{att.fileName}</span>
                      <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Log attachments */}
            {logAttachments.length > 0 && (
              <div>
                <div className="text-[11px] mb-2 font-medium text-text-secondary flex items-center gap-1.5">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  系统日志 ({logAttachments.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {logAttachments.map((att) => (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] hover:ring-2 hover:ring-white/20 transition-all"
                      style={{
                        background: att.type === 'log-error' ? 'rgba(255,100,100,0.08)' : 'rgba(100,200,255,0.08)',
                        border: att.type === 'log-error' ? '1px solid rgba(255,100,100,0.15)' : '1px solid rgba(100,200,255,0.15)',
                      }}
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{
                        color: att.type === 'log-error' ? 'rgba(255,120,120,0.8)' : 'rgba(100,200,255,0.8)',
                      }}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="max-w-[180px] truncate">{att.fileName}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Description with [IMG] support */}
            <div>
              <div className="text-[11px] mb-2 font-medium text-text-secondary">问题描述</div>
              <div
                className="text-[13px] leading-relaxed p-4 rounded-xl"
                style={{ background: 'rgba(128,128,128,0.04)', border: '1px solid rgba(128,128,128,0.1)', minHeight: '120px' }}
              >
                {contentSegments.map((seg, idx) =>
                  seg.type === 'text' ? (
                    <div key={idx} className="whitespace-pre-wrap mb-2">{seg.content}</div>
                  ) : (
                    <button
                      key={idx}
                      type="button"
                      className="inline-block align-middle mx-1 rounded-lg overflow-hidden hover:ring-2 hover:ring-white/30 transition-all"
                      style={{ width: '100px', height: '70px', background: 'rgba(128,128,128,0.1)', border: '1px solid rgba(128,128,128,0.15)' }}
                      onClick={() => setLightboxImage(seg.content)}
                      title={seg.name || '点击查看大图'}
                    >
                      <img src={seg.content} alt={seg.name || '图片'} className="w-full h-full object-cover" />
                    </button>
                  )
                )}
              </div>
            </div>

            {/* Resolution / Reject / VerifyFail info */}
            {defect.resolution && (
              <div className="p-3 rounded-lg" style={{ background: 'rgba(100,200,120,0.1)', border: '1px solid rgba(100,200,120,0.2)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-medium" style={{ color: 'rgba(100,200,120,0.9)' }}>解决方案</span>
                  <span className="text-[10px] text-text-secondary">
                    {defect.resolvedByName && `${defect.resolvedByName}${defect.resolvedByName === (isAssignee ? defect.assigneeName : '') ? ' (我)' : ''} · `}{formatDateTime(defect.resolvedAt)}
                  </span>
                </div>
                <div className="text-[12px]">{defect.resolution}</div>
              </div>
            )}
            {defect.rejectReason && (
              <div className="p-3 rounded-lg" style={{ background: 'rgba(255,100,100,0.1)', border: '1px solid rgba(255,100,100,0.2)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-medium" style={{ color: 'rgba(255,100,100,0.9)' }}>驳回原因</span>
                  <span className="text-[10px] text-text-secondary">
                    {defect.rejectedByName && `${defect.rejectedByName}`}
                  </span>
                </div>
                <div className="text-[12px]">{defect.rejectReason}</div>
              </div>
            )}
            {defect.verifyFailReason && (
              <div className="p-3 rounded-lg" style={{ background: 'rgba(255,160,60,0.1)', border: '1px solid rgba(255,160,60,0.2)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-medium" style={{ color: 'rgba(255,160,60,0.9)' }}>验收不通过原因</span>
                </div>
                <div className="text-[12px]">{defect.verifyFailReason}</div>
              </div>
            )}

            {/* Timestamps */}
            <div className="text-[11px] space-y-1.5 pt-2 text-text-secondary">
              {defect.resolvedAt && (
                <div className="flex items-center gap-2">
                  <svg className="w-3 h-3" style={{ color: 'rgba(100,200,120,0.9)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>解决于 {formatDateTime(defect.resolvedAt)}</span>
                </div>
              )}
              {defect.closedAt && (
                <div className="flex items-center gap-2">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
                  </svg>
                  <span>关闭于 {formatDateTime(defect.closedAt)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions footer */}
          <div className="px-5 py-3 border-t border-black/5 dark:border-white/10 shrink-0 flex items-center justify-between">
            {/* Left: severity + people */}
            <div className="flex items-center gap-3">
              <span className="text-[12px] px-2.5 py-1 rounded" style={{ background: `${sColor}20`, color: sColor }}>
                {sLabel}
              </span>
              <span className="h-4 w-px bg-black/5 dark:bg-white/10" />
              <div className="flex items-center gap-1 text-[10px] text-text-secondary">
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium"
                  style={{
                    background: isReporter ? 'rgba(100,160,255,0.2)' : 'rgba(128,128,128,0.15)',
                    color: isReporter ? 'rgba(100,160,255,1)' : 'inherit',
                    border: isReporter ? '1px solid rgba(100,160,255,0.4)' : '1px solid transparent',
                  }}
                >
                  {(defect.reporterName || 'U')[0]}
                </span>
                <span className="max-w-[50px] truncate">{defect.reporterName || '未知'}</span>
                {isReporter && <span className="text-primary-500 text-[9px]">(我)</span>}
                <svg className="w-3 h-3 opacity-40 mx-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium"
                  style={{
                    background: isAssignee ? 'rgba(120,220,180,0.2)' : 'rgba(128,128,128,0.15)',
                    color: isAssignee ? 'rgba(120,220,180,1)' : 'inherit',
                    border: isAssignee ? '1px solid rgba(120,220,180,0.4)' : '1px solid transparent',
                  }}
                >
                  {(defect.assigneeName || 'U')[0]}
                </span>
                <span className="max-w-[50px] truncate">{defect.assigneeName || '未指派'}</span>
                {isAssignee && <span className="text-green-400 text-[9px]">(我)</span>}
              </div>
            </div>

            {/* Right: action buttons */}
            <div className="flex items-center gap-1.5">
              {canProcess && (
                <button
                  onClick={() => handleAction('process')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-[11px] rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
                >
                  开始处理
                </button>
              )}
              {canResolve && (
                <button
                  onClick={() => setShowResolveDialog(true)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-[11px] rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                >
                  标记解决
                </button>
              )}
              {canVerify && (
                <>
                  <button
                    onClick={() => handleAction('verify_pass')}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-[11px] rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                  >
                    验收通过
                  </button>
                  <button
                    onClick={() => setShowVerifyFailDialog(true)}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-[11px] rounded-lg bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 disabled:opacity-50 transition-colors"
                  >
                    验收不通过
                  </button>
                </>
              )}
              {canReject && (
                <button
                  onClick={() => setShowRejectDialog(true)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-[11px] rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                >
                  驳回
                </button>
              )}
              {canClose && (
                <button
                  onClick={() => handleAction('close')}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-[11px] rounded-lg bg-black/5 dark:bg-white/5 text-text-secondary hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                  完成
                </button>
              )}
              {canDelete && (
                <button
                  onClick={() => handleAction('delete')}
                  disabled={actionLoading}
                  className="px-2 py-1.5 text-[11px] rounded-lg hover:bg-red-500/20 text-red-400 disabled:opacity-50 transition-colors"
                  title="删除"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right: Chat panel */}
        {showChat && (
          <div className="w-[45%] flex flex-col border-l border-black/5 dark:border-white/10">
            {/* Chat header */}
            <div className="px-4 h-[52px] flex items-center border-b border-black/5 dark:border-white/10 shrink-0">
              <svg className="w-4 h-4 text-text-secondary mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span className="text-[13px] font-medium">讨论</span>
              <span className="text-[10px] text-text-secondary ml-2">({defectMessages.length})</span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4" style={{ scrollbarWidth: 'thin' }}>
              {defectMessages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-text-secondary text-[12px]">
                  暂无讨论，发送消息开始
                </div>
              ) : (
                defectMessages.map((msg) => (
                  <div key={msg.id} className="flex gap-2.5">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 ${
                      msg.role === 'assistant'
                        ? 'bg-purple-500/20 text-purple-400'
                        : 'bg-primary-500/20 text-primary-500'
                    }`}>
                      {msg.role === 'assistant' ? 'AI' : (msg.userName?.[0] || 'U')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[12px] font-medium">
                          {msg.role === 'assistant' ? 'AI 助手' : (msg.userName || '用户')}
                        </span>
                        <span className="text-[10px] text-text-secondary">{formatMsgTimestamp(msg.createdAt)}</span>
                      </div>
                      <div className="text-[13px] whitespace-pre-wrap leading-relaxed text-text-secondary">
                        {msg.content}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message input */}
            <div className="px-4 py-3 border-t border-black/5 dark:border-white/10 shrink-0">
              <div className="flex gap-2">
                <textarea
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
                  rows={2}
                  className="flex-1 px-3 py-2 text-[13px] rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-primary-500/30 resize-none"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={sending || !messageInput.trim()}
                  className="px-3 py-2 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors self-end"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Resolve dialog */}
      {showResolveDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowResolveDialog(false)}>
          <div className="w-80 p-4 rounded-lg ui-glass-panel shadow-lg space-y-3" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold">标记为已解决</h4>
            <textarea
              value={resolveInput}
              onChange={(e) => setResolveInput(e.target.value)}
              placeholder="请输入解决方案..."
              rows={3}
              className="w-full px-3 py-2 text-sm rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-green-500/30 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowResolveDialog(false)} className="px-3 py-1.5 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">取消</button>
              <button
                onClick={() => handleAction('resolve', { resolution: resolveInput || '已修复' })}
                disabled={actionLoading}
                className="px-3 py-1.5 text-xs rounded-lg bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
              >
                确认解决
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject dialog */}
      {showRejectDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowRejectDialog(false)}>
          <div className="w-80 p-4 rounded-lg ui-glass-panel shadow-lg space-y-3" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold">驳回缺陷</h4>
            <textarea
              value={rejectInput}
              onChange={(e) => setRejectInput(e.target.value)}
              placeholder="请输入驳回原因..."
              rows={3}
              className="w-full px-3 py-2 text-sm rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-red-500/30 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRejectDialog(false)} className="px-3 py-1.5 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">取消</button>
              <button
                onClick={() => handleAction('reject', { reason: rejectInput || '不予修复' })}
                disabled={actionLoading}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                确认驳回
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Verify fail dialog */}
      {showVerifyFailDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowVerifyFailDialog(false)}>
          <div className="w-80 p-4 rounded-lg ui-glass-panel shadow-lg space-y-3" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold">验收不通过</h4>
            <textarea
              value={verifyFailInput}
              onChange={(e) => setVerifyFailInput(e.target.value)}
              placeholder="请输入不通过原因..."
              rows={3}
              className="w-full px-3 py-2 text-sm rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-orange-500/30 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowVerifyFailDialog(false)} className="px-3 py-1.5 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">取消</button>
              <button
                onClick={() => handleAction('verify_fail', { reason: verifyFailInput })}
                disabled={actionLoading || !verifyFailInput.trim()}
                className="px-3 py-1.5 text-xs rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

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
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
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
    </div>
  );
}
