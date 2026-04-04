import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type Node,
  type Edge,
  ReactFlowProvider,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Sparkle, TreePine, Download, Trash2, Plus } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { api } from '@/services/api';
import {
  getEmergenceTree,
  deleteEmergenceTree,
  updateEmergenceNode,
  deleteEmergenceNode,
  exportEmergenceTree,
} from '@/services';
import type { EmergenceNode as EmergenceNodeType } from '@/services/contracts/emergence';
import { EmergenceFlowNode, type EmergenceNodeData } from './EmergenceNode';
import { EmergenceCreateDialog } from './EmergenceCreateDialog';

// ── 自定义节点注册 ──
const nodeTypes = { emergence: EmergenceFlowNode };

// ── 维度颜色 ──
const dimColor: Record<number, string> = {
  1: 'rgba(59,130,246,0.6)',
  2: 'rgba(147,51,234,0.6)',
  3: 'rgba(234,179,8,0.6)',
};

// ── 数据转换 ──
function toFlowNodes(
  nodes: EmergenceNodeType[],
  onExplore: (nodeId: string) => void
): Node<EmergenceNodeData>[] {
  // 自动布局：按层级排列
  const idxMap = new Map<string, number>();
  const depthMap = new Map<string, number>();

  // BFS 计算深度
  const roots = nodes.filter(n => !n.parentId);
  roots.forEach(r => depthMap.set(r.id, 0));
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depthMap.get(current.id) ?? 0;
    const children = nodes.filter(n => n.parentId === current.id);
    children.forEach(c => {
      depthMap.set(c.id, depth + 1);
      queue.push(c);
    });
  }
  // 也处理涌现节点（多父节点，可能不在 parentId 链上）
  nodes.forEach(n => {
    if (!depthMap.has(n.id)) {
      const maxParentDepth = n.parentIds
        .map(pid => depthMap.get(pid) ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      depthMap.set(n.id, maxParentDepth + 1);
    }
  });

  // 按深度分组计算 X 位置
  const depthGroups = new Map<number, string[]>();
  nodes.forEach(n => {
    const d = depthMap.get(n.id) ?? 0;
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d)!.push(n.id);
  });
  depthGroups.forEach((ids) => {
    ids.forEach((id, i) => idxMap.set(id, i));
  });

  return nodes.map(n => {
    const depth = depthMap.get(n.id) ?? 0;
    const idx = idxMap.get(n.id) ?? 0;
    const siblingCount = depthGroups.get(depth)?.length ?? 1;
    const xOffset = (idx - (siblingCount - 1) / 2) * 320;

    return {
      id: n.id,
      type: 'emergence',
      position: n.positionX !== 0 || n.positionY !== 0
        ? { x: n.positionX, y: n.positionY }
        : { x: xOffset, y: depth * 200 },
      data: {
        label: n.title,
        description: n.description,
        dimension: n.dimension,
        nodeType: n.nodeType,
        valueScore: n.valueScore,
        difficultyScore: n.difficultyScore,
        status: n.status,
        groundingContent: n.groundingContent,
        bridgeAssumptions: n.bridgeAssumptions ?? [],
        tags: n.tags ?? [],
        onExplore: () => onExplore(n.id),
      } satisfies EmergenceNodeData,
    };
  });
}

