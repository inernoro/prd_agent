import { useState } from 'react';
import { glassBadge } from '@/lib/glassStyles';
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
  const reporterAvatarUrl = resolveAvatarUrl({ avatarFileName: defect.reporterAvatarFileName ?? undefined });
  const assigneeDisplayName = defect.assigneeName || '未指派';
  const assigneeAvatarUrl = resolveAvatarUrl({ avatarFileName: defect.assigneeAvatarFileName ?? undefined });
  const isReporterMe = Boolean(userId && defect.reporterId === userId);
  const isAssigneeMe = Boolean(userId && defect.assigneeId === userId);
  const currentRole =
    userId && defect.reporterId === userId
      ? 'reporter'
      : userId && defect.assigneeId === userId
      ? 'assignee'
      : null;
  const oppositeRole = currentRole === 'reporter' ? 'assignee' : currentRole === 'assignee' ? 'reporter' : null;
  // 我方未读状态
  const myUnread = currentRole === 'reporter'
    ? defect.reporterUnread
    : currentRole === 'assignee'
    ? defect.assigneeUnread
    : undefined;
  // 对方未读状态
  const peerUnread = oppositeRole === 'reporter'
    ? defect.reporterUnread
    : oppositeRole === 'assignee'
    ? defect.assigneeUnread
    : undefined;
  // 完成/驳回状态不显示已读/未读/评论标签
  const isArchived = defect.status === DefectStatus.Resolved || defect.status === DefectStatus.Rejected;

  // ========== 根据最后操作者决定显示状态 ==========
  // 操作包括：评论、读取、创建
  // 规则：
  // - 如果我最后评论，但对方已读 → 对方是最后操作者（对方"读取"发生在我的"评论"之后）
  // - 如果对方最后评论，但我已读 → 我是最后操作者（我的"读取"发生在对方的"评论"之后）
  // - 如果没有评论记录，创建者是第一个操作者，读取者是后续操作者

  const lastCommentByMe = defect.lastCommentBy === currentRole;
  const lastCommentByPeer = defect.lastCommentBy === oppositeRole;

  // 判断真正的最后操作者和操作类型
  let lastActor: 'me' | 'peer' | null = null;
  let lastAction: 'comment' | 'read' | 'create' | null = null;

  if (lastCommentByMe) {
    // 我最后评论了
    if (peerUnread === false) {
      // 对方在我评论后读取过 → 对方是最后操作者
      lastActor = 'peer';
      lastAction = 'read';
    } else {
      // 对方还没读（或状态未知）→ 我是最后操作者
      lastActor = 'me';
      lastAction = 'comment';
    }
  } else if (lastCommentByPeer) {
    // 对方最后评论了
    if (myUnread === false) {
      // 我在对方评论后读取过 → 我是最后操作者
      lastActor = 'me';
      lastAction = 'read';
    } else {
      // 我还没读（或状态未知）→ 对方是最后操作者
      lastActor = 'peer';
      lastAction = 'comment';
    }
  } else {
    // 没有评论记录（新建缺陷）
    if (currentRole === 'reporter') {
      // 我是提交者（创建者）
      if (peerUnread === false) {
        // 处理者已读 → 处理者是最后操作者
        lastActor = 'peer';
        lastAction = 'read';
      } else {
        // 处理者未读 → 我是最后操作者（创建）
        lastActor = 'me';
        lastAction = 'create';
      }
    } else if (currentRole === 'assignee') {
      // 我是处理者
      if (myUnread === false) {
        // 我已读 → 我是最后操作者
        lastActor = 'me';
        lastAction = 'read';
      } else {
        // 我未读 → 提交者是最后操作者（创建）
        lastActor = 'peer';
        lastAction = 'create';
      }
    }
  }

  // 我方未读是最高优先级（需要我立即关注）
  const showMyUnread = !isArchived && myUnread === true;

  // 根据最后操作者和操作类型显示状态
  // 我是最后操作者
  const showMyCommented = !isArchived && !showMyUnread && lastActor === 'me' && lastAction === 'comment';
  const showMyRead = !isArchived && !showMyUnread && lastActor === 'me' && lastAction === 'read';
  const showMyCreated = !isArchived && !showMyUnread && lastActor === 'me' && lastAction === 'create';

  // 对方是最后操作者
  const showPeerCommented = !isArchived && !showMyUnread && lastActor === 'peer' && lastAction === 'comment';
  const showPeerRead = !isArchived && !showMyUnread && lastActor === 'peer' && lastAction === 'read';
  const showPeerCreated = !isArchived && !showMyUnread && lastActor === 'peer' && lastAction === 'create';
  const resolvedByName = defect.resolvedByName || '';
  const resolvedByAvatarUrl = resolveAvatarUrl({ avatarFileName: defect.resolvedByAvatarFileName ?? undefined });
  const rejectedByName = defect.rejectedByName || '';
  const rejectedByAvatarUrl = resolveAvatarUrl({ avatarFileName: defect.rejectedByAvatarFileName ?? undefined });

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
            {/* 完成印章 - 右下角，毛玻璃背景 */}
            {defect.status === DefectStatus.Resolved && (
              <div
                className="absolute right-3 bottom-10 select-none z-10"
                style={{ transform: 'rotate(-12deg)' }}
                title={defect.resolution || ''}
              >
                <div
                  className="flex flex-col items-center px-4 py-2.5 rounded-xl"
                  style={{
                    ...glassBadge,
                    border: '3px solid rgba(120, 220, 180, 0.7)',
                    background: 'rgba(30, 40, 35, 0.75)',
                    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(120, 220, 180, 0.15)',
                  }}
                >
                  <span
                    className="text-[26px] font-bold tracking-[0.18em] leading-none"
                    style={{ color: 'rgba(120, 220, 180, 0.95)' }}
                  >
                    完成
                  </span>
                  <div
                    className="flex items-center gap-1 mt-1 max-w-[100px]"
                    style={{ color: 'rgba(120, 220, 180, 0.75)' }}
                  >
                    <img
                      src={resolvedByAvatarUrl}
                      alt={resolvedByName}
                      className="w-3.5 h-3.5 rounded-full object-cover flex-shrink-0"
                      style={{ border: '1px solid rgba(120, 220, 180, 0.4)' }}
                      onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = resolveNoHeadAvatarUrl();
                      }}
                    />
                    <span className="text-[9px] truncate">
                      {resolvedByName}{defect.resolution ? `: ${defect.resolution}` : ''}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {/* 驳回印章 - 右下角，红色毛玻璃背景 */}
            {defect.status === DefectStatus.Rejected && (
              <div
                className="absolute right-3 bottom-10 select-none z-10"
                style={{ transform: 'rotate(-12deg)' }}
                title={defect.rejectReason || ''}
              >
                <div
                  className="flex flex-col items-center px-4 py-2.5 rounded-xl"
                  style={{
                    ...glassBadge,
                    border: '3px solid rgba(255, 120, 120, 0.7)',
                    background: 'rgba(45, 30, 30, 0.75)',
                    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255, 120, 120, 0.15)',
                  }}
                >
                  <span
                    className="text-[26px] font-bold tracking-[0.18em] leading-none"
                    style={{ color: 'rgba(255, 120, 120, 0.95)' }}
                  >
                    驳回
                  </span>
                  <div
                    className="flex items-center gap-1 mt-1 max-w-[100px]"
                    style={{ color: 'rgba(255, 120, 120, 0.75)' }}
                  >
                    <img
                      src={rejectedByAvatarUrl}
                      alt={rejectedByName}
                      className="w-3.5 h-3.5 rounded-full object-cover flex-shrink-0"
                      style={{ border: '1px solid rgba(255, 120, 120, 0.4)' }}
                      onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = resolveNoHeadAvatarUrl();
                      }}
                    />
                    <span className="text-[9px] truncate">
                      {rejectedByName}{defect.rejectReason ? `: ${defect.rejectReason}` : ''}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {/* Header: 标题 + 编号 */}
            <div className="px-3 pt-3 pb-2 flex items-center gap-2">
              {/* 我方未读 - 醒目的新缺陷/新回复标签（最高优先级） */}
              {showMyUnread && currentRole === 'assignee' && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 animate-pulse"
                  style={{
                    background: 'rgba(255, 100, 100, 0.25)',
                    color: 'rgba(255, 120, 120, 1)',
                    border: '1px solid rgba(255, 100, 100, 0.6)',
                    boxShadow: '0 0 8px rgba(255, 100, 100, 0.3)',
                  }}
                  title="新收到的缺陷，点击查看"
                >
                  <Bug size={10} />
                  新缺陷
                </span>
              )}
              {showMyUnread && currentRole === 'reporter' && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 animate-pulse"
                  style={{
                    background: 'rgba(120, 220, 180, 0.25)',
                    color: 'rgba(120, 220, 180, 1)',
                    border: '1px solid rgba(120, 220, 180, 0.6)',
                    boxShadow: '0 0 8px rgba(120, 220, 180, 0.3)',
                  }}
                  title="有新回复，点击查看"
                >
                  <MessageCircle size={10} />
                  新回复
                </span>
              )}

              {/* ========== 我是最后操作者 - 显示我的状态（不带"对方"前缀）========== */}
              {showMyCommented && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(120, 220, 180, 0.14)',
                    color: 'rgba(120, 220, 180, 0.9)',
                    border: '1px solid rgba(120, 220, 180, 0.4)',
                  }}
                  title="我已评论，等待对方回应"
                >
                  <MessageCircle size={10} />
                  已评
                </span>
              )}
              {showMyRead && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(140, 190, 255, 0.12)',
                    color: 'rgba(140, 190, 255, 0.95)',
                    border: '1px solid rgba(140, 190, 255, 0.45)',
                  }}
                  title="我已读"
                >
                  <CheckCircle size={10} />
                  已读
                </span>
              )}
              {showMyCreated && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(255, 200, 80, 0.18)',
                    color: 'rgba(255, 200, 80, 0.95)',
                    border: '1px solid rgba(255, 200, 80, 0.4)',
                  }}
                  title="我已提交，等待对方查看"
                >
                  已提交
                </span>
              )}

              {/* ========== 对方是最后操作者 - 显示对方的状态（带"对方"前缀）========== */}
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
                  对方已评
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
              {showPeerCreated && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
                  style={{
                    background: 'rgba(255, 200, 80, 0.18)',
                    color: 'rgba(255, 200, 80, 0.95)',
                    border: '1px solid rgba(255, 200, 80, 0.4)',
                  }}
                  title="对方已提交，等待你查看"
                >
                  对方已提交
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
                    ? '1px solid rgba(255, 255, 255, 0.5)'
                    : '1px solid rgba(255,255,255,0.08)',
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
                    ? '1px solid rgba(255, 255, 255, 0.5)'
                    : '1px solid rgba(255,255,255,0.08)',
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
