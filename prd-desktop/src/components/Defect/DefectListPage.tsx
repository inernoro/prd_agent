import { useEffect, useMemo, useState } from 'react';
import { useDefectStore, type DefectFilter } from '../../stores/defectStore';
import { useAuthStore } from '../../stores/authStore';
import { invoke } from '../../lib/tauri';
import DefectSubmitPanel from './DefectSubmitPanel';
import DefectDetailPanel from './DefectDetailPanel';
import type { ApiResponse, DefectReport } from '../../types';

// ━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const severityConfig: Record<string, { label: string; color: string; bgColor: string }> = {
  critical: { label: '致命', color: '#ef4444', bgColor: 'rgba(239,68,68,0.15)' },
  major:    { label: '严重', color: '#f97316', bgColor: 'rgba(249,115,22,0.15)' },
  minor:    { label: '一般', color: '#eab308', bgColor: 'rgba(234,179,8,0.15)' },
  trivial:  { label: '轻微', color: '#22c55e', bgColor: 'rgba(34,197,94,0.15)' },
};

const ARCHIVED_STATUSES = ['closed', 'rejected'] as const;

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
  // Strip [IMG] tags for preview
  const clean = withoutFirstLine.replace(/\[IMG[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!clean) return '(暂无描述)';
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars) + '...';
}

// ━━━ Status Badge Logic (ported from web) ━━━━━━━━━━━━━━━━━━━

interface BadgeInfo {
  label: string;
  color: string;
  bg: string;
  border: string;
  pulse?: boolean;
}

function computeStatusBadge(defect: DefectReport, userId: string | undefined): BadgeInfo | null {
  const isArchived = (ARCHIVED_STATUSES as readonly string[]).includes(defect.status);

  if (isArchived) {
    if (defect.status === 'resolved' || defect.status === 'closed') {
      return { label: '已完成', color: 'rgba(120,220,180,0.9)', bg: 'rgba(120,220,180,0.15)', border: 'rgba(120,220,180,0.4)' };
    }
    return { label: '驳回', color: 'rgba(255,120,120,0.9)', bg: 'rgba(255,120,120,0.15)', border: 'rgba(255,120,120,0.4)' };
  }

  if (defect.status === 'verifying') {
    return { label: '待验收', color: 'rgba(180,140,255,0.9)', bg: 'rgba(180,140,255,0.15)', border: 'rgba(180,140,255,0.4)' };
  }

  const currentRole = userId && defect.reporterId === userId ? 'reporter'
    : userId && defect.assigneeId === userId ? 'assignee' : null;
  const oppositeRole = currentRole === 'reporter' ? 'assignee' : currentRole === 'assignee' ? 'reporter' : null;
  const myUnread = currentRole === 'reporter' ? defect.reporterUnread
    : currentRole === 'assignee' ? defect.assigneeUnread : undefined;
  const peerUnread = oppositeRole === 'reporter' ? defect.reporterUnread
    : oppositeRole === 'assignee' ? defect.assigneeUnread : undefined;

  // My unread = highest priority
  if (myUnread === true) {
    if (currentRole === 'assignee') {
      return { label: '新缺陷', color: 'rgba(255,120,120,1)', bg: 'rgba(255,100,100,0.25)', border: 'rgba(255,100,100,0.6)', pulse: true };
    }
    return { label: '新回复', color: 'rgba(120,220,180,1)', bg: 'rgba(120,220,180,0.25)', border: 'rgba(120,220,180,0.6)', pulse: true };
  }

  // Determine last actor
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

  if (lastActor === 'me' && lastAction === 'comment')
    return { label: '已评', color: 'rgba(120,220,180,0.9)', bg: 'rgba(120,220,180,0.14)', border: 'rgba(120,220,180,0.4)' };
  if (lastActor === 'me' && lastAction === 'read')
    return { label: '已读', color: 'rgba(140,190,255,0.95)', bg: 'rgba(140,190,255,0.12)', border: 'rgba(140,190,255,0.45)' };
  if (lastActor === 'me' && lastAction === 'create')
    return { label: '已提交', color: 'rgba(255,200,80,0.95)', bg: 'rgba(255,200,80,0.18)', border: 'rgba(255,200,80,0.4)' };
  if (lastActor === 'peer' && lastAction === 'comment')
    return { label: '对方已评', color: 'rgba(120,220,180,0.9)', bg: 'rgba(120,220,180,0.14)', border: 'rgba(120,220,180,0.4)' };
  if (lastActor === 'peer' && lastAction === 'read')
    return { label: '对方已读', color: 'rgba(140,190,255,0.95)', bg: 'rgba(140,190,255,0.12)', border: 'rgba(140,190,255,0.45)' };
  if (lastActor === 'peer' && lastAction === 'create')
    return { label: '对方已提交', color: 'rgba(255,200,80,0.95)', bg: 'rgba(255,200,80,0.18)', border: 'rgba(255,200,80,0.4)' };

  return null;
}