function toFlowEdges(nodes: EmergenceNodeType[]): Edge[] {
  const edges: Edge[] = [];
  for (const n of nodes) {
    // 单父节点边
    if (n.parentId) {
      edges.push({
        id: `${n.parentId}->${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: n.dimension >= 2,
        style: { stroke: dimColor[n.dimension] ?? dimColor[1], strokeWidth: 1.5 },
        ...(n.dimension === 2 ? { strokeDasharray: '5,5' } : {}),
      });
    }
    // 多父节点边（涌现节点）
    for (const pid of n.parentIds) {
      if (pid === n.parentId) continue; // 已处理
      edges.push({
        id: `${pid}->>${n.id}`,
        source: pid,
        target: n.id,
        animated: true,
        style: { stroke: dimColor[n.dimension] ?? dimColor[2], strokeWidth: 1, opacity: 0.6 },
      });
    }
  }
  return edges;
}

// ── 主组件 ──
interface EmergenceCanvasProps {
  treeId: string;
  onBack: () => void;
}

function EmergenceCanvasInner({ treeId, onBack }: EmergenceCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EmergenceNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [treeTitle, setTreeTitle] = useState('');
  const [nodeCount, setNodeCount] = useState(0);

  // ── 探索 SSE ──
  const {
    phase: explorePhase,
    phaseMessage: exploreMessage,
    isStreaming: isExploring,
    start: startExplore,
    abort: abortExplore,
  } = useSseStream<EmergenceNodeType>({
    url: '', // 由 start() 覆盖
    method: 'POST',
    phaseEvent: 'stage',
    itemEvent: 'node',
    onItem: (newNode) => {
      // 新节点加入画布
      const flowNode = toFlowNodes([newNode], handleExplore)[0];
      if (flowNode) {
        setNodes(prev => [...prev, flowNode]);
        // 添加边
        const newEdges = toFlowEdges([newNode]);
        setEdges(prev => [...prev, ...newEdges]);
        setNodeCount(c => c + 1);
      }
    },
    onPhase: (msg) => {}, // phase bar handles display
  });

  // ── 涌现 SSE ──
  const {
    phase: emergePhase,
    phaseMessage: emergeMessage,
    isStreaming: isEmerging,
    start: startEmerge,
    abort: abortEmerge,
  } = useSseStream<EmergenceNodeType>({
    url: '', // 由 start() 覆盖
    method: 'POST',
    phaseEvent: 'stage',
    itemEvent: 'node',
    onItem: (newNode) => {
      const flowNode = toFlowNodes([newNode], handleExplore)[0];
      if (flowNode) {
        setNodes(prev => [...prev, flowNode]);
        const newEdges = toFlowEdges([newNode]);
        setEdges(prev => [...prev, ...newEdges]);
        setNodeCount(c => c + 1);
      }
    },
  });

  // ── 加载树 ──
  const loadTree = useCallback(async () => {
    const res = await getEmergenceTree(treeId);
    if (!res.success) return;

    const { tree, nodes: backendNodes } = res.data;
    setTreeTitle(tree.title);
    setNodeCount(tree.nodeCount);

    const flowNodes = toFlowNodes(backendNodes, handleExplore);
    const flowEdges = toFlowEdges(backendNodes);
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [treeId]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // ── 操作 ──
  const handleExplore = useCallback((nodeId: string) => {
    if (isExploring || isEmerging) return;
    startExplore({ url: api.emergence.nodes.explore(nodeId) });
  }, [isExploring, isEmerging, startExplore]);

  const handleEmerge = useCallback((fantasy: boolean) => {
    if (isExploring || isEmerging) return;
    const url = `${api.emergence.trees.emerge(treeId)}${fantasy ? '?fantasy=true' : ''}`;
    startEmerge({ url });
  }, [treeId, isExploring, isEmerging, startEmerge]);

  const handleExport = useCallback(async () => {
    const res = await exportEmergenceTree(treeId);
    if (res.success) {
      const blob = new Blob([res.data.markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${treeTitle || 'emergence'}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [treeId, treeTitle]);

  const isStreaming = isExploring || isEmerging;
  const currentPhase = isExploring ? explorePhase : emergePhase;
  const currentMessage = isExploring ? exploreMessage : emergeMessage;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 顶部工具栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 13 }}>
          ← 返回
        </button>
        <TreePine size={16} style={{ opacity: 0.6 }} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>{treeTitle}</span>
        <span style={{ fontSize: 12, opacity: 0.5 }}>{nodeCount} 个节点</span>

        <div style={{ flex: 1 }} />

        {/* 涌现按钮 */}
        {nodeCount >= 3 && (
          <>
            <button
              onClick={() => handleEmerge(false)}
              disabled={isStreaming}
              style={{
                padding: '5px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                background: 'rgba(147,51,234,0.15)', border: '1px solid rgba(147,51,234,0.3)',
                color: 'inherit', opacity: isStreaming ? 0.5 : 1,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Sparkle size={13} /> 二维涌现
            </button>
            <button
              onClick={() => handleEmerge(true)}
              disabled={isStreaming}
              style={{
                padding: '5px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)',
                color: 'inherit', opacity: isStreaming ? 0.5 : 1,
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Sparkle size={13} /> 三维幻想
            </button>
          </>
        )}

        <button
          onClick={handleExport}
          style={{
            padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            color: 'inherit', display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Download size={13} /> 导出
        </button>
      </div>

      {/* SSE 状态栏 */}
      {isStreaming && (
        <SsePhaseBar phase={currentPhase} message={currentMessage} />
      )}

      {/* React Flow 画布 */}
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.03)" />
          <MiniMap
            style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8 }}
            nodeColor={(n) => {
              const dim = (n.data as EmergenceNodeData)?.dimension ?? 1;
              return dimColor[dim] ?? dimColor[1];
            }}
          />
          <Controls style={{ borderRadius: 8 }} />

          {/* 图例 */}
          <Panel position="bottom-left">
            <div style={{ display: 'flex', gap: 16, fontSize: 11, opacity: 0.5, padding: 8 }}>
              <span style={{ color: dimColor[1] }}>● 一维·系统内</span>
              <span style={{ color: dimColor[2] }}>◆ 二维·跨系统</span>
              <span style={{ color: dimColor[3] }}>★ 三维·幻想</span>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}

// ── 页面入口 ──
export function EmergenceExplorerPage() {
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [trees, setTrees] = useState<Array<{ id: string; title: string; nodeCount: number; updatedAt: string }>>([]);
  const [loading, setLoading] = useState(true);

  const loadTrees = useCallback(async () => {
    setLoading(true);
    const { listEmergenceTrees } = await import('@/services');
    const res = await listEmergenceTrees(1, 50);
    if (res.success) setTrees(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { loadTrees(); }, [loadTrees]);

  if (selectedTreeId) {
    return (
      <ReactFlowProvider>
        <EmergenceCanvasInner treeId={selectedTreeId} onBack={() => { setSelectedTreeId(null); loadTrees(); }} />
      </ReactFlowProvider>
    );
  }

  // 树列表
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>涌现探索器</h1>
          <p style={{ fontSize: 13, opacity: 0.5, margin: '4px 0 0' }}>从一颗种子开始，探索 → 组合 → 涌现</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{
            padding: '8px 18px', borderRadius: 10, fontSize: 13, cursor: 'pointer',
            background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
            color: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <Plus size={15} /> 新建涌现树
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, opacity: 0.5 }}>加载中…</div>
      ) : trees.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, opacity: 0.4 }}>
          <TreePine size={48} style={{ marginBottom: 16 }} />
          <div style={{ fontSize: 14 }}>还没有涌现树，点击「新建」开始探索</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {trees.map(t => (
            <div
              key={t.id}
              onClick={() => setSelectedTreeId(t.id)}
              style={{
                padding: 16, borderRadius: 12, cursor: 'pointer',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                transition: 'border-color 0.2s, background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.3)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
            >
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{t.title}</div>
              <div style={{ fontSize: 12, opacity: 0.5 }}>
                {t.nodeCount} 个节点 · {new Date(t.updatedAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <EmergenceCreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={(treeId) => { setShowCreate(false); setSelectedTreeId(treeId); }}
        />
      )}
    </div>
  );
}
