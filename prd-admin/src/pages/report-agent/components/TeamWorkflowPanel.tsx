import { useState, useEffect, useCallback } from 'react';
import { Workflow, Play, RefreshCw, Clock, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { getTeamWorkflow, runTeamWorkflow } from '@/services';
import type { TeamWorkflowInfo } from '@/services/contracts/reportAgent';

interface TeamWorkflowPanelProps {
  teamId: string;
}

const executionStatusConfig: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
  completed: { label: '成功', icon: CheckCircle2, color: 'var(--text-success, #22c55e)' },
  failed: { label: '失败', icon: XCircle, color: 'var(--text-error, #ef4444)' },
  running: { label: '运行中', icon: RefreshCw, color: 'var(--accent-primary)' },
  cancelled: { label: '已取消', icon: AlertCircle, color: 'var(--text-tertiary)' },
};

export function TeamWorkflowPanel({ teamId }: TeamWorkflowPanelProps) {
  const [info, setInfo] = useState<TeamWorkflowInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTeamWorkflow({ teamId });
      if (res.success && res.data) setInfo(res.data);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await runTeamWorkflow({ teamId });
      if (res.success) {
        // Reload after a short delay to show updated status
        setTimeout(() => void load(), 2000);
      }
    } finally {
      setRunning(false);
    }
  };

  if (loading && !info) {
    return (
      <GlassCard className="p-3">
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          <RefreshCw size={12} className="animate-spin" /> 加载工作流信息...
        </div>
      </GlassCard>
    );
  }

  if (!info?.workflowId) {
    return (
      <GlassCard className="p-4 text-center">
        <Workflow size={24} className="mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} />
        <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>未绑定采集工作流</div>
        <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          绑定采集工作流后，系统可自动采集 TAPD、GitHub 等平台数据
        </div>
      </GlassCard>
    );
  }

  const lastExec = info.lastExecution;
  const statusCfg = lastExec ? executionStatusConfig[lastExec.status] : null;
  const StatusIcon = statusCfg?.icon || Clock;

  return (
    <GlassCard className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Workflow size={14} style={{ color: 'var(--accent-primary)' }} />
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            数据采集工作流
          </span>
          {info.templateKey && (
            <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
              {info.templateKey}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button variant="primary" size="sm" onClick={handleRun} disabled={running}>
            <Play size={12} className={running ? 'animate-pulse' : ''} />
            {running ? '执行中...' : '立即执行'}
          </Button>
        </div>
      </div>

      {info.workflowName && (
        <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          工作流: {info.workflowName}
        </div>
      )}

      {lastExec && (
        <div className="flex items-center gap-3 text-[12px] pt-1" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <div className="flex items-center gap-1">
            <StatusIcon size={12} style={{ color: statusCfg?.color }} className={lastExec.status === 'running' ? 'animate-spin' : ''} />
            <span style={{ color: statusCfg?.color }}>{statusCfg?.label || lastExec.status}</span>
          </div>
          <div style={{ color: 'var(--text-tertiary)' }}>
            {new Date(lastExec.startedAt).toLocaleString()}
          </div>
          {lastExec.durationMs != null && (
            <div style={{ color: 'var(--text-tertiary)' }}>
              耗时 {lastExec.durationMs < 1000 ? `${lastExec.durationMs}ms` : `${(lastExec.durationMs / 1000).toFixed(1)}s`}
            </div>
          )}
        </div>
      )}

      {!lastExec && (
        <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          尚未执行过，点击"立即执行"开始首次数据采集
        </div>
      )}
    </GlassCard>
  );
}
