import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { Sparkle, TreePine, Download, Plus, Star, MousePointerClick, Zap, X } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { toast } from '@/lib/toast';
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

// ── 数据转换：后端节点 → React Flow 节点 ──
function toFlowNodes(
  nodes: EmergenceNodeType[],
  onExplore: (nodeId: string) => void,
  onStatusChange?: (nodeId: string, newStatus: string) => void,
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
        missingCapabilities: n.missingCapabilities ?? [],
        tags: n.tags ?? [],
        onExplore: () => onExplore(n.id),
        onStatusChange: onStatusChange ? (s: string) => onStatusChange(n.id, s) : undefined,
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
        const [flowNode] = toFlowNodes([newNode], handleExplore, handleStatusChange);
        if (flowNode) {
          setNodes(prev => [...prev, flowNode]);
          setEdges(prev => [...prev, ...toFlowEdges([newNode])]);
          setNodeCount(c => c + 1);
        }
      },
      onDone: (data) => {
        const d = data as { totalNew?: number; error?: string };
        if (d.error) {
          toast.error('探索失败', d.error);
        } else if (!d.totalNew || d.totalNew === 0) {
          toast.warning('探索未生成节点', '可能是种子内容过短，请尝试提供更详细的描述。');
        } else {
          toast.success('探索完成', `新增 ${d.totalNew} 个节点`);
        }
      },
      onError: (msg) => {
        toast.error('探索失败', msg);
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
        const [flowNode] = toFlowNodes([newNode], handleExplore, handleStatusChange);
        if (flowNode) {
          setNodes(prev => [...prev, flowNode]);
          setEdges(prev => [...prev, ...toFlowEdges([newNode])]);
          setNodeCount(c => c + 1);
        }
      },
      onDone: (data) => {
        const d = data as { totalNew?: number; error?: string };
        if (d.error) {
          toast.error('涌现失败', d.error);
        } else if (!d.totalNew || d.totalNew === 0) {
          toast.warning('涌现未生成节点', '已有节点可能不足以组合，请先探索更多节点。');
        } else {
          toast.success('涌现完成', `新增 ${d.totalNew} 个组合节点`);
        }
      },
      onError: (msg) => {
        toast.error('涌现失败', msg);
      },
    });

  // ── 加载树 ──
  const loadTree = useCallback(async () => {
    const res = await getEmergenceTree(treeId);
    if (!res.success) return;
    const { tree, nodes: backendNodes } = res.data;
    setTreeTitle(tree.title);
    setNodeCount(tree.nodeCount);
    setNodes(toFlowNodes(backendNodes, handleExplore, handleStatusChange));
    setEdges(toFlowEdges(backendNodes));
  }, [treeId]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // ── 操作 ──
  const handleExplore = useCallback((nodeId: string) => {
    if (isExploring || isEmerging) return;
    startExplore({ url: api.emergence.nodes.explore(nodeId) });
  }, [isExploring, isEmerging, startExplore]);

  const handleStatusChange = useCallback(async (nodeId: string, newStatus: string) => {
    const { updateEmergenceNode } = await import('@/services');
    await updateEmergenceNode(nodeId, { status: newStatus });
    // 更新本地节点状态
    setNodes(prev => prev.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, status: newStatus as EmergenceNodeData['status'] } } : n
    ));
  }, [setNodes]);

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

  // ── 引导状态 ──
  const [guideStep, setGuideStep] = useState<'seed' | 'explored' | 'emerged' | 'dismissed'>('seed');
  const [guideDismissed, setGuideDismissed] = useState(false);

  // 根据节点数量自动推进引导
  useEffect(() => {
    if (guideDismissed) return;
    if (nodeCount <= 1) setGuideStep('seed');
    else if (nodeCount < 5) setGuideStep('explored');
    else setGuideStep('emerged');
  }, [nodeCount, guideDismissed]);

  const isStreaming = isExploring || isEmerging;
  const currentPhase = isExploring ? explorePhase : emergePhase;
  const currentMsg = isExploring ? exploreMsg : emergeMsg;

  // 引导文案
  const guideContent: Record<string, { title: string; desc: string; icon: typeof Zap }> = {
    seed: { title: '点击种子节点的「探索」按钮', desc: 'AI 会基于种子内容，在系统内寻找可实现的子功能', icon: MousePointerClick },
    explored: { title: '继续探索，或尝试涌现', desc: '节点达到 3 个后，顶部会出现「二维涌现」按钮——AI 将组合多个节点发现新可能', icon: Sparkle },
    emerged: { title: '尝试三维幻想', desc: '放宽技术约束，想象 3-5 年后的可能性。每个幻想仍需标注假设条件', icon: Star },
  };

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
            style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
            maskColor="rgba(0,0,0,0.6)"
            nodeColor={(n) => dimColor[(n.data as EmergenceNodeData)?.dimension ?? 1] ?? dimColor[1]}
            pannable
            zoomable={false}
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

          {/* 引导面板 */}
          {!guideDismissed && guideContent[guideStep] && !isStreaming && (
            <Panel position="bottom-right">
              {(() => {
                const g = guideContent[guideStep];
                return (
                  <div className="w-[260px] p-3.5 rounded-[12px] relative"
                    style={{
                      background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
                      border: '1px solid rgba(147,51,234,0.18)',
                      backdropFilter: 'blur(40px) saturate(180%)',
                      boxShadow: '0 8px 24px -4px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.08)',
                    }}>
                    <button
                      onClick={() => setGuideDismissed(true)}
                      className="absolute top-2 right-2 w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
                      style={{ color: 'var(--text-muted)' }}>
                      <X size={11} />
                    </button>
                    <div className="flex items-start gap-2.5">
                      <div className="w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ background: 'rgba(147,51,234,0.1)', border: '1px solid rgba(147,51,234,0.15)' }}>
                        <g.icon size={13} style={{ color: 'rgba(147,51,234,0.9)' }} />
                      </div>
                      <div className="min-w-0 pr-4">
                        <p className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                          {g.title}
                        </p>
                        <p className="text-[11px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>
                          {g.desc}
                        </p>
                      </div>
                    </div>
                    {/* 进度指示 */}
                    <div className="flex gap-1.5 mt-3 justify-center">
                      {['seed', 'explored', 'emerged'].map((s, i) => (
                        <div key={s} className="h-1 rounded-full transition-all duration-300"
                          style={{
                            width: s === guideStep ? 20 : 6,
                            background: s === guideStep ? 'rgba(147,51,234,0.7)' : 'rgba(255,255,255,0.1)',
                          }} />
                      ))}
                    </div>
                  </div>
                );
              })()}
            </Panel>
          )}
        </ReactFlow>
      </div>
    </div>
  );
}

