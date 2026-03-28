import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  MarkerType,
  SelectionMode,
  type NodeProps,
  Handle,
  Position,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type SandboxNodeData = {
  label: string;
  role: string;
  identity: string;
};

type EdgeStatus = 'valid' | 'warning' | 'blocked';

type SandboxEdgeData = {
  status: EdgeStatus;
};

const STORAGE_KEY = 'sandbox-demo-state-v1';

const EDGE_STYLE_MAP: Record<EdgeStatus, { stroke: string; strokeDasharray?: string }> = {
  valid: { stroke: '#22c55e' },
  warning: { stroke: '#f59e0b', strokeDasharray: '6 4' },
  blocked: { stroke: '#ef4444', strokeDasharray: '3 3' },
};

const PALETTE: Array<Pick<SandboxNodeData, 'label' | 'role' | 'identity'>> = [
  { label: '品牌方', role: 'Owner', identity: 'BRAND' },
  { label: '一级经销商', role: 'Distributor-L1', identity: 'D1' },
  { label: '二级经销商', role: 'Distributor-L2', identity: 'D2' },
  { label: '业务员', role: 'Sales', identity: 'SALES' },
  { label: '门店', role: 'Store', identity: 'STORE' },
];

const INITIAL_NODES: Node<SandboxNodeData>[] = [
  {
    id: 'n-brand',
    type: 'sandboxNode',
    position: { x: 120, y: 120 },
    data: { label: '品牌方', role: 'Owner', identity: 'BRAND' },
  },
  {
    id: 'n-d1',
    type: 'sandboxNode',
    position: { x: 420, y: 120 },
    data: { label: '一级经销商', role: 'Distributor-L1', identity: 'D1' },
  },
  {
    id: 'n-d2',
    type: 'sandboxNode',
    position: { x: 720, y: 120 },
    data: { label: '二级经销商', role: 'Distributor-L2', identity: 'D2' },
  },
];

const INITIAL_EDGES: Edge<SandboxEdgeData>[] = [
  makeEdge('e-brand-d1', 'n-brand', 'n-d1', 'valid'),
  makeEdge('e-d1-d2', 'n-d1', 'n-d2', 'warning'),
];

const nodeTypes = {
  sandboxNode: SandboxNode,
};

function makeEdge(
  id: string,
  source: string,
  target: string,
  status: EdgeStatus,
): Edge<SandboxEdgeData> {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: EDGE_STYLE_MAP[status].stroke,
    },
    style: EDGE_STYLE_MAP[status],
    data: { status },
  };
}

