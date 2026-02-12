import { useEffect, useState } from 'react';
import { Play, History, Workflow, Trash2, Clock, CheckCircle2, AlertCircle, Settings2 } from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { createWorkflow, deleteWorkflow, executeWorkflow, updateWorkflow } from '@/services';
import { ExecutionListPanel } from './ExecutionListPanel';
import { ExecutionDetailPanel } from './ExecutionDetailPanel';
import { SharePanel } from './SharePanel';
import type { Workflow as WorkflowType, WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';

// ─────────────────────────────────────────────
// 预置模板定义
// ─────────────────────────────────────────────

interface WorkflowTemplate {
  key: string;
  icon: string;
  name: string;
  description: string;
  variables: WorkflowVariable[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  tags: string[];
}

const TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'tapd-monthly-report',
    icon: '📊',
    name: 'TAPD 月度质量报告',
    description: '自动从 TAPD 拉取 Bug 和 Story 数据，统计分析后生成月度质量报告',
    tags: ['tapd', 'quality', 'monthly'],
    variables: [
      { key: 'TAPD_WORKSPACE_ID', label: 'TAPD 工作空间 ID', type: 'string', required: true, isSecret: false },
      { key: 'TAPD_API_TOKEN', label: 'TAPD API Token', type: 'string', required: true, isSecret: true },
      { key: 'TARGET_MONTH', label: '目标月份', type: 'string', required: false, isSecret: false, defaultValue: '{{now.year}}-{{now.month}}' },
    ],
    nodes: [
      { nodeId: 'n1', name: 'Bug 数据采集', nodeType: 'data-collector', config: {}, inputSlots: [], outputSlots: [{ slotId: 's1o', name: 'bugs', dataType: 'json', required: true }] },
      { nodeId: 'n2', name: 'Story 数据采集', nodeType: 'data-collector', config: {}, inputSlots: [], outputSlots: [{ slotId: 's2o', name: 'stories', dataType: 'json', required: true }] },
      { nodeId: 'n3', name: 'LLM 统计分析', nodeType: 'llm-code-executor', config: {}, inputSlots: [{ slotId: 's3i1', name: 'bugs', dataType: 'json', required: true }, { slotId: 's3i2', name: 'stories', dataType: 'json', required: true }], outputSlots: [{ slotId: 's3o', name: 'stats', dataType: 'json', required: true }] },
      { nodeId: 'n4', name: '生成报告', nodeType: 'renderer', config: {}, inputSlots: [{ slotId: 's4i', name: 'stats', dataType: 'json', required: true }], outputSlots: [{ slotId: 's4o', name: 'report', dataType: 'text', required: true }] },
    ],
    edges: [
      { edgeId: 'e1', sourceNodeId: 'n1', sourceSlotId: 's1o', targetNodeId: 'n3', targetSlotId: 's3i1' },
      { edgeId: 'e2', sourceNodeId: 'n2', sourceSlotId: 's2o', targetNodeId: 'n3', targetSlotId: 's3i2' },
      { edgeId: 'e3', sourceNodeId: 'n3', sourceSlotId: 's3o', targetNodeId: 'n4', targetSlotId: 's4i' },
    ],
  },
];

// ─────────────────────────────────────────────
// 主页面
// ─────────────────────────────────────────────

