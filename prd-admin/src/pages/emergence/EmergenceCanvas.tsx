import { useCallback, useEffect, useRef, useState } from 'react';
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
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Sparkle, TreePine, Download, Plus, Star, MousePointerClick, Zap, X, Info, Wand2, StopCircle } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { EmergenceStreamingBar } from './EmergenceStreamingBar';
import { toast } from '@/lib/toast';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { api } from '@/services/api';
import {
  getEmergenceTree,
  listEmergenceTrees,
  exportEmergenceTree,
} from '@/services';
import type { EmergenceNode as EmergenceNodeType } from '@/services/contracts/emergence';
import { EmergenceFlowNode, type EmergenceNodeData } from './EmergenceNode';
import { EmergenceCreateDialog } from './EmergenceCreateDialog';
import { EmergenceIntroPage } from './EmergenceIntroPage';
import { EmergenceInspireDialog } from './EmergenceInspireDialog';
import { EmergenceTreeCard } from './EmergenceTreeCard';
import { EmergenceEmergePopover } from './EmergenceEmergePopover';
import './emergence.css';

const INTRO_SEEN_KEY = 'emergence.intro.seen';
const PLACEHOLDER_COUNT = 4;

// ── 自定义节点注册 ──
const nodeTypes = { emergence: EmergenceFlowNode };

// ── 维度颜色（MiniMap 复用）──
const dimColor: Record<number, string> = {
  1: 'rgba(59,130,246,0.7)',
  2: 'rgba(147,51,234,0.7)',
  3: 'rgba(234,179,8,0.7)',
};

// ── 数据转换：后端节点 → React Flow 节点 ──
// 布局：基于子树宽度的递归树布局，父节点居中于子节点群之上
// LEAF_WIDTH: 节点中心间距,大于卡片最大宽度(300)+ 充分 gap,避免横向贴边
// DEPTH_STEP: 父子节点的垂直间距,真实卡片含描述/标签/按钮可达 260-280px,需留呼吸空间
const LEAF_WIDTH = 360;
const DEPTH_STEP = 340;

interface PlaceholderNodeSpec {
  /** 占位节点在画布上的虚拟父节点 id */
  parentId: string;
  /** 占位节点本身的 id（保证唯一，便于替换） */
  id: string;
  /** 在父节点下第几个占位（用于错开动画 & 定位） */
  index: number;
  /** 推理维度：1=探索, 2=涌现, 3=幻想 */
  dimension: 1 | 2 | 3;
}

