import { useCallback, useEffect, useState } from 'react';
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
import { Sparkle, TreePine, Download, Plus, Star } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { api } from '@/services/api';
import {
  getEmergenceTree,
  listEmergenceTrees,
  exportEmergenceTree,
} from '@/services';
import type { EmergenceNode as EmergenceNodeType } from '@/services/contracts/emergence';
import { EmergenceFlowNode, type EmergenceNodeData } from './EmergenceNode';
import { EmergenceCreateDialog } from './EmergenceCreateDialog';

// ── 自定义节点注册 ──
const nodeTypes = { emergence: EmergenceFlowNode };

// ── 维度颜色（MiniMap 复用）──
const dimColor: Record<number, string> = {
  1: 'rgba(59,130,246,0.7)',
  2: 'rgba(147,51,234,0.7)',
  3: 'rgba(234,179,8,0.7)',
};

// ── 数据转换：后端����� → React Flow 节点 ──
function toFlowNodes(
  nodes: EmergenceNodeType[],
  onExplore: (nodeId: string) => void,
): Node<EmergenceNodeData>[] {
  // BFS 计算深度
  const depthMap = new Map<string, number>();
  const roots = nodes.filter(n => !n.parentId);
  roots.forEach(r => depthMap.set(r.id, 0));
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depthMap.get(current.id) ?? 0;
    const children = nodes.filter(n => n.parentId === current.id);
    children.forEach(c => {
      if (!depthMap.has(c.id)) {
        depthMap.set(c.id, depth + 1);
        queue.push(c);
      }
    });
  }
  // 涌现节点可能不在 parentId 链上
  nodes.forEach(n => {
    if (!depthMap.has(n.id)) {
      const maxParentDepth = n.parentIds
        .map(pid => depthMap.get(pid) ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      depthMap.set(n.id, maxParentDepth + 1);
    }
  });

  // 按深度分组计算 X
  const depthGroups = new Map<number, string[]>();
  nodes.forEach(n => {
    const d = depthMap.get(n.id) ?? 0;
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d)!.push(n.id);
  });
  const idxMap = new Map<string, number>();
  depthGroups.forEach(ids => ids.forEach((id, i) => idxMap.set(id, i)));

  return nodes.map(n => {
    const depth = depthMap.get(n.id) ?? 0;
    const idx = idxMap.get(n.id) ?? 0;
    const siblingCount = depthGroups.get(depth)?.length ?? 1;
    const xOffset = (idx - (siblingCount - 1) / 2) * 320;

    return {
      id: n.id,
      type: 'emergence',
      position: n.positionX || n.positionY
        ? { x: n.positionX, y: n.positionY }
        : { x: xOffset, y: depth * 220 },
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
    if (n.parentId) {
      edges.push({
        id: `${n.parentId}->${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: n.dimension >= 2,
        style: { stroke: dimColor[n.dimension] ?? dimColor[1], strokeWidth: 1.5 },
      });
    }
    for (const pid of n.parentIds) {
      if (pid === n.parentId) continue;
      edges.push({
        id: `${pid}->>${n.id}`,
        source: pid,
        target: n.id,
        animated: true,
        style: { stroke: dimColor[n.dimension] ?? dimColor[2], strokeWidth: 1, opacity: 0.5 },
      });
    }
  }
  return edges;
}

// ── 涌现画布 ──
interface CanvasProps { treeId: string; onBack: () => void }

function EmergenceCanvasInner({ treeId, onBack }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EmergenceNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [treeTitle, setTreeTitle] = useState('');
  const [nodeCount, setNodeCount] = useState(0);

  // ── 探索 SSE ──
  const { phase: explorePhase, phaseMessage: exploreMsg, isStreaming: isExploring, start: startExplore } =
    useSseStream<EmergenceNodeType>({
      url: '',
      method: 'POST',
      phaseEvent: 'stage',
      itemEvent: 'node',
      onItem: (newNode) => {
        const [flowNode] = toFlowNodes([newNode], handleExplore);
        if (flowNode) {
          setNodes(prev => [...prev, flowNode]);
          setEdges(prev => [...prev, ...toFlowEdges([newNode])]);
          setNodeCount(c => c + 1);
        }
      },
    });

  // ── 涌现 SSE ──
  const { phase: emergePhase, phaseMessage: emergeMsg, isStreaming: isEmerging, start: startEmerge } =
    useSseStream<EmergenceNodeType>({
      url: '',
      method: 'POST',
      phaseEvent: 'stage',
      itemEvent: 'node',
      onItem: (newNode) => {
        const [flowNode] = toFlowNodes([newNode], handleExplore);
        if (flowNode) {
          setNodes(prev => [...prev, flowNode]);
          setEdges(prev => [...prev, ...toFlowEdges([newNode])]);
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
    setNodes(toFlowNodes(backendNodes, handleExplore));
    setEdges(toFlowEdges(backendNodes));
  }, [treeId]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // ── 操作 ──
  const handleExplore = useCallback((nodeId: string) => {
    if (isExploring || isEmerging) return;
    startExplore({ url: api.emergence.nodes.explore(nodeId) });
  }, [isExploring, isEmerging, startExplore]);

  const handleEmerge = useCallback((fantasy: boolean) => {
    if (isExploring || isEmerging) return;
    startEmerge({ url: `${api.emergence.trees.emerge(treeId)}${fantasy ? '?fantasy=true' : ''}` });
  }, [treeId, isExploring, isEmerging, startEmerge]);

  const handleExport = useCallback(async () => {
    const res = await exportEmergenceTree(treeId);
    if (!res.success) return;
    const blob = new Blob([res.data.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${treeTitle || 'emergence'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [treeId, treeTitle]);

  const isStreaming = isExploring || isEmerging;
  const currentPhase = isExploring ? explorePhase : emergePhase;
  const currentMsg = isExploring ? exploreMsg : emergeMsg;

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* 顶部 TabBar */}
      <TabBar
        title={
          <div className="flex items-center gap-2">
            <button onClick={onBack} className="text-[12px] cursor-pointer hover:bg-white/6 px-2 py-1 rounded-[8px] transition-colors duration-200"
              style={{ color: 'var(--text-muted)' }}>
              ← 返回
            </button>
            <TreePine size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{treeTitle}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{nodeCount} 个节点</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {nodeCount >= 3 && (
              <>
                <Button variant="ghost" size="xs" onClick={() => handleEmerge(false)} disabled={isStreaming}>
                  <Sparkle size={13} /> 二维涌现
                </Button>
                <Button variant="ghost" size="xs" onClick={() => handleEmerge(true)} disabled={isStreaming}>
                  <Star size={13} /> 三维幻想
                </Button>
              </>
            )}
            <Button variant="secondary" size="xs" onClick={handleExport}>
              <Download size={13} /> 导出
            </Button>
          </div>
        }
      />

      {/* SSE 状态栏 */}
      {isStreaming && <SsePhaseBar phase={currentPhase} message={currentMsg} />}

      {/* React Flow 画布 */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.15}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.03)" />
          <MiniMap
            style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
            nodeColor={(n) => dimColor[(n.data as EmergenceNodeData)?.dimension ?? 1] ?? dimColor[1]}
          />
          <Controls style={{ borderRadius: 10 }} />

          {/* 图例 */}
          <Panel position="bottom-left">
            <div className="flex gap-4 text-[11px] px-3 py-1.5 rounded-[10px]"
              style={{ color: 'var(--text-muted)', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>
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

// ── 页面入口���树列表 + 画布切换 ──
export function EmergenceExplorerPage() {
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [trees, setTrees] = useState<Array<{ id: string; title: string; description?: string; nodeCount: number; updatedAt: string }>>([]);
  const [loading, setLoading] = useState(true);

  const loadTrees = useCallback(async () => {
    setLoading(true);
    const res = await listEmergenceTrees(1, 50);
    if (res.success) setTrees(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { loadTrees(); }, [loadTrees]);

  // 画布模��
  if (selectedTreeId) {
    return (
      <ReactFlowProvider>
        <EmergenceCanvasInner treeId={selectedTreeId} onBack={() => { setSelectedTreeId(null); loadTrees(); }} />
      </ReactFlowProvider>
    );
  }

  // 树列表模式
  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      {/* 标题栏 */}
      <TabBar
        title="涌现探��器"
        icon={<TreePine size={14} />}
        actions={
          <Button variant="primary" size="xs" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> 新建涌现树
          </Button>
        }
      />

      {/* 内容区域 */}
      <div className="px-5 pb-6 w-full">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <MapSpinner size={16} />
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</span>
          </div>
        ) : trees.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <TreePine size={48} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 16 }} />
            <p className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
              还没有涌现树
            </p>
            <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>
              从一颗种子开始，探索 → 组合 → 涌现
            </p>
            <Button variant="primary" size="xs" onClick={() => setShowCreate(true)}>
              <Plus size={13} /> 开始涌现
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
            {trees.map(t => (
              <GlassCard
                key={t.id}
                animated
                interactive
                padding="none"
                className="group flex flex-col h-full"
                onClick={() => setSelectedTreeId(t.id)}
              >
                <div className="p-4 pb-3 flex-1 flex flex-col">
                  {/* 头部 */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.12)' }}>
                        <TreePine size={16} style={{ color: 'rgba(147,51,234,0.85)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {t.title}
                        </h3>
                        {t.description && (
                          <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {t.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 底部统计 */}
                  <div className="flex-1" />
                  <div className="flex items-center justify-between mt-3 pt-2.5"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <span><span style={{ color: 'var(--text-secondary)' }}>{t.nodeCount}</span> 个节点</span>
                    </div>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {new Date(t.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                {/* 底部操作栏 */}
                <div className="flex items-center gap-1.5 px-4 py-2.5 mt-auto"
                  style={{ background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <button className="surface-row flex-1 h-7 rounded-[8px] text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
                    style={{ background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.15)', color: 'rgba(147,51,234,0.85)' }}>
                    <Sparkle size={11} /> 进入探索
                  </button>
                </div>
              </GlassCard>
            ))}
          </div>
        )}
      </div>

      {/* 创建对话框 */}
      {showCreate && (
        <EmergenceCreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={(treeId) => { setShowCreate(false); setSelectedTreeId(treeId); }}
        />
      )}
    </div>
  );
}
