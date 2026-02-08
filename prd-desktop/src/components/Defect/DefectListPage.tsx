import { useEffect } from 'react';
import { useDefectStore } from '../../stores/defectStore';
import DefectSubmitPanel from './DefectSubmitPanel';
import DefectDetailPanel from './DefectDetailPanel';

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
              <button
                key={defect.id}
                onClick={() => setSelectedDefectId(defect.id)}
                className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${
                  selectedDefectId === defect.id
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