export function WorkflowAgentPage() {
  const {
    workflows, loading, viewMode,
    setViewMode, setSelectedWorkflow,
    loadWorkflows, addWorkflow, removeWorkflow,
  } = useWorkflowStore();

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  // Sub-views
  if (viewMode === 'detail') return <WorkflowRunPanel />;
  if (viewMode === 'execution-list') return <ExecutionListPanel />;
  if (viewMode === 'execution-detail') return <ExecutionDetailPanel />;
  if (viewMode === 'shares') return <SharePanel />;

  const handleCreateFromTemplate = async (tpl: WorkflowTemplate) => {
    const res = await createWorkflow({
      name: tpl.name,
      description: tpl.description,
      icon: tpl.icon,
      tags: tpl.tags,
      nodes: tpl.nodes,
      edges: tpl.edges,
      variables: tpl.variables,
    });
    if (res.success && res.data) {
      addWorkflow(res.data.workflow);
      setSelectedWorkflow(res.data.workflow);
      setViewMode('detail');
    }
  };

  const handleOpen = (wf: WorkflowType) => {
    setSelectedWorkflow(wf);
    setViewMode('detail');
  };

  const handleDelete = async (wf: WorkflowType) => {
    if (!confirm(`确定删除「${wf.name}」？`)) return;
    const res = await deleteWorkflow(wf.id);
    if (res.success) removeWorkflow(wf.id);
  };

  return (
    <div className="p-6 space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Workflow className="w-5 h-5" />
          自动化工作流
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          选择模板 → 填参数 → 一键执行 → 查看报告
        </p>
      </div>

      {/* 模板区 */}
      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">从模板创建</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {TEMPLATES.map((tpl) => (
            <div
              key={tpl.key}
              onClick={() => handleCreateFromTemplate(tpl)}
              className="rounded-lg border-2 border-dashed border-border p-5 hover:border-primary hover:bg-primary/5 cursor-pointer transition-all group"
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">{tpl.icon}</span>
                <div>
                  <h3 className="font-medium group-hover:text-primary transition-colors">{tpl.name}</h3>
                  <p className="text-xs text-muted-foreground">{tpl.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {tpl.nodes.length} 个节点
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {tpl.variables.filter(v => v.required).length} 个必填参数
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 已有工作流 */}
      {loading && <div className="text-center py-8 text-muted-foreground text-sm">加载中...</div>}

      {!loading && workflows.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">我的工作流</h2>
          <div className="space-y-2">
            {workflows.map((wf) => (
              <div
                key={wf.id}
                onClick={() => handleOpen(wf)}
                className="group flex items-center gap-4 rounded-lg border border-border p-4 hover:shadow-sm cursor-pointer bg-card transition-all"
              >
                <span className="text-xl flex-shrink-0">{wf.icon || '🔄'}</span>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{wf.name}</h3>
                  {wf.description && (
                    <p className="text-xs text-muted-foreground truncate">{wf.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-shrink-0">
                  {wf.executionCount > 0 ? (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-green-500" />
                      执行 {wf.executionCount} 次
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      未执行
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(wf); }}
                  className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 工作流运行面板（简单表单 + 一键执行 + 流水线可视化）
// ─────────────────────────────────────────────

function WorkflowRunPanel() {
  const { selectedWorkflow, setViewMode, updateWorkflowInList, addExecution, setSelectedExecution } = useWorkflowStore();
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (selectedWorkflow) {
      const defaults: Record<string, string> = {};
      for (const v of selectedWorkflow.variables) {
        defaults[v.key] = v.defaultValue || '';
      }
      setVariableValues(defaults);
    }
  }, [selectedWorkflow]);

  if (!selectedWorkflow) return null;
  const wf = selectedWorkflow;

  const handleExecute = async () => {
    // 验证必填
    for (const v of wf.variables) {
      if (v.required && !variableValues[v.key]) {
        alert(`请填写: ${v.label}`);
        return;
      }
    }
    setExecuting(true);
    const res = await executeWorkflow({ id: wf.id, variables: variableValues });
    if (res.success && res.data) {
      addExecution(res.data.execution);
      setSelectedExecution(res.data.execution);
      setViewMode('execution-detail');
    } else {
      alert(res.error?.message || '执行失败');
    }
    setExecuting(false);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setViewMode('list')}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← 返回
        </button>
      </div>

      {/* Title */}
      <div className="flex items-center gap-3">
        <span className="text-3xl">{wf.icon || '🔄'}</span>
        <div>
          <h1 className="text-xl font-semibold">{wf.name}</h1>
          {wf.description && <p className="text-sm text-muted-foreground">{wf.description}</p>}
        </div>
      </div>

      {/* 流水线可视化（简洁箭头图） */}
      <div className="rounded-lg border border-border p-4 bg-card">
        <h2 className="text-xs font-medium text-muted-foreground mb-3">执行流程</h2>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {wf.nodes.map((node, idx) => (
            <div key={node.nodeId} className="flex items-center gap-2 flex-shrink-0">
              <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-muted/50 border border-border min-w-[80px]">
                <span className="text-lg">
                  {node.nodeType === 'data-collector' ? '📥' :
                   node.nodeType === 'llm-analyzer' ? '🧠' :
                   node.nodeType === 'llm-code-executor' ? '⚡' :
                   node.nodeType === 'script-executor' ? '📜' :
                   node.nodeType === 'renderer' ? '📄' : '⚙️'}
                </span>
                <span className="text-[10px] text-center font-medium leading-tight">{node.name}</span>
              </div>
              {idx < wf.nodes.length - 1 && (
                <span className="text-muted-foreground text-lg flex-shrink-0">→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 参数表单 */}
      {wf.variables.length > 0 && (
        <div className="rounded-lg border border-border p-5 bg-card space-y-4">
          <h2 className="text-sm font-medium">填写参数</h2>
          {wf.variables.map((v) => (
            <div key={v.key}>
              <label className="flex items-center gap-1 text-sm mb-1.5">
                {v.label}
                {v.required && <span className="text-red-500">*</span>}
                {v.isSecret && <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-600">密钥</span>}
              </label>
              <input
                type={v.isSecret ? 'password' : 'text'}
                value={variableValues[v.key] || ''}
                onChange={(e) => setVariableValues({ ...variableValues, [v.key]: e.target.value })}
                placeholder={v.defaultValue ? `默认: ${v.defaultValue}` : `请输入${v.label}`}
                className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          ))}
        </div>
      )}

      {/* 操作区 */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleExecute}
          disabled={executing}
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <Play className="w-4 h-4" />
          {executing ? '执行中...' : '开始执行'}
        </button>
        <button
          onClick={() => {
            setViewMode('execution-list');
          }}
          className="inline-flex items-center gap-1.5 px-4 py-3 text-sm rounded-lg border border-border hover:bg-accent transition-colors"
        >
          <History className="w-4 h-4" />
          历史
        </button>
      </div>

      {/* 高级设置折叠 */}
      <div>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="w-3 h-3" />
          {showAdvanced ? '收起高级设置' : '高级设置'}
        </button>
        {showAdvanced && (
          <div className="mt-3 rounded-lg border border-border p-4 bg-card space-y-3">
            <div className="text-xs text-muted-foreground">
              <p>工作流 ID: <span className="font-mono">{wf.id}</span></p>
              <p>节点数: {wf.nodes.length} | 连线数: {wf.edges.length}</p>
              <p>创建人: {wf.createdByName || wf.createdBy}</p>
              <p>创建时间: {new Date(wf.createdAt).toLocaleString('zh-CN')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