function SandboxNode({ data, selected }: NodeProps<Node<SandboxNodeData>>) {
  return (
    <div
      style={{
        minWidth: 170,
        borderRadius: 12,
        border: selected ? '2px solid #8b5cf6' : '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(20,20,30,0.86)',
        boxShadow: selected ? '0 0 0 2px rgba(139,92,246,0.2)' : '0 6px 18px rgba(0,0,0,0.25)',
        color: '#f5f5f5',
        padding: '10px 12px',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{data.label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Tag text={data.role} />
        <Tag text={data.identity} />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function Tag({ text }: { text: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(255,255,255,0.2)',
      }}
    >
      {text}
    </span>
  );
}

function SandboxDemoInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const [counter, setCounter] = useState(100);
  const [tip, setTip] = useState('拖拽左侧角色到画布即可新增节点');
  const reactFlow = useReactFlow<Node<SandboxNodeData>, Edge<SandboxEdgeData>>();

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    setEdges((prev) => addEdge(makeEdge(`e-${Date.now()}`, connection.source!, connection.target!, 'valid'), prev));
  }, [setEdges]);

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/sandbox-node');
    if (!raw) return;
    const payload = JSON.parse(raw) as Pick<SandboxNodeData, 'label' | 'role' | 'identity'>;
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nextId = `n-${counter}`;
    setCounter((v) => v + 1);
    setNodes((prev) => [
      ...prev,
      {
        id: nextId,
        type: 'sandboxNode',
        position,
        data: payload,
      },
    ]);
    setTip(`已添加节点：${payload.label}`);
  }, [counter, reactFlow, setNodes]);

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const cycleEdgeStatus = useCallback((edgeId: string) => {
    setEdges((prev) => prev.map((edge) => {
      if (edge.id !== edgeId) return edge;
      const current = edge.data?.status ?? 'valid';
      const next: EdgeStatus = current === 'valid' ? 'warning' : current === 'warning' ? 'blocked' : 'valid';
      return {
        ...edge,
        data: { status: next },
        style: EDGE_STYLE_MAP[next],
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: EDGE_STYLE_MAP[next].stroke,
        },
      };
    }));
  }, [setEdges]);

  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge<SandboxEdgeData>) => {
    cycleEdgeStatus(edge.id);
    setTip(`边状态已切换：${edge.id}`);
  }, [cycleEdgeStatus]);

  const deleteSelected = useCallback(() => {
    const selectedNodeIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    const selectedEdgeIds = new Set(edges.filter((e) => e.selected).map((e) => e.id));
    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;
    setNodes((prev) => prev.filter((n) => !selectedNodeIds.has(n.id)));
    setEdges((prev) => prev.filter((e) =>
      !selectedEdgeIds.has(e.id) && !selectedNodeIds.has(e.source) && !selectedNodeIds.has(e.target),
    ));
    setTip('已删除选中节点/连线');
  }, [edges, nodes, setEdges, setNodes]);

  const saveLocal = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges, counter }));
    setTip('已保存到本地浏览器');
  }, [counter, edges, nodes]);

  const loadLocal = useCallback(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      setTip('未找到本地存档');
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        nodes: Node<SandboxNodeData>[];
        edges: Edge<SandboxEdgeData>[];
        counter: number;
      };
      setNodes(parsed.nodes);
      setEdges(parsed.edges);
      setCounter(parsed.counter ?? 100);
      setTip('已从本地浏览器加载');
    } catch {
      setTip('本地存档格式损坏');
    }
  }, [setEdges, setNodes]);

  const resetDemo = useCallback(() => {
    setNodes(INITIAL_NODES);
    setEdges(INITIAL_EDGES);
    setCounter(100);
    setTip('已重置为演示初始状态');
  }, [setEdges, setNodes]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
      if (isInput) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [deleteSelected]);

  const selectedSummary = useMemo(() => {
    const nodeCount = nodes.filter((n) => n.selected).length;
    const edgeCount = edges.filter((e) => e.selected).length;
    return `已选中 节点 ${nodeCount} / 连线 ${edgeCount}`;
  }, [edges, nodes]);

  return (
    <div style={{ height: '100vh', display: 'flex', background: '#09090f', color: '#fff' }}>
      <aside
        style={{
          width: 280,
          borderRight: '1px solid rgba(255,255,255,0.12)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          background: 'rgba(12,12,18,0.96)',
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>沙盘免登录演示页</div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
            用于提前演示交互，不依赖后端与权限。
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#8b5cf6' }}>{tip}</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>{selectedSummary}</div>
        <div style={{ display: 'grid', gap: 8 }}>
          <ActionButton text="保存到本地" onClick={saveLocal} />
          <ActionButton text="从本地加载" onClick={loadLocal} />
          <ActionButton text="重置演示状态" onClick={resetDemo} />
          <ActionButton text="删除选中" onClick={deleteSelected} />
        </div>
        <div>
          <div style={{ fontSize: 12, marginBottom: 8, color: 'rgba(255,255,255,0.72)' }}>角色模板（拖拽添加）</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {PALETTE.map((item) => (
              <div
                key={`${item.role}-${item.identity}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/sandbox-node', JSON.stringify(item));
                  event.dataTransfer.effectAllowed = 'move';
                }}
                style={{
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(255,255,255,0.06)',
                  padding: '8px 10px',
                  cursor: 'grab',
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>{item.label}</div>
                <div style={{ marginTop: 4, color: 'rgba(255,255,255,0.7)' }}>{item.role} / {item.identity}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.6, color: 'rgba(255,255,255,0.66)' }}>
          操作提示：
          <br />1. Shift + 框选：多选节点
          <br />2. Delete / Backspace：删除选中
          <br />3. 按住空格 + 拖拽：平移画布
          <br />4. 点击连线：切换状态（绿/黄/红）
        </div>
      </aside>
      <main style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onEdgeClick={onEdgeClick}
          nodeTypes={nodeTypes}
          selectionMode={SelectionMode.Partial}
          selectionKeyCode="Shift"
          panActivationKeyCode="Space"
          deleteKeyCode={null}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'radial-gradient(circle at 20% 20%, #121224 0%, #0a0a13 60%, #08080f 100%)' }}
        >
          <Background gap={22} size={1} color="rgba(255,255,255,0.08)" />
          <MiniMap
            pannable
            zoomable
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)' }}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </main>
    </div>
  );
}

function ActionButton({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        height: 34,
        borderRadius: 8,
        border: '1px solid rgba(139,92,246,0.35)',
        background: 'rgba(139,92,246,0.18)',
        color: '#f5f3ff',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {text}
    </button>
  );
}

export default function SandboxDemoPage() {
  return (
    <ReactFlowProvider>
      <SandboxDemoInner />
    </ReactFlowProvider>
  );
}