function toFlowNodes(
  nodes: EmergenceNodeType[],
  onExplore: (nodeId: string) => void,
  onInspire: (nodeId: string) => void,
  onStatusChange: (nodeId: string, newStatus: string) => void,
  placeholders: PlaceholderNodeSpec[],
  arrivedIds: Set<string>,
  liveText?: string,
): Node<EmergenceNodeData>[] {
  const byId = new Map(nodes.map(n => [n.id, n]));

  // 以 parentId 为主,没有则取 parentIds[0] 作为锚点(涌现节点)
  const anchorParent = (n: EmergenceNodeType): string | undefined => {
    if (n.parentId && byId.has(n.parentId)) return n.parentId;
    const firstMulti = n.parentIds.find(pid => byId.has(pid));
    return firstMulti;
  };

  const childrenMap = new Map<string, string[]>();
  const roots: string[] = [];
  nodes.forEach(n => {
    const p = anchorParent(n);
    if (p) {
      if (!childrenMap.has(p)) childrenMap.set(p, []);
      childrenMap.get(p)!.push(n.id);
    } else {
      roots.push(n.id);
    }
  });

  // 占位节点参与布局：按其 parentId 附加为该父的虚拟子节点
  const placeholderById = new Map(placeholders.map(p => [p.id, p]));
  placeholders.forEach(p => {
    if (byId.has(p.parentId) || placeholderById.has(p.parentId)) {
      if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
      childrenMap.get(p.parentId)!.push(p.id);
    }
  });

  // 递归计算子树宽度(叶子节点 = LEAF_WIDTH)
  const subtreeWidth = new Map<string, number>();
  const measure = (id: string, seen: Set<string>): number => {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id)!;
    if (seen.has(id)) return LEAF_WIDTH; // 防环
    seen.add(id);
    const kids = childrenMap.get(id) ?? [];
    if (kids.length === 0) {
      subtreeWidth.set(id, LEAF_WIDTH);
      return LEAF_WIDTH;
    }
    const total = kids.reduce((acc, k) => acc + measure(k, seen), 0);
    subtreeWidth.set(id, total);
    return total;
  };
  roots.forEach(r => measure(r, new Set()));
  // 孤立节点兜底
  nodes.forEach(n => measure(n.id, new Set()));

  // 递归布置
  const positions = new Map<string, { x: number; y: number }>();
  const place = (id: string, centerX: number, depth: number, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    positions.set(id, { x: centerX, y: depth * DEPTH_STEP });
    const kids = childrenMap.get(id) ?? [];
    const total = kids.reduce((acc, k) => acc + (subtreeWidth.get(k) ?? LEAF_WIDTH), 0);
    let cursor = centerX - total / 2;
    kids.forEach(k => {
      const w = subtreeWidth.get(k) ?? LEAF_WIDTH;
      place(k, cursor + w / 2, depth + 1, seen);
      cursor += w;
    });
  };
  const rootsTotal = roots.reduce((acc, r) => acc + (subtreeWidth.get(r) ?? LEAF_WIDTH), 0);
  let rCursor = -rootsTotal / 2;
  const placed = new Set<string>();
  roots.forEach(r => {
    const w = subtreeWidth.get(r) ?? LEAF_WIDTH;
    place(r, rCursor + w / 2, 0, placed);
    rCursor += w;
  });
  // 兜底:任何未定位的节点(如锚点不在当前子集中的涌现节点)
  nodes.forEach(n => {
    if (!positions.has(n.id)) {
      const anchor = anchorParent(n);
      const anchorPos = anchor ? positions.get(anchor) : undefined;
      if (anchorPos) {
        positions.set(n.id, { x: anchorPos.x, y: anchorPos.y + DEPTH_STEP });
      } else {
        positions.set(n.id, { x: 0, y: 0 });
      }
    }
  });

  const realFlowNodes: Node<EmergenceNodeData>[] = nodes.map(n => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: 'emergence',
      position: n.positionX || n.positionY
        ? { x: n.positionX, y: n.positionY }
        : pos,
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
        onInspire: () => onInspire(n.id),
        onStatusChange: (s: string) => onStatusChange(n.id, s),
        isJustArrived: arrivedIds.has(n.id),
      } satisfies EmergenceNodeData,
    };
  });

  const placeholderFlowNodes: Node<EmergenceNodeData>[] = placeholders.map((p, i) => {
    const pos = positions.get(p.id) ?? { x: 0, y: 0 };
    // 只把 liveText 喂给占位数组中的第一个元素(视觉上的"正在打字"卡片)
    const showLive = i === 0 && !!liveText;
    return {
      id: p.id,
      type: 'emergence',
      position: pos,
      draggable: false,
      selectable: false,
      data: {
        label: '',
        description: '',
        dimension: p.dimension,
        nodeType: 'capability',
        valueScore: 0,
        difficultyScore: 0,
        status: 'idea',
        groundingContent: '',
        bridgeAssumptions: [],
        missingCapabilities: [],
        tags: [],
        isPlaceholder: true,
        placeholderIndex: p.index,
        liveText: showLive ? liveText : undefined,
      } satisfies EmergenceNodeData,
    };
  });

  return [...realFlowNodes, ...placeholderFlowNodes];
}

