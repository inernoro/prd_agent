import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { deleteDefect, closeDefect } from '@/services';
import { toast } from '@/lib/toast';
import type { DefectReport, DefectAttachment } from '@/services/contracts/defectAgent';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import { ArrowRight, Clock, Trash2, Check, CheckCircle, MessageCircle, Image as ImageIcon, X, AlertTriangle, AlertCircle, Info, MinusCircle, Paperclip, Bug } from 'lucide-react';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';

interface DefectCardProps {
  defect: DefectReport;
}

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

function formatStampDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}月${day}日`;
}

function getPreviewText(content: string | undefined | null, maxChars = 80) {
  const raw = String(content ?? '').trim();
  if (!raw) return '(暂无描述)';
  const lines = raw.split(/\r?\n/);
  const withoutFirstLine = lines.slice(1).join('\n').trim();
  if (!withoutFirstLine) return '(暂无描述)';
  if (withoutFirstLine.length <= maxChars) return withoutFirstLine;
  return withoutFirstLine.slice(0, maxChars) + '...';
}

function isImageAttachment(att: DefectAttachment): boolean {
  return att.mimeType?.startsWith('image/') || false;
}

export function DefectCard({ defect }: DefectCardProps) {
  const { selectedDefectId, setSelectedDefectId, removeDefectFromList, updateDefectInList, loadStats } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const [deleting, setDeleting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const isSelected = selectedDefectId === defect.id;
  const title = defect.title || '无标题';
  const severity = severityConfig[defect.severity] || severityConfig[DefectSeverity.Minor];
  const SeverityIcon = severity.icon;
  const reporterDisplayName = defect.reporterName || '未知';
  const reporterAvatarUrl = resolveAvatarUrl({ username: defect.reporterUsername ?? undefined });
  const assigneeDisplayName = defect.assigneeName || '未指派';
  const assigneeAvatarUrl = resolveAvatarUrl({ username: defect.assigneeUsername ?? undefined });
  const isReporterMe = Boolean(userId && defect.reporterId === userId);
  const isAssigneeMe = Boolean(userId && defect.assigneeId === userId);
  const currentRole =
    userId && defect.reporterId === userId
      ? 'reporter'
      : userId && defect.assigneeId === userId
      ? 'assignee'
      : null;
  const oppositeRole = currentRole === 'reporter' ? 'assignee' : currentRole === 'assignee' ? 'reporter' : null;
  const hasPeerCommented = Boolean(oppositeRole && defect.lastCommentBy === oppositeRole);
  const peerUnread = oppositeRole === 'reporter'
    ? defect.reporterUnread
    : oppositeRole === 'assignee'
    ? defect.assigneeUnread
    : undefined;
  const showPeerCommented = hasPeerCommented;
  const showPeerUnread = !hasPeerCommented && peerUnread === true;
  const showPeerRead = !hasPeerCommented && peerUnread === false;
  const resolvedByName = defect.resolvedByName || '';
  const rejectedByName = defect.rejectedByName || '';

  // Get image attachments for thumbnails
  const imageAttachments = (defect.attachments || []).filter(isImageAttachment);
  const otherAttachments = (defect.attachments || []).filter((att) => !isImageAttachment(att));
  const attachmentCount = (defect.attachments || []).length;
  const canDirectOpenOtherAttachment =
    otherAttachments.length === 1 && Boolean(otherAttachments[0]?.url);

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

  const handleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCompleting(true);
    try {
      const res = await closeDefect({ id: defect.id });
      if (res.success && res.data?.defect) {
        updateDefectInList(res.data.defect);
        toast.success('已完成');
        loadStats();
      } else {
        toast.error(res.error?.message || '操作失败');
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setCompleting(false);
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
          <div className="flex-1 min-w-0 flex flex-col relative">
            {/* 完成印章 */}
            {defect.status === DefectStatus.Resolved && (
              <div
                className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none select-none z-10"
                style={{ transform: 'translateY(-50%) rotate(-15deg)' }}
              >
                <div
                  className="flex flex-col items-center px-3 py-2 rounded-lg"
                  style={{
                    border: '3px solid rgba(120, 220, 180, 0.7)',
                    background: 'rgba(120, 220, 180, 0.08)',
                  }}
                >
                  <span
                    className="text-[24px] font-bold tracking-wider"
                    style={{ color: 'rgba(120, 220, 180, 0.85)' }}
                  >
                    完成
                  </span>
                  <span
                    className="text-[10px] mt-0.5"
                    style={{ color: 'rgba(120, 220, 180, 0.7)' }}
                  >
                    {resolvedByName} : {formatStampDate(defect.resolvedAt)}
                  </span>
                </div>
              </div>
            )}
            {/* Header: 标题 + 编号 */}
            <div className="px-3 pt-3 pb-2 flex items-center gap-2">
              {showPeerUnread && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(255, 200, 80, 0.18)',
                    color: 'rgba(255, 200, 80, 0.95)',
                    border: '1px solid rgba(255, 200, 80, 0.4)',
                  }}
                  title="对方未读"
                >
                  对方未读
                </span>
              )}
              {showPeerCommented && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(120, 220, 180, 0.14)',
                    color: 'rgba(120, 220, 180, 0.9)',
                    border: '1px solid rgba(120, 220, 180, 0.4)',
                  }}
                  title="对方已评论"
                >
                  <MessageCircle size={10} />
                  对方已评论
                </span>
              )}
              {showPeerRead && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(140, 190, 255, 0.12)',
                    color: 'rgba(140, 190, 255, 0.95)',
                    border: '1px solid rgba(140, 190, 255, 0.45)',
                  }}
                  title="对方已读"
                >
                  <CheckCircle size={10} />
                  对方已读
                </span>
              )}
              {defect.status === DefectStatus.Rejected && rejectedByName && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(255, 120, 120, 0.14)',
                    color: 'rgba(255, 120, 120, 0.95)',
                    border: '1px solid rgba(255, 120, 120, 0.45)',
                  }}
                  title={`拒绝：${rejectedByName}`}
                >
                  拒绝：{rejectedByName}
                </span>
              )}
              {/* 标题 */}
              <span
                className="text-[13px] font-medium truncate flex-1 min-w-0"
                style={{ color: 'var(--text-primary)' }}
                title={title}
              >
                {title}
              </span>

              {/* 时间 + 缺陷编号 - 垂直布局 */}
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                <span
                  className="text-[10px] font-mono flex items-center gap-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Bug size={10} />
                  {defect.defectNo}
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

            {/* 描述预览 */}
            <div className="px-3 pb-2 flex-1 min-h-0">
              <div
                className="text-[12px] line-clamp-3"
                style={{ color: 'var(--text-secondary)' }}
              >
                {getPreviewText(defect.rawContent, 120)}
              </div>
            </div>

            {/* 附件预览 */}
            {attachmentCount > 0 && (
              <div className="px-3 pb-2 flex items-center gap-2">
                {imageAttachments.length > 0 && (
                  <div className="flex gap-1.5">
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
                {otherAttachments.length > 0 && (
                  canDirectOpenOtherAttachment ? (
                    <a
                      href={otherAttachments[0].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] hover:ring-2 hover:ring-white/30 transition-all"
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        color: 'var(--text-muted)',
                        border: '1px solid rgba(255,255,255,0.1)',
                      }}
                      title={`打开附件 ${otherAttachments[0].fileName}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Paperclip size={11} />
                      附件 {otherAttachments.length}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] hover:ring-2 hover:ring-white/30 transition-all"
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        color: 'var(--text-muted)',
                        border: '1px solid rgba(255,255,255,0.1)',
                      }}
                      title={`查看附件 ${otherAttachments.length} 个`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedDefectId(defect.id);
                      }}
                    >
                      <Paperclip size={11} />
                      附件 {otherAttachments.length}
                    </button>
                  )
                )}
              </div>
            )}

            {/* 底部：严重性 + 状态 + 人员 + 时间 + 操作 */}
            <div
              className="px-3 py-2 flex items-center border-t text-[11px]"
              style={{ borderColor: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
            >
              {/* 严重性标签 - 左下角 */}
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 mr-2"
                style={{ background: severity.bgColor, color: severity.color }}
              >
                <SeverityIcon size={10} />
                {severity.label}
              </div>

              {/* 提交者 */}
              <div
                className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded mr-2 flex-shrink-0 text-[10px]"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-muted)',
                  border: isReporterMe
                    ? '1px solid rgba(255, 200, 80, 0.85)'
                    : '1px solid rgba(255,255,255,0.08)',
                  boxShadow: isReporterMe ? '0 0 0 1px rgba(255, 200, 80, 0.25) inset' : undefined,
                }}
                title={reporterDisplayName}
              >
                <img
                  src={reporterAvatarUrl}
                  alt={reporterDisplayName}
                  className="h-3 w-3 rounded-full object-cover"
                  onError={(e) => {
                    e.currentTarget.onerror = null; // 防止 nohead.png 也 404 时死循环
                    e.currentTarget.src = resolveNoHeadAvatarUrl();
                  }}
                />
                <span className="truncate max-w-[60px]">{reporterDisplayName}</span>
              </div>

              {/* 人员信息 */}
              <div className="flex items-center gap-1 flex-1 min-w-0">
              <ArrowRight size={10} className="flex-shrink-0 opacity-50" />
              <div
                className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded flex-shrink-0 text-[10px]"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-muted)',
                  border: isAssigneeMe
                    ? '1px solid rgba(255, 200, 80, 0.85)'
                    : '1px solid rgba(255,255,255,0.08)',
                  boxShadow: isAssigneeMe ? '0 0 0 1px rgba(255, 200, 80, 0.25) inset' : undefined,
                }}
                title={assigneeDisplayName}
              >
                <img
                  src={assigneeAvatarUrl}
                  alt={assigneeDisplayName}
                  className="h-3 w-3 rounded-full object-cover"
                  onError={(e) => {
                    e.currentTarget.onerror = null; // 防止 nohead.png 也 404 时死循环
                    e.currentTarget.src = resolveNoHeadAvatarUrl();
                  }}
                />
                <span className="truncate max-w-[60px]">{assigneeDisplayName}</span>
              </div>
              </div>

              {/* 操作按钮（悬浮显示） */}
              <div
                className={[
                  'flex items-center gap-1',
                  'opacity-0 pointer-events-none transition-opacity duration-100',
                  'group-hover:opacity-100 group-hover:pointer-events-auto',
                ].join(' ')}
              >
                {defect.status === DefectStatus.Resolved ? (
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
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    className="h-6 w-6 p-0 rounded gap-0 hover:bg-white/10"
                    onClick={handleComplete}
                    disabled={completing}
                    title="完成"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <Check size={12} />
                  </Button>
                )}
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
