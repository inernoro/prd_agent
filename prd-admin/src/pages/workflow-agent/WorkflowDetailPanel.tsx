import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Play, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { updateWorkflow, executeWorkflow } from '@/services';
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowVariable,
  WorkflowTrigger,
  ArtifactSlot,
} from '@/services/contracts/workflowAgent';
import { WorkflowNodeTypes, NodeTypeLabels } from '@/services/contracts/workflowAgent';

export function WorkflowDetailPanel() {
  const { selectedWorkflow, setViewMode, updateWorkflowInList, addExecution, loadWorkflow } = useWorkflowStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [tags, setTags] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [variables, setVariables] = useState<WorkflowVariable[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [expandedNodeIdx, setExpandedNodeIdx] = useState<number | null>(null);

  useEffect(() => {
    if (selectedWorkflow) {
      setName(selectedWorkflow.name);
      setDescription(selectedWorkflow.description || '');
      setIcon(selectedWorkflow.icon || '');
      setTags(selectedWorkflow.tags.join(', '));
      setNodes(selectedWorkflow.nodes);
      setEdges(selectedWorkflow.edges);
      setVariables(selectedWorkflow.variables);
      setTriggers(selectedWorkflow.triggers);
    }
  }, [selectedWorkflow]);

  if (!selectedWorkflow) return null;

  const handleSave = async () => {
    setSaving(true);
    const res = await updateWorkflow({
      id: selectedWorkflow.id,
      name: name.trim() || '未命名工作流',
      description: description || undefined,
      icon: icon || undefined,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      nodes,
      edges,
      variables,
      triggers,
    });
    if (res.success && res.data) {
      updateWorkflowInList(res.data.workflow);
    }
    setSaving(false);
  };

  const handleExecute = async () => {
    setExecuting(true);
    const res = await executeWorkflow({ id: selectedWorkflow.id });
    if (res.success && res.data) {
      addExecution(res.data.execution);
      alert(`执行已入队: ${res.data.execution.id}`);
    } else {
      alert(res.error?.message || '执行失败');
    }
    setExecuting(false);
  };

  const addNode = () => {
    const nodeId = Math.random().toString(36).substring(2, 10);
    setNodes([...nodes, {
      nodeId,
      name: '',
      nodeType: WorkflowNodeTypes.DataCollector,
      config: {},
      inputSlots: [],
      outputSlots: [],
    }]);
    setExpandedNodeIdx(nodes.length);
  };

  const removeNode = (idx: number) => {
    const removed = nodes[idx];
    setNodes(nodes.filter((_, i) => i !== idx));
    setEdges(edges.filter((e) => e.sourceNodeId !== removed.nodeId && e.targetNodeId !== removed.nodeId));
    if (expandedNodeIdx === idx) setExpandedNodeIdx(null);
  };

  const updateNode = (idx: number, patch: Partial<WorkflowNode>) => {
    setNodes(nodes.map((n, i) => (i === idx ? { ...n, ...patch } : n)));
  };

  const addVariable = () => {
    setVariables([...variables, {
      key: '', label: '', type: 'string', required: true, isSecret: false,
    }]);
  };

  const removeVariable = (idx: number) => {
    setVariables(variables.filter((_, i) => i !== idx));
  };

  const updateVariable = (idx: number, patch: Partial<WorkflowVariable>) => {
    setVariables(variables.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const addSlot = (nodeIdx: number, direction: 'input' | 'output') => {
    const slot: ArtifactSlot = {
      slotId: Math.random().toString(36).substring(2, 10),
      name: '',
      dataType: 'text',
      required: true,
    };
    const node = nodes[nodeIdx];
    if (direction === 'input') {
      updateNode(nodeIdx, { inputSlots: [...node.inputSlots, slot] });
    } else {
      updateNode(nodeIdx, { outputSlots: [...node.outputSlots, slot] });
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setViewMode('list')}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          返回列表
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExecute}
            disabled={executing || nodes.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-green-500 text-green-600 hover:bg-green-500/10 disabled:opacity-50 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            {executing ? '提交中...' : '执行'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* Basic Info */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="text-sm font-medium">基本信息</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">图标 (emoji)</label>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="🔄"
              className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">描述</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background resize-none"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">标签 (逗号分隔)</label>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tapd, quality, monthly"
            className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background"
          />
        </div>
      </section>

      {/* Variables */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">变量</h2>
          <button onClick={addVariable} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus className="w-3 h-3" /> 添加变量
          </button>
        </div>
        {variables.length === 0 && (
          <p className="text-xs text-muted-foreground/50">暂无变量</p>
        )}
        {variables.map((v, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              value={v.key}
              onChange={(e) => updateVariable(idx, { key: e.target.value })}
              placeholder="KEY"
              className="flex-1 px-2 py-1 text-xs rounded border border-border bg-background font-mono"
            />
            <input
              value={v.label}
              onChange={(e) => updateVariable(idx, { label: e.target.value })}
              placeholder="显示名称"
              className="flex-1 px-2 py-1 text-xs rounded border border-border bg-background"
            />
            <input
              value={v.defaultValue || ''}
              onChange={(e) => updateVariable(idx, { defaultValue: e.target.value })}
              placeholder="默认值"
              className="flex-1 px-2 py-1 text-xs rounded border border-border bg-background"
            />
            <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
              <input
                type="checkbox"
                checked={v.isSecret}
                onChange={(e) => updateVariable(idx, { isSecret: e.target.checked })}
              />
              密钥
            </label>
            <button onClick={() => removeVariable(idx)} className="p-1 text-destructive hover:bg-destructive/10 rounded">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </section>

      {/* Nodes */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">节点 ({nodes.length})</h2>
          <button onClick={addNode} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus className="w-3 h-3" /> 添加节点
          </button>
        </div>
        {nodes.length === 0 && (
          <p className="text-xs text-muted-foreground/50">暂无节点，点击添加</p>
        )}
        <div className="space-y-2">
          {nodes.map((node, idx) => {
            const isExpanded = expandedNodeIdx === idx;
            return (
              <div key={node.nodeId} className="rounded border border-border">
                {/* Node header */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => setExpandedNodeIdx(isExpanded ? null : idx)}
                >
                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  <span className="text-xs font-mono text-muted-foreground">#{idx + 1}</span>
                  <span className="text-sm font-medium">{node.name || '(未命名)'}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                    {NodeTypeLabels[node.nodeType] || node.nodeType}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {node.inputSlots.length} 入 / {node.outputSlots.length} 出
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeNode(idx); }}
                    className="p-1 text-destructive hover:bg-destructive/10 rounded"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {/* Node detail */}
                {isExpanded && (
                  <div className="px-3 pb-3 space-y-3 border-t border-border/50 pt-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground">名称</label>
                        <input
                          value={node.name}
                          onChange={(e) => updateNode(idx, { name: e.target.value })}
                          className="mt-1 w-full px-2 py-1 text-xs rounded border border-border bg-background"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">类型</label>
                        <select
                          value={node.nodeType}
                          onChange={(e) => updateNode(idx, { nodeType: e.target.value })}
                          className="mt-1 w-full px-2 py-1 text-xs rounded border border-border bg-background"
                        >
                          {Object.entries(NodeTypeLabels).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Slots */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted-foreground">输入插槽</span>
                          <button onClick={() => addSlot(idx, 'input')} className="text-[10px] text-primary hover:underline">+ 添加</button>
                        </div>
                        {node.inputSlots.map((s, si) => (
                          <div key={s.slotId} className="flex items-center gap-1 mb-1">
                            <input
                              value={s.name}
                              onChange={(e) => {
                                const newSlots = [...node.inputSlots];
                                newSlots[si] = { ...s, name: e.target.value };
                                updateNode(idx, { inputSlots: newSlots });
                              }}
                              placeholder="slot 名称"
                              className="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-background"
                            />
                            <select
                              value={s.dataType}
                              onChange={(e) => {
                                const newSlots = [...node.inputSlots];
                                newSlots[si] = { ...s, dataType: e.target.value };
                                updateNode(idx, { inputSlots: newSlots });
                              }}
                              className="px-1 py-0.5 text-[10px] rounded border border-border bg-background"
                            >
                              <option value="text">text</option>
                              <option value="json">json</option>
                              <option value="image">image</option>
                              <option value="binary">binary</option>
                            </select>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted-foreground">输出插槽</span>
                          <button onClick={() => addSlot(idx, 'output')} className="text-[10px] text-primary hover:underline">+ 添加</button>
                        </div>
                        {node.outputSlots.map((s, si) => (
                          <div key={s.slotId} className="flex items-center gap-1 mb-1">
                            <input
                              value={s.name}
                              onChange={(e) => {
                                const newSlots = [...node.outputSlots];
                                newSlots[si] = { ...s, name: e.target.value };
                                updateNode(idx, { outputSlots: newSlots });
                              }}
                              placeholder="slot 名称"
                              className="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-background"
                            />
                            <select
                              value={s.dataType}
                              onChange={(e) => {
                                const newSlots = [...node.outputSlots];
                                newSlots[si] = { ...s, dataType: e.target.value };
                                updateNode(idx, { outputSlots: newSlots });
                              }}
                              className="px-1 py-0.5 text-[10px] rounded border border-border bg-background"
                            >
                              <option value="text">text</option>
                              <option value="json">json</option>
                              <option value="image">image</option>
                              <option value="binary">binary</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Edges (simple view) */}
      {edges.length > 0 && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h2 className="text-sm font-medium">连线 ({edges.length})</h2>
          <div className="space-y-1">
            {edges.map((e) => {
              const src = nodes.find((n) => n.nodeId === e.sourceNodeId);
              const tgt = nodes.find((n) => n.nodeId === e.targetNodeId);
              return (
                <div key={e.edgeId} className="text-xs text-muted-foreground flex items-center gap-1">
                  <span className="font-medium text-foreground">{src?.name || e.sourceNodeId}</span>
                  <span>→</span>
                  <span className="font-medium text-foreground">{tgt?.name || e.targetNodeId}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