// ── 页面入口：树列表 + 画布切换 ──
export function EmergenceExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [trees, setTrees] = useState<Array<{ id: string; title: string; description?: string; nodeCount: number; updatedAt: string }>>([]);
  const [loading, setLoading] = useState(true);

  // 从文档空间跳转来的参数
  const seedTitle = searchParams.get('seedTitle');
  const seedSourceType = searchParams.get('seedSourceType');
  const seedSourceId = searchParams.get('seedSourceId');

  // 自动打开创建对话框（如果有 URL 参数）
  useEffect(() => {
    if (seedSourceId) setShowCreate(true);
  }, [seedSourceId]);

  const loadTrees = useCallback(async () => {
    setLoading(true);
    const res = await listEmergenceTrees(1, 50);
    if (res.success) setTrees(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { loadTrees(); }, [loadTrees]);

  // 画布模式
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
        title="涌现探索器"
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
          <div className="flex flex-col items-center justify-center py-12">
            <TreePine size={44} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 20 }} />
            <p className="text-[16px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              涌现探索器
            </p>
            <p className="text-[12px] mb-6" style={{ color: 'var(--text-muted)' }}>
              从一颗种子开始，AI 帮你发现下一步做什么
            </p>

            {/* 三步引导 */}
            <div className="grid grid-cols-3 gap-4 mb-8 max-w-[560px] w-full">
              {[
                { step: '1', icon: TreePine, title: '种下种子', desc: '上传一段文档或方案作为起点' },
                { step: '2', icon: Zap, title: '探索生长', desc: '点击节点，AI 基于现实能力生成子功能' },
                { step: '3', icon: Sparkle, title: '涌现组合', desc: '多个节点交叉组合，发现意想不到的可能' },
              ].map(s => (
                <div key={s.step} className="surface-inset rounded-[12px] p-4 flex flex-col items-center text-center">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center mb-2.5"
                    style={{ background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.12)' }}>
                    <s.icon size={14} style={{ color: 'rgba(147,51,234,0.85)' }} />
                  </div>
                  <p className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                    {s.title}
                  </p>
                  <p className="text-[11px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>
                    {s.desc}
                  </p>
                </div>
              ))}
            </div>

            <Button variant="primary" size="md" onClick={() => setShowCreate(true)}>
              <Plus size={15} /> 种下第一颗种子
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
          onClose={() => {
            setShowCreate(false);
            if (seedSourceId) setSearchParams({}, { replace: true });
          }}
          onCreated={(treeId) => {
            setShowCreate(false);
            setSelectedTreeId(treeId);
            if (seedSourceId) setSearchParams({}, { replace: true });
          }}
          initialSeedTitle={seedTitle ? decodeURIComponent(seedTitle) : undefined}
          initialSeedSourceType={seedSourceType ?? undefined}
          initialSeedSourceId={seedSourceId ?? undefined}
        />
      )}
    </div>
  );
}