// ━━━ Main Component ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function DefectListPage() {
  const {
    defects, loading, stats, filter,
    showSubmitPanel, setShowSubmitPanel,
    selectedDefectId, setSelectedDefectId,
    loadDefects, loadStats, setFilter,
    removeDefectFromList, updateDefectInList,
  } = useDefectStore();
  const userId = useAuthStore((s) => s.user?.userId);
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  useEffect(() => {
    loadDefects();
    loadStats();
  }, []);

  // Keyboard shortcut: Cmd+B / Ctrl+B
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        const active = document.activeElement;
        const isInInput = active instanceof HTMLInputElement ||
                          active instanceof HTMLTextAreaElement ||
                          (active instanceof HTMLElement && active.isContentEditable);
        if (isInInput && !showSubmitPanel) return;
        e.preventDefault();
        e.stopPropagation();
        setShowSubmitPanel(!showSubmitPanel);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showSubmitPanel, setShowSubmitPanel]);

  // Filter by role
  const filteredDefects = useMemo(() => {
    if (!userId) return defects;
    if (filter === 'submitted') return defects.filter((d) => d.reporterId === userId);
    if (filter === 'assigned') return defects.filter((d) => d.assigneeId === userId);
    return defects;
  }, [defects, filter, userId]);

  // Split active / archived
  const { activeDefects, archivedDefects } = useMemo(() => {
    const active = filteredDefects.filter((d) => !(ARCHIVED_STATUSES as readonly string[]).includes(d.status));
    const archived = filteredDefects.filter((d) => (ARCHIVED_STATUSES as readonly string[]).includes(d.status));
    return { activeDefects: active, archivedDefects: archived };
  }, [filteredDefects]);

  const selectedDefect = defects.find((d) => d.id === selectedDefectId);

  // Quick actions
  const handleClose = async (defect: DefectReport) => {
    try {
      const resp = await invoke<ApiResponse<{ defect: DefectReport }>>('close_defect', { id: defect.id });
      if (resp.success && resp.data) {
        const updated = (resp.data as any).defect ?? resp.data;
        updateDefectInList(updated as DefectReport);
        loadStats();
      }
    } catch (err) {
      console.error('Failed to close defect:', err);
    }
  };

  const handleDelete = async (defect: DefectReport) => {
    if (!confirm('确定要删除此缺陷吗？')) return;
    try {
      const resp = await invoke<ApiResponse<{ deleted: boolean }>>('delete_defect', { id: defect.id });
      if (resp.success) {
        removeDefectFromList(defect.id);
        loadStats();
      }
    } catch (err) {
      console.error('Failed to delete defect:', err);
    }
  };

  const filterButtons: { key: DefectFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'submitted', label: '我提交的' },
    { key: 'assigned', label: '指派给我' },
  ];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">缺陷管理</h2>
          {stats && (
            <span className="text-xs text-text-secondary">
              共 {stats.total ?? defects.length} 个
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Filter buttons */}
          <div className="flex items-center gap-1 mr-2">
            {filterButtons.map((btn) => (
              <button
                key={btn.key}
                onClick={() => setFilter(btn.key)}
                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
                  filter === btn.key
                    ? 'bg-primary-500/15 text-primary-500 font-medium'
                    : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowSubmitPanel(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            提交缺陷
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && defects.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
            加载中...
          </div>
        ) : filteredDefects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-text-secondary text-sm gap-2">
            <svg className="w-10 h-10 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 116 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
            </svg>
            <p className="text-[13px] font-medium">
              {filter === 'submitted' ? '暂无提交的缺陷' : filter === 'assigned' ? '暂无收到的缺陷' : '暂无缺陷'}
            </p>
            <button
              onClick={() => setShowSubmitPanel(true)}
              className="text-primary-500 hover:underline text-sm"
            >
              提交第一个缺陷
            </button>
          </div>
        ) : (
          <div className="space-y-0">
            {/* Active defects */}
            {activeDefects.map((defect) => (
              <DefectListItem
                key={defect.id}
                defect={defect}
                userId={userId}
                isSelected={selectedDefectId === defect.id}
                onSelect={() => setSelectedDefectId(defect.id)}
                onClose={() => handleClose(defect)}
                onDelete={() => handleDelete(defect)}
              />
            ))}

            {/* Empty active hint */}
            {activeDefects.length === 0 && archivedDefects.length > 0 && (
              <div className="flex items-center justify-center py-6 text-text-secondary text-[12px]">
                暂无进行中的缺陷
              </div>
            )}

            {/* Archived section */}
            {archivedDefects.length > 0 && (
              <>
                <button
                  onClick={() => setArchivedCollapsed(!archivedCollapsed)}
                  className="flex items-center gap-2 px-4 py-2 w-full text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-t border-black/5 dark:border-white/5 mt-2"
                >
                  <svg className={`w-3.5 h-3.5 text-text-secondary transition-transform ${archivedCollapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <svg className="w-3.5 h-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
                  </svg>
                  <span className="text-[12px] font-medium text-text-secondary">已归档</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 text-text-secondary">
                    {archivedDefects.length}
                  </span>
                </button>
                {!archivedCollapsed && archivedDefects.map((defect) => (
                  <DefectListItem
                    key={defect.id}
                    defect={defect}
                    userId={userId}
                    isSelected={selectedDefectId === defect.id}
                    onSelect={() => setSelectedDefectId(defect.id)}
                    onClose={() => handleClose(defect)}
                    onDelete={() => handleDelete(defect)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {showSubmitPanel && <DefectSubmitPanel />}
      {selectedDefectId && selectedDefect && (
        <DefectDetailPanel
          defect={selectedDefect}
          onClose={() => setSelectedDefectId(null)}
        />
      )}
    </div>
  );
}

// ━━━ List Item ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface DefectListItemProps {
  defect: DefectReport;
  userId: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDelete: () => void;
}

function DefectListItem({ defect, userId, isSelected, onSelect, onClose, onDelete }: DefectListItemProps) {
  const badge = computeStatusBadge(defect, userId);
  const severity = severityConfig[defect.severity ?? 'minor'] ?? severityConfig.minor;
  const isArchived = (ARCHIVED_STATUSES as readonly string[]).includes(defect.status);
  const imageAttachments = (defect.attachments || []).filter((a) => a.mimeType?.startsWith('image/'));
  const attachmentCount = (defect.attachments || []).length;
  const isReporterMe = userId && defect.reporterId === userId;
  const isAssigneeMe = userId && defect.assigneeId === userId;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`group relative flex h-auto transition-colors cursor-pointer ${
        isSelected
          ? 'bg-primary-500/10'
          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
      }`}
      style={{ borderBottom: '1px solid rgba(128,128,128,0.08)' }}
    >
      {/* Severity color bar */}
      <div className="w-1 flex-shrink-0" style={{ background: severity.color }} />

      {/* Main content */}
      <div className="flex-1 min-w-0 px-3 py-2.5">
        {/* Row 1: badge + title + defect number + time */}
        <div className="flex items-center gap-2 mb-1">
          {/* Status badge */}
          {badge && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${badge.pulse ? 'animate-pulse' : ''}`}
              style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}
            >
              {badge.label}
            </span>
          )}

          {/* Severity tag */}
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
            style={{ background: severity.bgColor, color: severity.color }}
          >
            {severity.label}
          </span>

          {/* Title */}
          <span className="text-[13px] font-medium truncate flex-1 min-w-0" title={defect.title || defect.rawContent?.slice(0, 60)}>
            {defect.title || defect.rawContent?.slice(0, 60) || '无标题'}
          </span>

          {/* Defect number + time */}
          <div className="flex flex-col items-end gap-0.5 flex-shrink-0 ml-2">
            <span className="text-[10px] font-mono text-text-secondary">{defect.defectNo}</span>
            <span className="text-[10px] text-text-secondary">{formatDate(defect.createdAt)}</span>
          </div>
        </div>

        {/* Row 2: preview text */}
        <div className="text-[12px] text-text-secondary line-clamp-2 mb-1.5">
          {getPreviewText(defect.rawContent, 120)}
        </div>

        {/* Row 3: image thumbnails + attachment count */}
        {attachmentCount > 0 && (
          <div className="flex items-center gap-2 mb-1.5">
            {imageAttachments.slice(0, 3).map((att) => (
              <div
                key={att.id}
                className="w-10 h-10 rounded overflow-hidden flex-shrink-0"
                style={{ background: 'rgba(128,128,128,0.1)', border: '1px solid rgba(128,128,128,0.15)' }}
              >
                {att.url ? (
                  <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-text-secondary text-[10px]">IMG</div>
                )}
              </div>
            ))}
            {imageAttachments.length > 3 && (
              <span className="text-[10px] text-text-secondary">+{imageAttachments.length - 3}</span>
            )}
            {attachmentCount > imageAttachments.length && (
              <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                {attachmentCount - imageAttachments.length}
              </span>
            )}
          </div>
        )}

        {/* Row 4: reporter → assignee + quick actions */}
        <div className="flex items-center gap-2 text-[10px] text-text-secondary">
          {/* Reporter */}
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              background: 'rgba(128,128,128,0.08)',
              border: isReporterMe ? '1px solid rgba(255,255,255,0.4)' : '1px solid rgba(128,128,128,0.1)',
            }}
          >
            <span className="w-3 h-3 rounded-full bg-primary-500/20 flex items-center justify-center text-[8px] font-medium flex-shrink-0">
              {(defect.reporterName || 'U')[0]}
            </span>
            <span className="truncate max-w-[50px]">{defect.reporterName || '未知'}</span>
          </span>

          <svg className="w-3 h-3 opacity-40 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>

          {/* Assignee */}
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              background: 'rgba(128,128,128,0.08)',
              border: isAssigneeMe ? '1px solid rgba(255,255,255,0.4)' : '1px solid rgba(128,128,128,0.1)',
            }}
          >
            <span className="w-3 h-3 rounded-full bg-blue-500/20 flex items-center justify-center text-[8px] font-medium flex-shrink-0">
              {(defect.assigneeName || 'U')[0]}
            </span>
            <span className="truncate max-w-[50px]">{defect.assigneeName || '未指派'}</span>
          </span>

          <div className="flex-1" />

          {/* Quick action buttons (hover) */}
          <div className="flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
            {isArchived ? (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1 rounded hover:bg-red-500/20 transition-colors"
                title="删除"
              >
                <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="p-1 rounded hover:bg-green-500/20 transition-colors"
                title="完成"
              >
                <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Archived stamp overlay */}
      {isArchived && (
        <div className="absolute right-12 top-1/2 -translate-y-1/2 select-none pointer-events-none" style={{ transform: 'translate(0, -50%) rotate(-12deg)' }}>
          <div
            className="flex flex-col items-center px-3 py-1.5 rounded-lg"
            style={{
              border: defect.status === 'rejected'
                ? '2px solid rgba(255,120,120,0.5)'
                : '2px solid rgba(120,220,180,0.5)',
              background: defect.status === 'rejected'
                ? 'rgba(45,30,30,0.6)'
                : 'rgba(30,40,35,0.6)',
              backdropFilter: 'blur(4px)',
            }}
          >
            <span
              className="text-[18px] font-bold tracking-[0.15em] leading-none"
              style={{
                color: defect.status === 'rejected'
                  ? 'rgba(255,120,120,0.85)'
                  : 'rgba(120,220,180,0.85)',
              }}
            >
              {defect.status === 'rejected' ? '驳回' : '完成'}
            </span>
            <span
              className="text-[8px] mt-0.5 truncate max-w-[80px]"
              style={{
                color: defect.status === 'rejected'
                  ? 'rgba(255,120,120,0.6)'
                  : 'rgba(120,220,180,0.6)',
              }}
            >
              {defect.status === 'rejected'
                ? (defect.rejectedByName || '')
                : (defect.resolvedByName || '')}
              {defect.status === 'rejected' && defect.rejectReason ? `: ${defect.rejectReason}` : ''}
              {defect.status !== 'rejected' && defect.resolution ? `: ${defect.resolution}` : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
