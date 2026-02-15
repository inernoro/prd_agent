import { useEffect, useState } from 'react';
import { ArrowLeft, Play, RefreshCw, XCircle, Eye } from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { executeWorkflow, cancelExecution } from '@/services';
import { ExecutionStatusLabels } from '@/services/contracts/workflowAgent';

const statusColors: Record<string, string> = {
  queued: 'bg-yellow-500/10 text-yellow-600',
  running: 'bg-blue-500/10 text-blue-600',
  completed: 'bg-green-500/10 text-green-600',
  failed: 'bg-red-500/10 text-red-600',
  cancelled: 'bg-gray-500/10 text-gray-500',
};

export function ExecutionListPanel() {
  const {
    selectedWorkflow, executions, executionsTotal, loading,
    setViewMode, setSelectedExecution, addExecution,
    loadExecutions,
  } = useWorkflowStore();

  const [statusFilter, setStatusFilter] = useState('');
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    loadExecutions(selectedWorkflow?.id, statusFilter || undefined);
  }, [selectedWorkflow?.id, statusFilter, loadExecutions]);

  const handleExecute = async () => {
    if (!selectedWorkflow) return;
    setExecuting(true);
    const res = await executeWorkflow({ id: selectedWorkflow.id });
    if (res.success && res.data) {
      addExecution(res.data.execution);
    }
    setExecuting(false);
  };

  const handleCancel = async (executionId: string) => {
    if (!confirm('确定取消此次执行？')) return;
    await cancelExecution(executionId);
    loadExecutions(selectedWorkflow?.id, statusFilter || undefined);
  };

  const handleViewDetail = (execId: string) => {
    const exec = executions.find((e) => e.id === execId);
    if (exec) {
      setSelectedExecution(exec);
      setViewMode('execution-detail');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode('list')}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">
              {selectedWorkflow?.icon || '🔄'} {selectedWorkflow?.name} - 执行历史
            </h1>
            <p className="text-xs text-muted-foreground">共 {executionsTotal} 条记录</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadExecutions(selectedWorkflow?.id, statusFilter || undefined)}
            className="p-1.5 rounded-md hover:bg-accent transition-colors"
            title="刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={handleExecute}
            disabled={executing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {executing ? '提交中...' : '触发执行'}
          </button>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex gap-2">
        {['', 'queued', 'running', 'completed', 'failed', 'cancelled'].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              statusFilter === s
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:bg-accent'
            }`}
          >
            {s === '' ? '全部' : ExecutionStatusLabels[s] || s}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && <div className="text-center py-8 text-muted-foreground text-sm">加载中...</div>}

      {/* Empty */}
      {!loading && executions.length === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm">暂无执行记录</div>
      )}

      {/* Execution list */}
      <div className="space-y-2">
        {executions.map((exec) => (
          <div
            key={exec.id}
            className="rounded-lg border border-border p-4 hover:shadow-sm transition-all cursor-pointer bg-card"
            onClick={() => handleViewDetail(exec.id)}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[exec.status] || ''}`}>
                  {ExecutionStatusLabels[exec.status] || exec.status}
                </span>
                <span className="text-xs text-muted-foreground font-mono">{exec.id.substring(0, 8)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {(exec.status === 'queued' || exec.status === 'running') && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCancel(exec.id); }}
                    className="p-1 rounded hover:bg-destructive/10 text-destructive"
                    title="取消"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                )}
                <button className="p-1 rounded hover:bg-accent" title="查看详情">
                  <Eye className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Node progress */}
            <div className="flex gap-1 mb-2">
              {exec.nodeExecutions?.map((ne) => {
                const color =
                  ne.status === 'completed' ? 'bg-green-500' :
                  ne.status === 'running' ? 'bg-blue-500 animate-pulse' :
                  ne.status === 'failed' ? 'bg-red-500' :
                  'bg-gray-300';
                return (
                  <div
                    key={ne.nodeId}
                    className={`h-1.5 flex-1 rounded-full ${color}`}
                    title={`${ne.nodeName}: ${ne.status}`}
                  />
                );
              })}
            </div>

            {/* Meta */}
            <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
              <span>触发: {exec.triggerType === 'manual' ? '手动' : exec.triggerType}</span>
              {exec.triggeredByName && <span>操作人: {exec.triggeredByName}</span>}
              <span>{new Date(exec.createdAt).toLocaleString('zh-CN')}</span>
              {exec.completedAt && exec.startedAt && (
                <span>
                  耗时: {((new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime()) / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
