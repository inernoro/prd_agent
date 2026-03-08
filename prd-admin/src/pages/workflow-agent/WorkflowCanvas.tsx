import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  ReactFlowProvider,
  useReactFlow,
  Panel,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './workflow-canvas.css';

import {
  ArrowLeft, Save, Loader2, GripVertical,
  Plus, Trash2, X, Settings2,
} from 'lucide-react';
import { CapsuleNode, type CapsuleNodeData } from './CapsuleNode';
import { FlowEdge } from './FlowEdge';
import { getIconForCapsule, getEmojiForCapsule, getCategoryEmoji } from './capsuleRegistry';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { listCapsuleTypes, updateWorkflow } from '@/services';
import type {
  Workflow, WorkflowNode, WorkflowEdge as WfEdge,
  CapsuleTypeMeta, CapsuleCategoryInfo, WorkflowExecution,
  CapsuleConfigField,
} from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// WorkflowCanvas — 画布编排器主体
//
// 包含：
//   1. React Flow 画布（自定义 CapsuleNode + FlowEdge）
//   2. 左侧舱目录面板（拖拽添加）
//   3. 工具栏（保存 / 执行 / 删除）
// ═══════════════════════════════════════════════════════════════

// 自定义节点 / 边注册
const nodeTypes = { capsule: CapsuleNode };
const edgeTypes = { flow: FlowEdge };

// 默认连线选项
const defaultEdgeOptions = {
  type: 'flow',
  animated: false,
};

// ─── 数据转换：后端 → React Flow ───

function workflowToFlow(
  wf: Workflow,
  execution?: WorkflowExecution | null,
): { nodes: Node<CapsuleNodeData>[]; edges: Edge[] } {
  const nodes: Node<CapsuleNodeData>[] = wf.nodes.map((n, idx) => {
    const ne = execution?.nodeExecutions.find((ne) => ne.nodeId === n.nodeId);
    return {
      id: n.nodeId,
      type: 'capsule',
      position: n.position ?? { x: 250, y: idx * 160 },
      dragHandle: '.capsule-node-body',
      data: {
        label: n.name,
        capsuleType: n.nodeType,
        icon: resolveIcon(n.nodeType),
        accentHue: resolveHue(n.nodeType),
        inputSlots: n.inputSlots,
        outputSlots: n.outputSlots,
        execStatus: ne?.status,
        durationMs: ne?.durationMs,
        testable: false,
        breakpoint: n.breakpoint,
      },
    };
  });

  const edges: Edge[] = wf.edges.map((e) => {
    // 推断连线状态
    let edgeStatus = 'idle';
    if (execution) {
      const srcExec = execution.nodeExecutions.find((ne) => ne.nodeId === e.sourceNodeId);
      const tgtExec = execution.nodeExecutions.find((ne) => ne.nodeId === e.targetNodeId);
      if (srcExec?.status === 'completed' && tgtExec?.status === 'running') edgeStatus = 'transferring';
      else if (srcExec?.status === 'completed' && tgtExec?.status === 'completed') edgeStatus = 'done';
      else if (srcExec?.status === 'failed' || tgtExec?.status === 'failed') edgeStatus = 'error';
    }

    return {
      id: e.edgeId,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      sourceHandle: e.sourceSlotId,
      targetHandle: e.targetSlotId,
      type: 'flow',
      data: { status: edgeStatus },
    };
  });

  return { nodes, edges };
}

// ─── React Flow → 后端格式 ───

function flowToWorkflowNodes(
  nodes: Node<CapsuleNodeData>[],
  configs?: Record<string, Record<string, unknown>>,
): WorkflowNode[] {
  return nodes.map((n) => ({
    nodeId: n.id,
    name: n.data.label,
    nodeType: n.data.capsuleType,
    config: configs?.[n.id] ?? {},
    inputSlots: n.data.inputSlots,
    outputSlots: n.data.outputSlots,
    position: { x: n.position.x, y: n.position.y },
    breakpoint: n.data.breakpoint,
  }));
}

function flowToWorkflowEdges(edges: Edge[]): WfEdge[] {
  return edges.map((e) => ({
    edgeId: e.id,
    sourceNodeId: e.source,
    sourceSlotId: e.sourceHandle || 'default-out',
    targetNodeId: e.target,
    targetSlotId: e.targetHandle || 'default-in',
  }));
}

// ─── 辅助 ───

