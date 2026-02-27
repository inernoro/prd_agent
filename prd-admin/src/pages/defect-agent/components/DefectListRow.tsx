import { useState } from 'react';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { deleteDefect, closeDefect } from '@/services';
import { toast } from '@/lib/toast';
import type { DefectReport } from '@/services/contracts/defectAgent';
import { DefectStatus, DefectSeverity } from '@/services/contracts/defectAgent';
import {
  ArrowRight, Clock, Trash2, Check, Bug,
  AlertTriangle, AlertCircle, Info, MinusCircle,
  MessageCircle, CheckCircle, Paperclip,
} from 'lucide-react';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';

interface DefectListRowProps {
  defect: DefectReport;
  isRead: boolean;
}

const severityConfig: Record<string, { label: string; color: string; bgColor: string; icon: typeof AlertTriangle }> = {
  [DefectSeverity.Critical]: { label: '致命', color: '#ef4444', bgColor: 'rgba(239,68,68,0.15)', icon: AlertTriangle },
  [DefectSeverity.Major]: { label: '严重', color: '#f97316', bgColor: 'rgba(249,115,22,0.15)', icon: AlertCircle },
  [DefectSeverity.Minor]: { label: '一般', color: '#eab308', bgColor: 'rgba(234,179,8,0.15)', icon: Info },
  [DefectSeverity.Trivial]: { label: '轻微', color: '#22c55e', bgColor: 'rgba(34,197,94,0.15)', icon: MinusCircle },
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

export function DefectListRow({ defect, isRead }: DefectListRowProps) {
  const { selectedDefectId, setSelectedDefectId, removeDefectFromList, updateDefectInList, loadStats } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const [deleting, setDeleting] = useState(false);
  const [completing, setCompleting] = useState(false);

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

  const isArchived = defect.status === DefectStatus.Resolved || defect.status === DefectStatus.Rejected;
  const attachmentCount = (defect.attachments || []).length;

  // 未读/已读状态标签逻辑（与 DefectCard 相同）
  const currentRole =
    userId && defect.reporterId === userId
      ? 'reporter'
      : userId && defect.assigneeId === userId
      ? 'assignee'
      : null;
  const oppositeRole = currentRole === 'reporter' ? 'assignee' : currentRole === 'assignee' ? 'reporter' : null;
  const myUnread = currentRole === 'reporter'
    ? defect.reporterUnread
    : currentRole === 'assignee'
    ? defect.assigneeUnread
    : undefined;
  const peerUnread = oppositeRole === 'reporter'
    ? defect.reporterUnread
    : oppositeRole === 'assignee'
    ? defect.assigneeUnread
    : undefined;

  const lastCommentByMe = defect.lastCommentBy === currentRole;
  const lastCommentByPeer = defect.lastCommentBy === oppositeRole;

  let lastActor: 'me' | 'peer' | null = null;
  let lastAction: 'comment' | 'read' | 'create' | null = null;

  if (lastCommentByMe) {
    if (peerUnread === false) { lastActor = 'peer'; lastAction = 'read'; }
    else { lastActor = 'me'; lastAction = 'comment'; }
  } else if (lastCommentByPeer) {
    if (myUnread === false) { lastActor = 'me'; lastAction = 'read'; }
    else { lastActor = 'peer'; lastAction = 'comment'; }
  } else {
    if (currentRole === 'reporter') {
      if (peerUnread === false) { lastActor = 'peer'; lastAction = 'read'; }
      else { lastActor = 'me'; lastAction = 'create'; }
    } else if (currentRole === 'assignee') {
      if (myUnread === false) { lastActor = 'me'; lastAction = 'read'; }
      else { lastActor = 'peer'; lastAction = 'create'; }
    }
  }

  const showMyUnread = !isArchived && myUnread === true;

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定要删除此缺陷吗？此操作不可撤销。')) return;
    setDeleting(true);
    try {
      const res = await deleteDefect({ id: defect.id });
      if (res.success) { removeDefectFromList(defect.id); loadStats(); toast.success('缺陷已删除'); }
      else { toast.error(res.error?.message || '删除失败'); }
    } catch (e) { toast.error(String(e)); }
    finally { setDeleting(false); }
  };

  const handleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCompleting(true);
    try {
      const res = await closeDefect({ id: defect.id });
      if (res.success && res.data?.defect) { updateDefectInList(res.data.defect); toast.success('已完成'); loadStats(); }
      else { toast.error(res.error?.message || '操作失败'); }
    } catch (err) { toast.error(String(err)); }
    finally { setCompleting(false); }
  };

  // 状态标签的简化版本（适配行内布局）
  const renderStatusBadge = () => {
    if (isArchived) {
      if (defect.status === DefectStatus.Resolved) {
        return (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
            style={{ background: 'rgba(120,220,180,0.15)', color: 'rgba(120,220,180,0.9)' }}
          >
            <Check size={10} />
            已完成
          </span>
        );
      }
      return (
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
          style={{ background: 'rgba(255,120,120,0.15)', color: 'rgba(255,120,120,0.9)' }}
        >
          驳回
        </span>
      );
    }

    if (showMyUnread && currentRole === 'assignee') {
      return (
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0"
          style={{
            background: 'rgba(255, 100, 100, 0.25)', color: 'rgba(255, 120, 120, 1)',
            border: '1px solid rgba(255, 100, 100, 0.6)',
          }}
        >
          <Bug size={10} />
          新缺陷
        </span>
      );
    }
    if (showMyUnread && currentRole === 'reporter') {
      return (
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0"
          style={{
            background: 'rgba(120, 220, 180, 0.25)', color: 'rgba(120, 220, 180, 1)',
            border: '1px solid rgba(120, 220, 180, 0.6)',
          }}
        >
          <MessageCircle size={10} />
          新回复
        </span>
      );
    }

    if (lastActor === 'me' && lastAction === 'comment') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
          style={{ background: 'rgba(120,220,180,0.14)', color: 'rgba(120,220,180,0.9)', border: '1px solid rgba(120,220,180,0.4)' }}>
          <MessageCircle size={10} />已评
        </span>
      );
    }
    if (lastActor === 'me' && lastAction === 'read') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
          style={{ background: 'rgba(140,190,255,0.12)', color: 'rgba(140,190,255,0.95)', border: '1px solid rgba(140,190,255,0.45)' }}>
          <CheckCircle size={10} />已读
        </span>
      );
    }
    if (lastActor === 'peer' && lastAction === 'comment') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
          style={{ background: 'rgba(120,220,180,0.14)', color: 'rgba(120,220,180,0.9)', border: '1px solid rgba(120,220,180,0.4)' }}>
          <MessageCircle size={10} />对方已评
        </span>
      );
    }
    if (lastActor === 'peer' && lastAction === 'read') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
          style={{ background: 'rgba(140,190,255,0.12)', color: 'rgba(140,190,255,0.95)', border: '1px solid rgba(140,190,255,0.45)' }}>
          <CheckCircle size={10} />对方已读
        </span>
      );
    }
    if (lastActor === 'me' && lastAction === 'create') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
          style={{ background: 'rgba(255,200,80,0.18)', color: 'rgba(255,200,80,0.95)', border: '1px solid rgba(255,200,80,0.4)' }}>
          已提交
        </span>
      );
    }
    if (lastActor === 'peer' && lastAction === 'create') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0"
          style={{ background: 'rgba(255,200,80,0.18)', color: 'rgba(255,200,80,0.95)', border: '1px solid rgba(255,200,80,0.4)' }}>
          对方已提交
        </span>
      );
    }

    return null;
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={[
        'group flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none transition-colors',
        'hover:bg-white/[0.04]',
        isSelected ? 'bg-white/[0.06]' : '',
      ].join(' ')}
      style={{
        borderBottom: '1px solid var(--border-subtle)',
      }}
      onClick={() => setSelectedDefectId(isSelected ? null : defect.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSelectedDefectId(isSelected ? null : defect.id);
        }
      }}
    >
      {/* 严重性色条 */}
      <div
        className="w-1 h-6 rounded-full flex-shrink-0"
        style={{ background: severity.color }}
      />

      {/* 未读指示点 */}
      {!isRead && !isArchived && (
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: 'rgba(100, 160, 255, 0.9)', boxShadow: '0 0 6px rgba(100, 160, 255, 0.5)' }}
          title="未查看"
        />
      )}
      {(isRead || isArchived) && <div className="w-2 flex-shrink-0" />}

      {/* 严重性 */}
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
        style={{ background: severity.bgColor, color: severity.color }}
      >
        <SeverityIcon size={10} />
        {severity.label}
      </div>

      {/* 标题 - 已读变灰，tooltip 显示编号 */}
      <span
        className="text-[13px] font-medium truncate flex-1 min-w-0 transition-colors"
        style={{
          color: isRead ? 'var(--text-muted)' : 'var(--text-primary)',
          opacity: isRead ? 0.7 : 1,
        }}
        title={`${defect.defectNo} · ${title}`}
      >
        {title}
      </span>

      {/* 状态标签 */}
      {renderStatusBadge()}

      {/* 附件数量 */}
      {attachmentCount > 0 && (
        <span
          className="inline-flex items-center gap-1 text-[10px] flex-shrink-0"
          style={{ color: 'var(--text-muted)' }}
        >
          <Paperclip size={10} />
          {attachmentCount}
        </span>
      )}

      {/* 提交者 → 处理者 */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <img
          src={reporterAvatarUrl}
          alt={reporterDisplayName}
          className="h-4 w-4 rounded-full object-cover"
          style={{
            border: isReporterMe ? '1px solid rgba(255,255,255,0.5)' : '1px solid var(--border-subtle)',
          }}
          onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = resolveNoHeadAvatarUrl(); }}
          title={reporterDisplayName}
        />
        <ArrowRight size={10} className="opacity-40 flex-shrink-0" />
        <img
          src={assigneeAvatarUrl}
          alt={assigneeDisplayName}
          className="h-4 w-4 rounded-full object-cover"
          style={{
            border: isAssigneeMe ? '1px solid rgba(255,255,255,0.5)' : '1px solid var(--border-subtle)',
          }}
          onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = resolveNoHeadAvatarUrl(); }}
          title={assigneeDisplayName}
        />
      </div>

      {/* 时间 */}
      <span
        className="text-[10px] flex items-center gap-1 flex-shrink-0 w-[64px] justify-end"
        style={{ color: 'var(--text-muted)' }}
      >
        <Clock size={10} />
        {formatDate(defect.createdAt)}
      </span>

      {/* 操作按钮 */}
      <div
        className={[
          'flex items-center gap-1 flex-shrink-0',
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
            className="h-5 w-5 p-0 rounded gap-0 hover:bg-white/10"
            onClick={handleComplete}
            disabled={completing}
            title="完成"
            style={{ color: 'var(--text-primary)' }}
          >
            <Check size={10} />
          </Button>
        )}
      </div>
    </div>
  );
}
