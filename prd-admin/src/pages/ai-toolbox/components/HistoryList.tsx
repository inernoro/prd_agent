import { useToolboxStore } from '@/stores/toolboxStore';
import { Check, AlertCircle, Clock, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from '@/lib/dateUtils';

const STATUS_CONFIG = {
  Completed: {
    icon: Check,
    color: 'var(--status-success)',
    label: '已完成',
  },
  Failed: {
    icon: AlertCircle,
    color: 'var(--status-error)',
    label: '失败',
  },
  Running: {
    icon: Loader2,
    color: 'var(--accent-primary)',
    label: '运行中',
  },
  Pending: {
    icon: Clock,
    color: 'var(--text-muted)',
    label: '等待中',
  },
};

export function HistoryList() {
  const { runHistory, historyLoading, currentRunId, selectHistoryRun } = useToolboxStore();

  if (historyLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    );
  }

  if (runHistory.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          暂无历史记录
        </div>
        <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          发送消息开始使用百宝箱
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runHistory.map((run) => {
        const config = STATUS_CONFIG[run.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.Pending;
        const Icon = config.icon;
        const isActive = run.id === currentRunId;

        return (
          <button
            key={run.id}
            onClick={() => selectHistoryRun(run)}
            className="w-full p-3 rounded-lg border text-left transition-all hover:border-[var(--accent-primary)]/50"
            style={{
              background: isActive ? 'var(--accent-primary)/5' : 'var(--bg-elevated)',
              borderColor: isActive ? 'var(--accent-primary)/50' : 'var(--border-default)',
            }}
          >
            <div className="flex items-start gap-2">
              <Icon
                size={14}
                className={config.icon === Loader2 ? 'animate-spin' : ''}
                style={{ color: config.color, marginTop: 2 }}
              />
              <div className="flex-1 min-w-0">
                <div
                  className="text-sm truncate"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {run.userMessage}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{
                      background: `${config.color}20`,
                      color: config.color,
                    }}
                  >
                    {config.label}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {run.steps.length} 步骤
                  </span>
                  {run.artifacts.length > 0 && (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {run.artifacts.length} 成果
                    </span>
                  )}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {formatDistanceToNow(new Date(run.createdAt))}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