const HUE_MAP: Record<string, number> = {
  'timer': 30, 'webhook-receiver': 200, 'manual-trigger': 280, 'file-upload': 170,
  'tapd-collector': 30, 'http-request': 210, 'llm-analyzer': 270, 'script-executor': 150,
  'data-extractor': 180, 'data-merger': 60,
  'report-generator': 150, 'file-exporter': 100, 'webhook-sender': 200, 'notification-sender': 340,
};

const ICON_NAME_MAP: Record<string, string> = {
  'timer': 'timer', 'webhook-receiver': 'webhook', 'manual-trigger': 'hand', 'file-upload': 'upload',
  'tapd-collector': 'database', 'http-request': 'globe', 'llm-analyzer': 'brain', 'script-executor': 'code',
  'data-extractor': 'filter', 'data-merger': 'merge',
  'report-generator': 'file-text', 'file-exporter': 'download', 'webhook-sender': 'send', 'notification-sender': 'bell',
};

function resolveHue(typeKey: string): number { return HUE_MAP[typeKey] ?? 210; }
function resolveIcon(typeKey: string): string { return ICON_NAME_MAP[typeKey] ?? 'box'; }

let nodeCounter = 0;

// ═══════════════════════════════════════════════════════════════
// 画布内部组件（需要 ReactFlowProvider 包裹）
// ═══════════════════════════════════════════════════════════════

