import { useEffect } from 'react';
import { Plus, Play, History, Share2, Workflow, Trash2, Tag } from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { createWorkflow, deleteWorkflow } from '@/services';
import { WorkflowDetailPanel } from './WorkflowDetailPanel';
import { ExecutionListPanel } from './ExecutionListPanel';
import { ExecutionDetailPanel } from './ExecutionDetailPanel';
import { SharePanel } from './SharePanel';
import type { Workflow as WorkflowType } from '@/services/contracts/workflowAgent';
import { NodeTypeLabels } from '@/services/contracts/workflowAgent';

export function WorkflowAgentPage() {
  const {
    workflows, loading, viewMode,
    setViewMode, setSelectedWorkflow, setSelectedExecution,
    loadWorkflows, addWorkflow, removeWorkflow,
  } = useWorkflowStore();

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  const handleCreate = async () => {
    const res = await createWorkflow({ name: '未命名工作流' });
    if (res.success && res.data) {
      addWorkflow(res.data.workflow);
      setSelectedWorkflow(res.data.workflow);
      setViewMode('detail');
    }
  };

  const handleDelete = async (wf: WorkflowType) => {
    if (!confirm(`确定删除「${wf.name}」？`)) return;
    const res = await deleteWorkflow(wf.id);
    if (res.success) removeWorkflow(wf.id);
  };

  const handleOpenDetail = (wf: WorkflowType) => {
    setSelectedWorkflow(wf);
    setViewMode('detail');
  };

  const handleOpenExecutions = (wf: WorkflowType) => {
    setSelectedWorkflow(wf);
    setViewMode('execution-list');
  };

  // Render sub-views
  if (viewMode === 'detail') return <WorkflowDetailPanel />;
  if (viewMode === 'execution-list') return <ExecutionListPanel />;
  if (viewMode === 'execution-detail') return <ExecutionDetailPanel />;
  if (viewMode === 'shares') return <SharePanel />;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Workflow className="w-5 h-5" />
            工作流引擎
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            创建自动化数据管线，从采集到分析到渲染一站式完成
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('shares')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-accent transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" />
            分享管理
          </button>
          <button
            onClick={handleCreate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            新建工作流
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      )}

      {/* Empty state */}
      {!loading && workflows.length === 0 && (
        <div className="text-center py-20 space-y-4">
          <Workflow className="w-12 h-12 mx-auto text-muted-foreground/40" />
          <div className="text-muted-foreground">还没有工作流，点击「新建工作流」开始</div>
        </div>
      )}

      {/* Workflow cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workflows.map((wf) => (
          <WorkflowCard
            key={wf.id}
            workflow={wf}
            onOpen={handleOpenDetail}
            onExecutions={handleOpenExecutions}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({
  workflow: wf,
  onOpen,
  onExecutions,
  onDelete,
}: {
  workflow: WorkflowType;
  onOpen: (wf: WorkflowType) => void;
  onExecutions: (wf: WorkflowType) => void;
  onDelete: (wf: WorkflowType) => void;
}) {
  const nodeTypeSummary = Object.entries(
    wf.nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.nodeType] = (acc[n.nodeType] || 0) + 1;
      return acc;
    }, {})
  );

  return (
    <div
      className="group rounded-lg border border-border p-4 hover:shadow-md transition-all cursor-pointer bg-card"
      onClick={() => onOpen(wf)}
    >
      {/* Title row */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">{wf.icon || '🔄'}</span>
          <h3 className="font-medium truncate">{wf.name}</h3>
        </div>
        <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${wf.isEnabled ? 'bg-green-500' : 'bg-gray-300'}`} />
      </div>

      {/* Description */}
      {wf.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{wf.description}</p>
      )}

      {/* Node types */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {nodeTypeSummary.map(([type, count]) => (
          <span
            key={type}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground"
          >
            {NodeTypeLabels[type] || type}
            {count > 1 && <span className="font-mono">x{count}</span>}
          </span>
        ))}
        {wf.nodes.length === 0 && (
          <span className="text-[10px] text-muted-foreground/50">暂无节点</span>
        )}
      </div>

      {/* Tags */}
      {wf.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {wf.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-600"
            >
              <Tag className="w-2.5 h-2.5" />
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-border/50">
        <div className="text-[10px] text-muted-foreground">
          {wf.executionCount > 0
            ? `已执行 ${wf.executionCount} 次`
            : '未执行'}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onExecutions(wf); }}
            className="p-1 rounded hover:bg-accent transition-colors"
            title="执行历史"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(wf); }}
            className="p-1 rounded hover:bg-destructive/10 text-destructive transition-colors"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
