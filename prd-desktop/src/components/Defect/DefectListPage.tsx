import { useEffect, useMemo } from 'react';
import { useDefectStore } from '../../stores/defectStore';
import { useAuthStore } from '../../stores/authStore';
import type { DefectReport } from '../../types';
import DefectSubmitPanel from './DefectSubmitPanel';
import DefectDetailPanel from './DefectDetailPanel';

// ━━━ 常量 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const severityConfig: Record<string, { label: string; color: string; bg: string }> = {
  critical: { label: '致命', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
  major:    { label: '严重', color: '#f97316', bg: 'rgba(249,115,22,0.15)' },
  minor:    { label: '一般', color: '#eab308', bg: 'rgba(234,179,8,0.15)' },
  trivial:  { label: '轻微', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
};

const statusLabel: Record<string, string> = {
  draft: '草稿',
  submitted: '待处理',
  assigned: '已分配',
  processing: '处理中',
  verifying: '待验收',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭',
};

const ARCHIVED_STATUSES = ['resolved', 'rejected', 'closed'];

// ━━━ 工具函数 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function timeAgo(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString('zh-CN');
}

// ━━━ 列表行子组件 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function DefectRow({ defect, isSelected, userId, onSelect }: {
  defect: DefectReport;
  isSelected: boolean;
  userId?: string;
  onSelect: () => void;
}) {
  const severity = severityConfig[defect.severity ?? ''] ?? severityConfig.minor;
  const title = defect.title || defect.rawContent?.slice(0, 60) || '无标题';
  const isArchived = ARCHIVED_STATUSES.includes(defect.status);

  // 未读逻辑
  const currentRole = userId && defect.reporterId === userId ? 'reporter'
    : userId && defect.assigneeId === userId ? 'assignee'
    : null;
  const myUnread = currentRole === 'reporter' ? defect.reporterUnread
    : currentRole === 'assignee' ? defect.assigneeUnread
    : undefined;
  const showUnread = !isArchived && myUnread === true;

  // 状态标签
  const renderBadge = () => {
    if (isArchived) {
      if (defect.status === 'resolved' || defect.status === 'closed') {
        return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(120,220,180,0.15)', color: 'rgba(120,220,180,0.9)' }}>已完成</span>;
      }
      return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(255,120,120,0.15)', color: 'rgba(255,120,120,0.9)' }}>已驳回</span>;
    }
    if (defect.status === 'verifying') {
      return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(180,140,255,0.15)', color: 'rgba(180,140,255,0.9)' }}>待验收</span>;
    }
    if (showUnread && currentRole === 'assignee') {
      return <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium" style={{ background: 'rgba(255,100,100,0.25)', color: 'rgba(255,120,120,1)', border: '1px solid rgba(255,100,100,0.6)' }}>新缺陷</span>;
    }
    if (showUnread && currentRole === 'reporter') {
      return <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium" style={{ background: 'rgba(120,220,180,0.25)', color: 'rgba(120,220,180,1)', border: '1px solid rgba(120,220,180,0.6)' }}>新回复</span>;
    }
    return <span className="text-[10px] text-text-secondary">{statusLabel[defect.status] || defect.status}</span>;
  };

  return (
    <button
      onClick={onSelect}
      className={`group w-full text-left flex items-center gap-2.5 px-3 py-2.5 transition-colors ${
        isSelected
          ? 'bg-primary-500/10 ring-1 ring-primary-500/20'
          : 'hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      {/* 严重性色条 */}
      <div className="w-1 h-6 rounded-full shrink-0" style={{ background: severity.color }} />

      {/* 未读点 */}
      {showUnread ? (
        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'rgba(100,160,255,0.9)', boxShadow: '0 0 6px rgba(100,160,255,0.5)' }} />
      ) : (
        <div className="w-2 shrink-0" />
      )}

      {/* 严重性标签 */}
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0" style={{ background: severity.bg, color: severity.color }}>
        {severity.label}
      </span>

      {/* 标题 */}
      <span
        className="text-[13px] font-medium truncate flex-1 min-w-0"
        style={{ opacity: myUnread === false && !showUnread ? 0.6 : 1 }}
        title={`${defect.defectNo} · ${title}`}
      >
        {title}
      </span>

      {/* 状态标签 */}
      <div className="shrink-0">{renderBadge()}</div>

      {/* 截图缩略图 */}
      {(() => {
        const imgs = (defect.attachments ?? []).filter((a) => a.mimeType?.startsWith('image/'));
        if (!imgs.length) return null;
        return (
          <div className="flex items-center gap-1 shrink-0">
            {imgs.slice(0, 2).map((att) => (
              <div
                key={att.id}
                className="w-6 h-6 rounded overflow-hidden shrink-0"
                style={{ background: 'rgba(128,128,128,0.1)', border: '1px solid rgba(128,128,128,0.2)' }}
              >
                <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" />
              </div>
            ))}
            {imgs.length > 2 && (
              <span className="text-[9px] text-text-secondary">+{imgs.length - 2}</span>
            )}
          </div>
        );
      })()}

      {/* 附件数 */}
      {(defect.attachments?.length ?? 0) > 0 && (
        <span className="text-[10px] text-text-secondary shrink-0 flex items-center gap-0.5">
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
          {defect.attachments!.length}
        </span>
      )}

      {/* 提交者 → 处理者 */}
      <div className="flex items-center gap-1 shrink-0">
        <span
          className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium shrink-0"
          style={{
            background: userId && defect.reporterId === userId ? 'rgba(100,160,255,0.2)' : 'rgba(128,128,128,0.15)',
            color: userId && defect.reporterId === userId ? 'rgba(100,160,255,1)' : 'var(--text-secondary)',
            border: userId && defect.reporterId === userId ? '1px solid rgba(100,160,255,0.4)' : '1px solid transparent',
          }}
          title={defect.reporterName || '提交者'}
        >
          {(defect.reporterName ?? '?')[0]}
        </span>
        <svg className="w-2.5 h-2.5 text-text-secondary opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        <span
          className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium shrink-0"
          style={{
            background: userId && defect.assigneeId === userId ? 'rgba(120,220,180,0.2)' : 'rgba(128,128,128,0.15)',
            color: userId && defect.assigneeId === userId ? 'rgba(120,220,180,1)' : 'var(--text-secondary)',
            border: userId && defect.assigneeId === userId ? '1px solid rgba(120,220,180,0.4)' : '1px solid transparent',
          }}
          title={defect.assigneeName || '未指派'}
        >
          {(defect.assigneeName ?? '?')[0]}
        </span>
      </div>

      {/* 缺陷编号 + 时间 */}
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className="text-[9px] font-mono text-text-secondary" style={{ opacity: 0.7 }}>
          {defect.defectNo}
        </span>
        <span className="text-[10px] text-text-secondary">
          {timeAgo(defect.updatedAt || defect.createdAt)}
        </span>
      </div>
    </button>
  );
}

// ━━━ 主页面 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function DefectListPage() {
  const {
    defects, loading, stats,
    showSubmitPanel, setShowSubmitPanel,
    selectedDefectId, setSelectedDefectId,
    tab, setTab, statusFilter, setStatusFilter,
    loadDefects, loadStats,
  } = useDefectStore();

  const userId = useAuthStore((s) => s.user?.userId);

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

  // 按 tab 和 statusFilter 过滤
  const filteredDefects = useMemo(() => {
    let list = defects;
    if (userId) {
      if (tab === 'received') {
        list = list.filter((d) => d.assigneeId === userId);
      } else {
        list = list.filter((d) => d.reporterId === userId);
      }
    }
    if (statusFilter) {
      list = list.filter((d) => d.status === statusFilter);
    }
    return list;
  }, [defects, userId, tab, statusFilter]);

  // 统计未读数
  const receivedUnread = useMemo(() => {
    if (!userId) return 0;
    return defects.filter((d) => d.assigneeId === userId && d.assigneeUnread === true && !ARCHIVED_STATUSES.includes(d.status)).length;
  }, [defects, userId]);

  const submittedUnread = useMemo(() => {
    if (!userId) return 0;
    return defects.filter((d) => d.reporterId === userId && d.reporterUnread === true && !ARCHIVED_STATUSES.includes(d.status)).length;
  }, [defects, userId]);

  const selectedDefect = defects.find((d) => d.id === selectedDefectId);

  // 状态筛选选项
  const statusOptions = tab === 'received'
    ? [
        { value: 'submitted', label: '待处理' },
        { value: 'processing', label: '处理中' },
        { value: 'verifying', label: '待验收' },
        { value: 'resolved', label: '已解决' },
        { value: 'rejected', label: '已驳回' },
      ]
    : [
        { value: 'draft', label: '草稿' },
        { value: 'submitted', label: '已提交' },
        { value: 'processing', label: '处理中' },
        { value: 'verifying', label: '待验收' },
        { value: 'resolved', label: '已解决' },
        { value: 'rejected', label: '已驳回' },
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

      {/* Tab 切换 + 状态筛选 */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-black/5 dark:border-white/10">
        <div className="flex rounded-lg bg-black/5 dark:bg-white/5 p-0.5">
          <button
            onClick={() => setTab('received')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              tab === 'received'
                ? 'bg-white dark:bg-white/15 shadow-sm font-medium'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            收到的
            {receivedUnread > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-medium bg-red-500 text-white">
                {receivedUnread > 9 ? '9+' : receivedUnread}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('submitted')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              tab === 'submitted'
                ? 'bg-white dark:bg-white/15 shadow-sm font-medium'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            我提交的
            {submittedUnread > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-medium bg-green-500 text-white">
                {submittedUnread > 9 ? '9+' : submittedUnread}
              </span>
            )}
          </button>
        </div>

        {/* 状态筛选 */}
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setStatusFilter(null)}
            className={`px-2 py-0.5 text-[11px] rounded-full transition-colors ${
              !statusFilter
                ? 'bg-primary-500/15 text-primary-500 font-medium'
                : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5'
            }`}
          >
            全部
          </button>
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(statusFilter === opt.value ? null : opt.value)}
              className={`px-2 py-0.5 text-[11px] rounded-full transition-colors ${
                statusFilter === opt.value
                  ? 'bg-primary-500/15 text-primary-500 font-medium'
                  : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && defects.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
            加载中...
          </div>
        ) : filteredDefects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-text-secondary text-sm">
            <p>暂无缺陷</p>
            {defects.length === 0 && (
              <button
                onClick={() => setShowSubmitPanel(true)}
                className="mt-2 text-primary-500 hover:underline text-sm"
              >
                提交第一个缺陷
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-black/5 dark:divide-white/5">
            {filteredDefects.map((defect) => (
              <DefectRow
                key={defect.id}
                defect={defect}
                isSelected={selectedDefectId === defect.id}
                userId={userId}
                onSelect={() => setSelectedDefectId(defect.id)}
              />
            ))}
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
