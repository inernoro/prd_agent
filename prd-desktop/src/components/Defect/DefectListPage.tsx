import { useEffect } from 'react';
import { useDefectStore } from '../../stores/defectStore';
import { useAuthStore } from '../../stores/authStore';
import DefectSubmitPanel from './DefectSubmitPanel';
import DefectDetailPanel from './DefectDetailPanel';
import type { DefectReport } from '../../types';

const severityBadge: Record<string, { label: string; color: string }> = {
  critical: { label: '致命', color: 'bg-red-500' },
  major: { label: '严重', color: 'bg-orange-500' },
  minor: { label: '一般', color: 'bg-yellow-500' },
  trivial: { label: '轻微', color: 'bg-blue-500' },
};

const statusLabel: Record<string, string> = {
  draft: '草稿',
  submitted: '待处理',
  assigned: '已分配',
  processing: '处理中',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭',
};

/** 计算缺陷卡片的未读标签 */
function useUnreadBadge(defect: DefectReport) {
  const userId = useAuthStore((s) => s.user?.userId);
  const isReporter = defect.reporterId === userId;
  const isAssignee = defect.assigneeId === userId;
  const isArchived = defect.status === 'closed' || defect.status === 'rejected';

  if (isArchived) return null;

  // 我方未读 → 最高优先级闪动标签
  if (isReporter && defect.reporterUnread) {
    return { label: '新回复', color: 'rgb(120,220,180)', bg: 'rgba(120,220,180,0.2)', border: 'rgba(120,220,180,0.6)' };
  }
  if (isAssignee && defect.assigneeUnread) {
    return { label: '新缺陷', color: 'rgb(255,120,120)', bg: 'rgba(255,100,100,0.2)', border: 'rgba(255,100,100,0.6)' };
  }
  return null;
}

export default function DefectListPage() {
  const {
    defects, loading, stats,
    showSubmitPanel, setShowSubmitPanel,
    selectedDefectId, setSelectedDefectId,
    loadDefects, loadStats,
  } = useDefectStore();

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

  const selectedDefect = defects.find((d) => d.id === selectedDefectId);

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

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && defects.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
            加载中...
          </div>
        ) : defects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-text-secondary text-sm">
            <p>暂无缺陷</p>
            <button
              onClick={() => setShowSubmitPanel(true)}
              className="mt-2 text-primary-500 hover:underline text-sm"
            >
              提交第一个缺陷
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {defects.map((defect) => (
              <DefectListItem
                key={defect.id}
                defect={defect}
                isSelected={selectedDefectId === defect.id}
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

function DefectListItem({ defect, isSelected, onSelect }: { defect: DefectReport; isSelected: boolean; onSelect: () => void }) {
  const badge = useUnreadBadge(defect);
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${
        isSelected
          ? 'bg-primary-500/10 ring-1 ring-primary-500/20'
          : 'hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-text-secondary font-mono">{defect.defectNo}</span>
            {defect.severity && severityBadge[defect.severity] && (
              <span className="flex items-center gap-1 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full ${severityBadge[defect.severity].color}`} />
                {severityBadge[defect.severity].label}
              </span>
            )}
            {badge && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium animate-pulse"
                style={{
                  background: badge.bg,
                  color: badge.color,
                  border: `1px solid ${badge.border}`,
                  boxShadow: `0 0 6px ${badge.bg}`,
                }}
              >
                {badge.label}
              </span>
            )}
          </div>
          <p className="text-sm font-medium truncate">
            {defect.title || defect.rawContent?.slice(0, 60) || '无标题'}
          </p>
        </div>
        <span className="text-xs text-text-secondary whitespace-nowrap">
          {statusLabel[defect.status] || defect.status}
        </span>
      </div>
    </button>
  );
}