function CanvasInner({
  workflow,
  execution,
  onBack,
  onSaved,
}: {
  workflow: Workflow;
  execution?: WorkflowExecution | null;
  onBack: () => void;
  onSaved?: (wf: Workflow) => void;
}) {
  const reactFlowInstance = useReactFlow();

  // 初始化节点和边
  const initial = useMemo(() => workflowToFlow(workflow, execution), [workflow, execution]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 舱类型目录
  const [capsuleTypes, setCapsuleTypes] = useState<CapsuleTypeMeta[]>([]);
  const [categories, setCategories] = useState<CapsuleCategoryInfo[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(true);

  // 节点编辑面板
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [nodeConfigs, setNodeConfigs] = useState<Record<string, Record<string, unknown>>>(() => {
    // 从 workflow 初始化节点配置
    const configs: Record<string, Record<string, unknown>> = {};
    for (const n of workflow.nodes) {
      configs[n.nodeId] = n.config ?? {};
    }
    return configs;
  });

  useEffect(() => {
    listCapsuleTypes().then((res) => {
      if (res.success && res.data) {
        setCapsuleTypes(res.data.items);
        setCategories(res.data.categories);
      }
    });
  }, []);

  // 当 execution 变化时更新节点/边状态
  useEffect(() => {
    if (!execution) return;
    const updated = workflowToFlow(workflow, execution);
    setNodes((prev) =>
      prev.map((n) => {
        const upd = updated.nodes.find((u) => u.id === n.id);
        if (upd) return { ...n, data: { ...n.data, execStatus: upd.data.execStatus, durationMs: upd.data.durationMs } };
        return n;
      }),
    );
    setEdges(updated.edges);
  }, [execution, workflow, setNodes, setEdges]);

  // 连线
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, type: 'flow', data: { status: 'idle' } }, eds));
      setDirty(true);
    },
    [setEdges],
  );

  // 断点切换
  const handleToggleBreakpoint = useCallback((nodeId: string) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, breakpoint: !n.data.breakpoint } } : n
      ),
    );
    setDirty(true);
  }, [setNodes]);

  // 将断点切换回调注入每个节点
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onToggleBreakpoint: () => handleToggleBreakpoint(n.id),
        },
      })),
    );
  }, [handleToggleBreakpoint, setNodes]);

  // 点击节点 → 打开编辑面板
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node<CapsuleNodeData>) => {
    setEditingNodeId(node.id);
  }, []);

  // 获取编辑中的节点
  const editingNode = editingNodeId ? nodes.find((n) => n.id === editingNodeId) : null;
  const editingMeta = editingNode ? capsuleTypes.find((t) => t.typeKey === editingNode.data.capsuleType) : null;

  // 更新节点名称
  const handleNodeNameChange = useCallback((nodeId: string, name: string) => {
    setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, label: name } } : n));
    setDirty(true);
  }, [setNodes]);

  // 更新节点配置字段
  const handleConfigChange = useCallback((nodeId: string, key: string, value: unknown) => {
    setNodeConfigs((prev) => ({
      ...prev,
      [nodeId]: { ...(prev[nodeId] ?? {}), [key]: value },
    }));
    setDirty(true);
  }, []);

  // 拖拽变更
  const onNodesDragStop = useCallback(() => setDirty(true), []);

  // 删除
  const onDelete = useCallback(() => setDirty(true), []);

  // 保存
  async function handleSave() {
    setSaving(true);
    try {
      const res = await updateWorkflow({
        id: workflow.id,
        nodes: flowToWorkflowNodes(nodes, nodeConfigs),
        edges: flowToWorkflowEdges(edges),
      });
      if (res.success && res.data) {
        setDirty(false);
        onSaved?.(res.data.workflow);
      }
    } catch { /* save failed */ }
    setSaving(false);
  }

  // 拖拽添加舱
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const typeKey = e.dataTransfer.getData('application/capsule-type');
      if (!typeKey) return;

      const meta = capsuleTypes.find((t) => t.typeKey === typeKey);
      if (!meta) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      nodeCounter++;
      const newNode: Node<CapsuleNodeData> = {
        id: `new-${Date.now()}-${nodeCounter}`,
        type: 'capsule',
        position,
        dragHandle: '.capsule-node-body',
        data: {
          label: meta.name,
          capsuleType: meta.typeKey,
          icon: meta.icon,
          accentHue: meta.accentHue,
          inputSlots: meta.defaultInputSlots,
          outputSlots: meta.defaultOutputSlots,
          testable: meta.testable,
        },
      };

      setNodes((nds) => [...nds, newNode]);
      setDirty(true);
    },
    [capsuleTypes, reactFlowInstance, setNodes],
  );

  // 删除选中节点
  function handleDeleteSelected() {
    const selectedNodes = nodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return;
    const ids = new Set(selectedNodes.map((n) => n.id));
    setNodes((nds) => nds.filter((n) => !ids.has(n.id)));
    setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    setDirty(true);
  }

  const hasSelected = nodes.some((n) => n.selected);

  // 按 category 分组
  const grouped = useMemo(() => {
    return categories.reduce<Record<string, CapsuleTypeMeta[]>>((acc, cat) => {
      acc[cat.key] = capsuleTypes.filter((t) => t.category === cat.key);
      return acc;
    }, {});
  }, [categories, capsuleTypes]);

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <TabBar
        title={workflow.name || '编排画布'}
        icon={<span>{workflow.icon || '🔧'}</span>}
        actions={
          <div className="flex items-center gap-2">
            {hasSelected && (
              <Button variant="danger" size="xs" onClick={handleDeleteSelected}>
                <Trash2 className="w-3 h-3" />
                删除选中
              </Button>
            )}
            <Button
              variant={dirty ? 'primary' : 'secondary'}
              size="xs"
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {dirty ? '保存*' : '已保存'}
            </Button>
            <Button variant="ghost" size="xs" onClick={onBack}>
              <ArrowLeft className="w-3.5 h-3.5" />
              返回
            </Button>
          </div>
        }
      />

      {/* 画布 + 面板 */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧舱目录面板 */}
        {paletteOpen && (
          <div
            className="w-56 flex-shrink-0 overflow-y-auto border-r"
            style={{
              background: 'rgba(0,0,0,0.2)',
              borderColor: 'rgba(255,255,255,0.08)',
            }}
          >
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary, #e8e6e3)' }}>
                  舱目录
                </span>
                <span className="text-[9px]" style={{ color: 'var(--text-muted, #888)' }}>
                  拖拽到画布
                </span>
              </div>
              {categories.map((cat) => {
                const types = grouped[cat.key] || [];
                if (types.length === 0) return null;
                return (
                  <div key={cat.key}>
                    <div className="text-[10px] font-medium mb-1.5 flex items-center gap-1" style={{ color: 'var(--text-muted, #888)' }}>
                      <span>{getCategoryEmoji(cat.key)}</span>
                      {cat.label}
                    </div>
                    <div className="space-y-1">
                      {types.map((meta) => (
                        <PaletteItem key={meta.typeKey} meta={meta} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* React Flow 画布 */}
        <div className="flex-1 min-w-0" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodesDragStop}
            onNodesDelete={onDelete}
            onEdgesDelete={onDelete}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={onNodeClick}
            onNodeContextMenu={(e, node) => {
              e.preventDefault();
              handleToggleBreakpoint(node.id);
            }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode="Delete"
            className="workflow-canvas"
            style={{ background: 'transparent' }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={0.8}
              color="rgba(255,255,255,0.04)"
            />
            <Controls
              showInteractive={false}
              style={{
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
              }}
            />
            <MiniMap
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10,
              }}
              maskColor="rgba(0,0,0,0.5)"
              nodeColor={(n) => `hsla(${(n.data as unknown as CapsuleNodeData)?.accentHue ?? 210}, 50%, 50%, 0.4)`}
            />
            {/* 面板切换按钮 */}
            <Panel position="top-left">
              <button
                onClick={() => setPaletteOpen((v) => !v)}
                className="p-1.5 rounded-lg transition-colors"
                style={{
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'var(--text-secondary, #aaa)',
                }}
                title={paletteOpen ? '收起面板' : '展开面板'}
              >
                <Plus className={`w-4 h-4 transition-transform ${paletteOpen ? 'rotate-45' : ''}`} />
              </button>
            </Panel>
          </ReactFlow>
        </div>

        {/* 右侧节点编辑面板 */}
        {editingNode && editingMeta && (
          <NodeEditPanel
            node={editingNode}
            meta={editingMeta}
            config={nodeConfigs[editingNode.id] ?? {}}
            onNameChange={(name) => handleNodeNameChange(editingNode.id, name)}
            onConfigChange={(key, value) => handleConfigChange(editingNode.id, key, value)}
            onClose={() => setEditingNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── 节点编辑面板 ───

function NodeEditPanel({
  node,
  meta,
  config,
  onNameChange,
  onConfigChange,
  onClose,
}: {
  node: Node<CapsuleNodeData>;
  meta: CapsuleTypeMeta;
  config: Record<string, unknown>;
  onNameChange: (name: string) => void;
  onConfigChange: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  const Icon = getIconForCapsule(node.data.icon);
  const emoji = getEmojiForCapsule(node.data.capsuleType);

  return (
    <div
      className="w-72 flex-shrink-0 overflow-y-auto border-l node-edit-panel"
      style={{
        background: 'rgba(0,0,0,0.25)',
        borderColor: 'rgba(255,255,255,0.08)',
      }}
    >
      {/* 面板头部 */}
      <div
        className="flex items-center justify-between px-3 py-2.5 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Settings2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted, #888)' }} />
          <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-primary, #e8e6e3)' }}>
            节点配置
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md transition-colors"
          style={{ color: 'var(--text-muted, #888)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-4">
        {/* 节点标识 */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
            style={{
              background: `hsla(${node.data.accentHue}, 60%, 55%, 0.15)`,
              color: `hsla(${node.data.accentHue}, 60%, 65%, 0.95)`,
            }}
          >
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px]" style={{ color: 'var(--text-muted, #888)' }}>
              {emoji} {meta.name}
            </div>
          </div>
        </div>

        {/* 节点名称 */}
        <div>
          <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted, #888)' }}>
            节点名称
          </label>
          <input
            type="text"
            value={node.data.label}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none transition-colors"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--text-primary, #e8e6e3)',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = `hsla(${node.data.accentHue}, 60%, 55%, 0.4)`; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
          />
        </div>

        {/* 配置字段（来自 configSchema） */}
        {meta.configSchema.length > 0 ? (
          <div className="space-y-3">
            <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted, #888)' }}>
              参数配置
            </div>
            {meta.configSchema.map((field) => (
              <ConfigFieldInput
                key={field.key}
                field={field}
                value={config[field.key]}
                accentHue={node.data.accentHue}
                onChange={(val) => onConfigChange(field.key, val)}
              />
            ))}
          </div>
        ) : (
          <div
            className="text-[11px] text-center py-4 rounded-lg"
            style={{
              color: 'var(--text-muted, #888)',
              background: 'rgba(255,255,255,0.02)',
              border: '1px dashed rgba(255,255,255,0.06)',
            }}
          >
            该舱类型暂无可配参数
          </div>
        )}

        {/* 输入/输出插槽信息 */}
        {(node.data.inputSlots.length > 0 || node.data.outputSlots.length > 0) && (
          <div className="space-y-2">
            <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted, #888)' }}>
              数据端口
            </div>
            {node.data.inputSlots.map((slot) => (
              <div key={slot.slotId} className="flex items-center gap-1.5 text-[10px]">
                <span className="px-1 py-0.5 rounded" style={{
                  background: 'rgba(255,255,255,0.05)',
                  color: 'var(--text-muted, #888)',
                }}>入</span>
                <span style={{ color: 'var(--text-secondary, #aaa)' }}>{slot.name}</span>
                <span style={{ color: 'var(--text-muted, #666)' }}>({slot.dataType})</span>
              </div>
            ))}
            {node.data.outputSlots.map((slot) => (
              <div key={slot.slotId} className="flex items-center gap-1.5 text-[10px]">
                <span className="px-1 py-0.5 rounded" style={{
                  background: 'rgba(34,197,94,0.08)',
                  color: 'rgba(34,197,94,0.7)',
                }}>出</span>
                <span style={{ color: 'var(--text-secondary, #aaa)' }}>{slot.name}</span>
                <span style={{ color: 'var(--text-muted, #666)' }}>({slot.dataType})</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 配置字段输入组件 ───

function ConfigFieldInput({
  field,
  value,
  accentHue,
  onChange,
}: {
  field: CapsuleConfigField;
  value: unknown;
  accentHue: number;
  onChange: (value: unknown) => void;
}) {
  const strVal = (value ?? field.defaultValue ?? '') as string;

  const baseInputStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'var(--text-primary, #e8e6e3)',
  };

  const focusBorder = `hsla(${accentHue}, 60%, 55%, 0.4)`;

  return (
    <div>
      <label className="flex items-center gap-1 text-[10px] font-medium mb-1">
        <span style={{ color: 'var(--text-secondary, #aaa)' }}>{field.label}</span>
        {field.required && <span style={{ color: 'rgba(239,68,68,0.7)' }}>*</span>}
      </label>
      {field.helpTip && (
        <div className="text-[9px] mb-1" style={{ color: 'var(--text-muted, #666)' }}>
          {field.helpTip}
        </div>
      )}

      {field.fieldType === 'select' && field.options ? (
        <select
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none"
          style={baseInputStyle}
        >
          <option value="">{field.placeholder || '请选择...'}</option>
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : field.fieldType === 'textarea' ? (
        <textarea
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={4}
          className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none resize-y"
          style={baseInputStyle}
          onFocus={(e) => { e.currentTarget.style.borderColor = focusBorder; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
        />
      ) : field.fieldType === 'number' ? (
        <input
          type="number"
          value={strVal}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
          placeholder={field.placeholder}
          className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none"
          style={baseInputStyle}
          onFocus={(e) => { e.currentTarget.style.borderColor = focusBorder; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
        />
      ) : field.fieldType === 'boolean' ? (
        <button
          onClick={() => onChange(!value)}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] transition-colors"
          style={{
            ...baseInputStyle,
            background: value ? `hsla(${accentHue}, 60%, 55%, 0.12)` : baseInputStyle.background,
          }}
        >
          <div
            className="w-3.5 h-3.5 rounded border-2 flex items-center justify-center"
            style={{
              borderColor: value ? `hsla(${accentHue}, 60%, 55%, 0.6)` : 'rgba(255,255,255,0.2)',
              background: value ? `hsla(${accentHue}, 60%, 55%, 0.3)` : 'transparent',
            }}
          >
            {!!value && <span className="text-[8px]" style={{ color: `hsla(${accentHue}, 60%, 65%, 0.95)` }}>✓</span>}
          </div>
          <span style={{ color: 'var(--text-secondary, #aaa)' }}>{value ? '启用' : '关闭'}</span>
        </button>
      ) : (
        <input
          type="text"
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none"
          style={baseInputStyle}
          onFocus={(e) => { e.currentTarget.style.borderColor = focusBorder; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
        />
      )}
    </div>
  );
}

// ─── 面板拖拽项 ───

function PaletteItem({ meta }: { meta: CapsuleTypeMeta }) {
  const Icon = getIconForCapsule(meta.icon);
  const emoji = getEmojiForCapsule(meta.typeKey);

  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('application/capsule-type', meta.typeKey);
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="flex items-center gap-2 px-2 py-1.5 rounded-[8px] cursor-grab active:cursor-grabbing transition-colors"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
        e.currentTarget.style.borderColor = `hsla(${meta.accentHue}, 60%, 55%, 0.2)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
      }}
      title={meta.description}
    >
      <GripVertical className="w-3 h-3 flex-shrink-0" style={{ color: 'rgba(255,255,255,0.15)' }} />
      <div
        className="w-6 h-6 rounded-[6px] flex items-center justify-center flex-shrink-0"
        style={{
          background: `hsla(${meta.accentHue}, 60%, 55%, 0.12)`,
          color: `hsla(${meta.accentHue}, 60%, 65%, 0.9)`,
        }}
      >
        <Icon className="w-3 h-3" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-[11px]">{emoji}</span>
          <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary, #e8e6e3)' }}>
            {meta.name}
          </span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 导出：带 Provider 包裹
// ═══════════════════════════════════════════════════════════════

export function WorkflowCanvas(props: {
  workflow: Workflow;
  execution?: WorkflowExecution | null;
  onBack: () => void;
  onSaved?: (wf: Workflow) => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
