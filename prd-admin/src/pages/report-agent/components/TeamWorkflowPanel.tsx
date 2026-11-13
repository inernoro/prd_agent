import { useState, useEffect, useCallback } from 'react';
import { Workflow as WorkflowIcon, Play, RefreshCw, Clock, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { bindTeamWorkflow, getTeamWorkflow, listWorkflows, runTeamWorkflow } from '@/services';
import type { TeamWorkflowInfo } from '@/services/contracts/reportAgent';
import type { Workflow } from '@/services/contracts/workflowAgent';

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
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getTeamWorkflow({ teamId });
      if (!response.success || !response.data) {
        setInfo(null);
        setError(response.error?.message || '暂时无法读取采集工作流，请重试。');
        return;
      }
      setInfo(response.data);
      setSelection(response.data.workflow?.id || '');
      if (!response.data.canManage) {
        setWorkflows([]);
        return;
      }
      const visible: Workflow[] = [];
      let page = 1;
      while (true) {
        const result = await listWorkflows({ page, pageSize: 100 });
        if (!result.success || !result.data) {
          setError(result.error?.message || '暂时无法读取可见工作流，请重试。');
          setWorkflows([]);
          return;
        }
        visible.push(...result.data.items);
        if (visible.length >= result.data.total || result.data.items.length === 0) break;
        page += 1;
      }
      setWorkflows(visible);
    } catch {
      setInfo(null);
      setError('暂时无法读取采集工作流，请重试。');
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  const handleBinding = async (workflowId: string | null) => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await bindTeamWorkflow({ teamId, workflowId });
      if (!response.success || !response.data) {
        setError(response.error?.message || '暂时无法确认绑定结果，请刷新核对。');
        return;
      }
      await load();
      setNotice(response.data?.workflowId ? '采集工作流绑定已保存。' : '采集工作流已解绑。');
    } catch {
      setError('暂时无法确认绑定结果，请刷新核对。');
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const response = await runTeamWorkflow({ teamId });
      if (!response.success) setError(response.error?.message || '采集未能开始，请重试。');
      else {
        setNotice('已发起采集，可刷新查看执行结果。');
        await load();
      }
    } catch {
      setError('采集未能开始，请重试。');
    } finally {
      setRunning(false);
    }
  };

  const lastExecution = info?.lastExecution;
  const status = lastExecution ? executionStatusConfig[lastExecution.status] : null;
  const StatusIcon = status?.icon || Clock;
  const hasBoundOption = workflows.some((workflow) => workflow.id === info?.workflow?.id);

  return (
    <GlassCard className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          <WorkflowIcon size={14} style={{ color: 'var(--accent-primary)' }} />数据采集工作流
        </h3>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading || saving || running} aria-label="刷新采集工作流">
          {loading ? <MapSpinner size={12} /> : <RefreshCw size={12} />}
        </Button>
      </div>
      {loading && <div role="status" className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}><MapSpinner size={12} />正在读取工作流与可见来源…</div>}
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{error}</p>}
      {notice && <p role="status" className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{notice}</p>}
      {info && (
        <>
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{info.workflow ? `当前工作流：${info.workflow.name}` : '未绑定采集工作流'}</p>
          {info.canManage && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                选择已有采集工作流
                <select value={selection} onChange={(event) => setSelection(event.target.value)} disabled={loading || saving || running} className="w-full min-w-0 rounded-lg px-2 py-1.5" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>
                  <option value="">请选择已有工作流</option>
                  {info.workflow && !hasBoundOption && <option value={info.workflow.id}>{info.workflow.name}（当前已绑定）</option>}
                  {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
                </select>
              </label>
              <Button variant="primary" size="sm" disabled={loading || saving || running || !selection || selection === info.workflow?.id} onClick={() => void handleBinding(selection)}>{saving ? <><MapSpinner size={12} />保存中…</> : '保存绑定'}</Button>
              {info.workflow && <Button variant="secondary" size="sm" disabled={loading || saving || running} onClick={() => void handleBinding(null)}>解绑</Button>}
            </div>
          )}
          {info.canManage && !loading && workflows.length === 0 && !info.workflow && !error && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>没有可见的已有工作流。请先在工作流智能体准备采集流程，再回到这里绑定。</p>}
          {info.workflow && (
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              {info.canManage && <Button variant="primary" size="sm" onClick={() => void handleRun()} disabled={loading || saving || running}><Play size={12} />{running ? <><MapSpinner size={12} />执行中…</> : '立即执行'}</Button>}
              {lastExecution ? (
                <>
                  <span className="inline-flex items-center gap-1" style={{ color: status?.color || 'var(--text-secondary)' }}>{lastExecution.status === 'running' ? <MapSpinner size={12} /> : <StatusIcon size={12} />}{status?.label || lastExecution.status}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{new Date(lastExecution.createdAt).toLocaleString()}</span>
                </>
              ) : <span style={{ color: 'var(--text-muted)' }}>尚未执行采集。</span>}
            </div>
          )}
        </>
      )}
    </GlassCard>
  );
}