function toFlowEdges(nodes: EmergenceNodeType[], placeholders: PlaceholderNodeSpec[]): Edge[] {
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
  // 占位边：虚线 + animated,暗示"正在涌现"
  for (const p of placeholders) {
    edges.push({
      id: `ph:${p.parentId}->${p.id}`,
      source: p.parentId,
      target: p.id,
      animated: true,
      style: {
        stroke: dimColor[p.dimension] ?? dimColor[1],
        strokeWidth: 1,
        strokeDasharray: '4 4',
        opacity: 0.5,
      },
    });
  }
  return edges;
}

// ── 涌现画布 ──
interface CanvasProps { treeId: string; onBack: () => void }

function EmergenceCanvasInner({ treeId, onBack }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EmergenceNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [treeTitle, setTreeTitle] = useState('');
  const [nodeCount, setNodeCount] = useState(0);
  // 保存原始后端节点用于增量到达时整体重新布局(修复堆积在同一位置的 bug)
  const backendNodesRef = useRef<EmergenceNodeType[]>([]);
  // 占位骨架节点(点击探索/涌现瞬间先显示,SSE 到达后逐个替换)
  const placeholdersRef = useRef<PlaceholderNodeSpec[]>([]);
  // 刚到达节点的入场动画标记,0.6s 后清除
  const arrivedIdsRef = useRef<Set<string>>(new Set());
  // 灵感对话框状态
  const [inspireTargetId, setInspireTargetId] = useState<string | null>(null);
  // 提前声明 callback 引用,供 relayout 使用(真实 handler 稍后再 wire 进来,避免 TDZ / use-before-define)
  const handleExploreRef = useRef<(nodeId: string) => void>(() => {});
  const handleInspireRef = useRef<(nodeId: string) => void>(() => {});
  const handleStatusChangeRef = useRef<(nodeId: string, status: string) => void>(() => {});
  // LLM 流式累积的原始文本,由 useSseStream.typing 持续更新(通过 effect 同步到 ref)
  const liveTypingRef = useRef<string>('');
  // LLM 思考流(reasoning_content):在首字到达前展示给用户,消除空白等待
  const [exploreThinking, setExploreThinking] = useState('');
  const [emergeThinking, setEmergeThinking] = useState('');

  const relayout = useCallback(() => {
    const all = backendNodesRef.current;
    setNodes(toFlowNodes(
      all,
      (id) => handleExploreRef.current(id),
      (id) => handleInspireRef.current(id),
      (id, s) => handleStatusChangeRef.current(id, s),
      placeholdersRef.current,
      arrivedIdsRef.current,
      liveTypingRef.current,
    ));
    setEdges(toFlowEdges(all, placeholdersRef.current));
  }, [setNodes, setEdges]);

  // 工具:消费一个占位槽位(每当一个真实节点到达)
  const consumePlaceholder = useCallback((parentId: string | null) => {
    if (!parentId) {
      // 涌现场景无固定父节点,从任意占位弹一个
      if (placeholdersRef.current.length > 0) {
        placeholdersRef.current = placeholdersRef.current.slice(1);
      }
      return;
    }
    const idx = placeholdersRef.current.findIndex(p => p.parentId === parentId);
    if (idx >= 0) {
      placeholdersRef.current = [
        ...placeholdersRef.current.slice(0, idx),
        ...placeholdersRef.current.slice(idx + 1),
      ];
    }
  }, []);

  // 工具:标记新到达节点,0.6s 后清除入场动画
  const markArrived = useCallback((nodeId: string) => {
    arrivedIdsRef.current = new Set([...arrivedIdsRef.current, nodeId]);
    setTimeout(() => {
      const next = new Set(arrivedIdsRef.current);
      next.delete(nodeId);
      arrivedIdsRef.current = next;
      relayout();
    }, 650);
  }, [relayout]);

  // ── 画布实例（用于整理 fitView / 自动聚焦新节点） ──
  const reactFlow = useReactFlow();

  // 工具：平滑把镜头对准某节点，避免新节点超出视口
  const centerOnNode = useCallback((nodeId: string) => {
    // 延迟一帧，确保节点已渲染进 React Flow 内部状态
    requestAnimationFrame(() => {
      try {
        const n = reactFlow.getNode(nodeId);
        if (!n) return;
        reactFlow.setCenter(n.position.x + 130, n.position.y + 80, { zoom: 0.85, duration: 600 });
      } catch {
        // setCenter 在非常早期可能抛错，忽略
      }
    });
  }, [reactFlow]);

  // ── 探索 SSE ──
  const {
    phase: explorePhase, phaseMessage: exploreMsg, isStreaming: isExploring,
    typing: exploreTyping, start: startExplore, abort: abortExplore,
  } =
    useSseStream<EmergenceNodeType>({
      url: '',
      method: 'POST',
      phaseEvent: 'stage',
      itemEvent: 'node',
      onEvent: {
        thinking: (data) => {
          const t = (data as { text?: string })?.text;
          if (t) setExploreThinking(prev => prev + t);
        },
      },
      onItem: (newNode) => {
        backendNodesRef.current = [...backendNodesRef.current, newNode];
        consumePlaceholder(newNode.parentId ?? null);
        relayout();
        markArrived(newNode.id);
        centerOnNode(newNode.id);
        setNodeCount(c => c + 1);
      },
      onDone: (data) => {
        // 清理剩余占位
        placeholdersRef.current = [];
        relayout();
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
        placeholdersRef.current = [];
        relayout();
        toast.error('探索失败', msg);
      },
    });

  // ── 涌现 SSE ──
  const {
    phase: emergePhase, phaseMessage: emergeMsg, isStreaming: isEmerging,
    typing: emergeTyping, start: startEmerge, abort: abortEmerge,
  } =
    useSseStream<EmergenceNodeType>({
      url: '',
      method: 'POST',
      phaseEvent: 'stage',
      itemEvent: 'node',
      onEvent: {
        thinking: (data) => {
          const t = (data as { text?: string })?.text;
          if (t) setEmergeThinking(prev => prev + t);
        },
      },
      onItem: (newNode) => {
        backendNodesRef.current = [...backendNodesRef.current, newNode];
        consumePlaceholder(newNode.parentId ?? null);
        relayout();
        markArrived(newNode.id);
        centerOnNode(newNode.id);
        setNodeCount(c => c + 1);
      },
      onDone: (data) => {
        placeholdersRef.current = [];
        relayout();
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
        placeholdersRef.current = [];
        relayout();
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
    backendNodesRef.current = backendNodes;
    relayout();
  }, [treeId, relayout]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // ── 操作 ──
  const injectPlaceholders = useCallback((parentId: string, count: number, dimension: 1 | 2 | 3) => {
    const now = Date.now();
    const specs: PlaceholderNodeSpec[] = Array.from({ length: count }, (_, i) => ({
      parentId,
      id: `__ph_${parentId}_${now}_${i}`,
      index: i,
      dimension,
    }));
    placeholdersRef.current = [...placeholdersRef.current, ...specs];
    relayout();
  }, [relayout]);

  const fireExplore = useCallback((nodeId: string, userPrompt?: string) => {
    if (isExploring || isEmerging) return;
    setExploreThinking('');
    injectPlaceholders(nodeId, PLACEHOLDER_COUNT, 1);
    const body = userPrompt?.trim() ? { userPrompt: userPrompt.trim() } : undefined;
    startExplore({ url: api.emergence.nodes.explore(nodeId), body });
  }, [isExploring, isEmerging, startExplore, injectPlaceholders]);

  const handleExplore = useCallback((nodeId: string) => {
    fireExplore(nodeId);
  }, [fireExplore]);

  const handleInspire = useCallback((nodeId: string) => {
    if (isExploring || isEmerging) return;
    setInspireTargetId(nodeId);
  }, [isExploring, isEmerging]);

  const handleInspireSubmit = useCallback((prompt: string) => {
    if (!inspireTargetId) return;
    const targetId = inspireTargetId;
    setInspireTargetId(null);
    fireExplore(targetId, prompt);
  }, [inspireTargetId, fireExplore]);

  const handleStatusChange = useCallback(async (nodeId: string, newStatus: string) => {
    const { updateEmergenceNode } = await import('@/services');
    await updateEmergenceNode(nodeId, { status: newStatus });
    // 同步本地后端节点 + UI
    backendNodesRef.current = backendNodesRef.current.map(n =>
      n.id === nodeId ? { ...n, status: newStatus as EmergenceNodeType['status'] } : n,
    );
    setNodes(prev => prev.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, status: newStatus as EmergenceNodeData['status'] } } : n
    ));
  }, [setNodes]);

  // Wire up 真实 handler 到前面声明的 ref
  useEffect(() => { handleExploreRef.current = handleExplore; }, [handleExplore]);
  useEffect(() => { handleInspireRef.current = handleInspire; }, [handleInspire]);
  useEffect(() => { handleStatusChangeRef.current = handleStatusChange; }, [handleStatusChange]);

  const handleEmerge = useCallback((fantasy: boolean) => {
    if (isExploring || isEmerging) return;
    setEmergeThinking('');
    // 涌现没有单一父节点:选树上已有的一个可见节点作为占位锚点,用户视觉上知道"正在涌现"
    const anchorId = backendNodesRef.current[0]?.id;
    if (anchorId) injectPlaceholders(anchorId, PLACEHOLDER_COUNT, fantasy ? 3 : 2);
    startEmerge({ url: `${api.emergence.trees.emerge(treeId)}${fantasy ? '?fantasy=true' : ''}` });
  }, [treeId, isExploring, isEmerging, startEmerge, injectPlaceholders]);

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
  const currentTyping = isExploring ? exploreTyping : emergeTyping;
  const currentThinking = isExploring ? exploreThinking : emergeThinking;

  // 流式文字变化时,把最新值同步进 ref 并重布局,让首个占位卡片实时看到 LLM 原文
  useEffect(() => {
    liveTypingRef.current = currentTyping ?? '';
    if (isStreaming && placeholdersRef.current.length > 0) {
      relayout();
    }
  }, [currentTyping, isStreaming, relayout]);

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
            {isStreaming && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { abortExplore(); abortEmerge(); placeholdersRef.current = []; relayout(); toast.info('已停止', '可以继续探索或涌现'); }}
                title="停止当前 AI 流式生成"
              >
                <StopCircle size={13} style={{ color: 'rgba(239,68,68,0.85)' }} /> 停止
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { relayout(); setTimeout(() => reactFlow.fitView({ padding: 0.25, duration: 500 }), 30); }}
              disabled={isStreaming || nodeCount === 0}
              title="自动整理节点位置并重新居中画布"
            >
              <Wand2 size={13} /> 整理
            </Button>
            {nodeCount >= 3 && (
              <EmergenceEmergePopover disabled={isStreaming} onEmerge={handleEmerge} />
            )}
            <Button variant="secondary" size="xs" onClick={handleExport}>
              <Download size={13} /> 导出
            </Button>
          </div>
        }
      />

      {/* SSE 状态栏(流式显示 LLM 原文,消除空白等待) */}
      {isStreaming && (
        <div className="px-3 pt-2">
          <EmergenceStreamingBar
            phase={currentPhase}
            message={currentMsg}
            typing={currentTyping}
            thinking={currentThinking}
            dimension={isExploring ? 1 : 2}
            extra={`已到达 ${placeholdersRef.current.length > 0
              ? Math.max(0, PLACEHOLDER_COUNT - placeholdersRef.current.length)
              : 0} / ${PLACEHOLDER_COUNT}`}
          />
        </div>
      )}

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
          /* ── 画布手势统一(苹果触控板风格),对齐视觉创作画布 ──
             详见 .claude/rules/gesture-unification.md
             两指拖动 = 平移; 双指捏合或 ⌘/Ctrl+滚轮 = 缩放; 单指点击空白拖动 = 平移 */
          panOnScroll
          panOnScrollSpeed={0.8}
          panOnDrag
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          zoomActivationKeyCode={['Meta', 'Control']}
          panActivationKeyCode="Space"
          selectionOnDrag={false}
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

          {/* 图例：与画布主题一致的深色玻璃面板,文字 + 圆点同色,确保对比度 ≥ 4.5:1 */}
          <Panel position="bottom-left">
            <div
              className="flex items-center gap-3.5 px-3.5 py-2 rounded-[10px]"
              style={{
                background: 'rgba(15,16,20,0.85)',
                border: '1px solid rgba(255,255,255,0.1)',
                backdropFilter: 'blur(16px) saturate(140%)',
                WebkitBackdropFilter: 'blur(16px) saturate(140%)',
                boxShadow: '0 4px 12px -2px rgba(0,0,0,0.5)',
              }}
            >
              {[
                { d: 1 as const, label: '一维·系统内', solid: 'rgb(120,180,255)' },
                { d: 2 as const, label: '二维·跨系统', solid: 'rgb(200,150,255)' },
                { d: 3 as const, label: '三维·幻想', solid: 'rgb(252,211,77)' },
              ].map(item => (
                <span key={item.d} className="inline-flex items-center gap-1.5">
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: item.solid,
                      boxShadow: `0 0 6px ${item.solid}`,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    className="text-[11px] font-medium whitespace-nowrap"
                    style={{ color: item.solid }}
                  >
                    {item.label}
                  </span>
                </span>
              ))}
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
                      {['seed', 'explored', 'emerged'].map((s) => (
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

      {/* 灵感对话框 */}
      {inspireTargetId && (
        <EmergenceInspireDialog
          parentTitle={backendNodesRef.current.find(n => n.id === inspireTargetId)?.title}
          onClose={() => setInspireTargetId(null)}
          onSubmit={handleInspireSubmit}
        />
      )}
    </div>
  );
}

// ── 页面入口：介绍 → 树列表 → 画布 ──
export function EmergenceExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [trees, setTrees] = useState<Array<{ id: string; title: string; description?: string; nodeCount: number; updatedAt: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [showIntro, setShowIntro] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(INTRO_SEEN_KEY) !== '1';
  });

  const dismissIntro = useCallback(() => {
    sessionStorage.setItem(INTRO_SEEN_KEY, '1');
    setShowIntro(false);
  }, []);

  // 从文档空间跳转来的参数
  const seedTitle = searchParams.get('seedTitle');
  const seedSourceType = searchParams.get('seedSourceType');
  const seedSourceId = searchParams.get('seedSourceId');

  // 自动打开创建对话框（如果有 URL 参数）
  useEffect(() => {
    if (seedSourceId) {
      dismissIntro();
      setShowCreate(true);
    }
  }, [seedSourceId, dismissIntro]);

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

  // 介绍页(首次进入或用户主动再次查看)
  if (showIntro) {
    return (
      <>
        <EmergenceIntroPage
          hasTrees={trees.length > 0}
          onStart={dismissIntro}
          onCreateFirst={() => {
            dismissIntro();
            setShowCreate(true);
          }}
        />
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
      </>
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
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={() => setShowIntro(true)}>
              <Info size={13} /> 关于涌现
            </Button>
            <Button variant="primary" size="xs" onClick={() => setShowCreate(true)}>
              <Plus size={13} /> 新建涌现树
            </Button>
          </div>
        }
      />

      {/* 内容区域 */}
      <div className="px-5 pb-6 w-full">
        {loading ? (
          <MapSectionLoader text="加载中..." />
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
              <EmergenceTreeCard key={t.id} tree={t} onOpen={setSelectedTreeId} />
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
