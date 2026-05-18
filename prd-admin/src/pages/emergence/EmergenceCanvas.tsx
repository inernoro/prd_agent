import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  MiniMap,
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
import { useSseStream, connectSse, type SsePhase } from '@/lib/useSseStream';
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
// 一次探索/涌现预期的子节点数（仅用于预留 band 居中，多/少都不影响已落位节点）
const EXPECTED_CHILDREN = 4;
// 生成"播放"结束、临时面板消失后，等这么久再出第一个节点
const REVEAL_DELAY_MS = 1000;
// 之后每个节点渐显的间隔（一个一个长出来）
const REVEAL_INTERVAL_MS = 1000;

// ── 自定义节点注册 ──
const nodeTypes = { emergence: EmergenceFlowNode };

// ── 维度颜色（MiniMap / 边复用）──
const dimColor: Record<number, string> = {
  1: 'rgba(59,130,246,0.7)',
  2: 'rgba(147,51,234,0.7)',
  3: 'rgba(234,179,8,0.7)',
};

// 布局常量
// LEAF_WIDTH: 节点中心间距,大于卡片最大宽度(300)+ 充分 gap,避免横向贴边
// DEPTH_STEP: 父子节点的垂直间距,真实卡片含描述/标签/按钮可达 260-280px,需留呼吸空间
const LEAF_WIDTH = 360;
const DEPTH_STEP = 340;

type XY = { x: number; y: number };

/** 锚点父：parentId 优先，没有则取第一个存在的 parentIds（涌现多父节点） */
function anchorParentId(n: EmergenceNodeType, has: (id: string) => boolean): string | undefined {
  if (n.parentId && has(n.parentId)) return n.parentId;
  return n.parentIds.find(pid => has(pid));
}

/**
 * 全量布局（纯函数）—— 基于子树宽度的递归树布局，父节点居中于子节点群之上。
 * 仅在「初始加载」与「点击整理」时调用，绝不在流式过程中调用。
 */
function computeFullLayout(nodes: EmergenceNodeType[]): Map<string, XY> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const has = (id: string) => byId.has(id);

  const childrenMap = new Map<string, string[]>();
  const roots: string[] = [];
  nodes.forEach(n => {
    const p = anchorParentId(n, has);
    if (p) {
      if (!childrenMap.has(p)) childrenMap.set(p, []);
      childrenMap.get(p)!.push(n.id);
    } else {
      roots.push(n.id);
    }
  });

  const subtreeWidth = new Map<string, number>();
  const measure = (id: string, seen: Set<string>): number => {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id)!;
    if (seen.has(id)) return LEAF_WIDTH;
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
  nodes.forEach(n => measure(n.id, new Set()));

  const positions = new Map<string, XY>();
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
  // 兜底:任何未定位的节点(锚点不在当前子集的涌现节点)
  nodes.forEach(n => {
    if (!positions.has(n.id)) {
      const anchor = anchorParentId(n, has);
      const anchorPos = anchor ? positions.get(anchor) : undefined;
      positions.set(n.id, anchorPos ? { x: anchorPos.x, y: anchorPos.y + DEPTH_STEP } : { x: 0, y: 0 });
    }
  });
  return positions;
}

// ── 临时生成面板 + 子节点 band 预留 ──
interface GenSlot {
  /** 触发该面板的父节点 id（涌现场景为锚点节点） */
  parentId: string;
  /** 临时面板节点 id */
  slotId: string;
  /** 临时面板位置（父节点正下方居中，单一固定，绝不影响布局） */
  panelX: number;
  /** 该批子节点的水平起点（居中于父节点之下，逐个右移落位） */
  baseX: number;
  /** 子节点行的 y（父 y + DEPTH_STEP） */
  y: number;
  /** 已落位子节点数 */
  filled: number;
  /** 维度（决定颜色） */
  dim: 1 | 2 | 3;
  /** 是否仍在"生成播放"中：true 显示临时面板；false 面板消失，准备逐个出节点 */
  generating: boolean;
}

// ── 涌现画布 ──
interface CanvasProps { treeId: string; onBack: () => void }

function EmergenceCanvasInner({ treeId, onBack }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EmergenceNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [treeTitle, setTreeTitle] = useState('');
  const [nodeCount, setNodeCount] = useState(0);

  // 后端节点（只增不删，除非显式删除）
  const backendNodesRef = useRef<EmergenceNodeType[]>([]);
  // 位置权威：所有节点位置的唯一来源。流式期间只为「新到达节点」写入，绝不动既有节点
  const positionsRef = useRef<Map<string, XY>>(new Map());
  // 活跃临时面板（按 parentId 索引，并行探索可有多个）
  const slotsRef = useRef<Map<string, GenSlot>>(new Map());
  // 每个 parentId 的临时面板实时 LLM 文本（固定尺寸，绝不影响布局）
  const liveTextRef = useRef<Map<string, string>>(new Map());
  // 生成期间，每个父节点的到达子节点先缓冲，等"播放"结束再逐个渐显
  const pendingByParentRef = useRef<Map<string, EmergenceNodeType[]>>(new Map());
  // 每个父节点的逐个渐显定时器
  const revealTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // SSE 已结束但缓冲节点尚未逐个渐显完毕的父节点：此期间该父仍视为"流式中"，
  // 阻止对同父的重复探索 / 涌现 / 整理交错，避免乱序落位
  const revealingRef = useRef<Set<string>>(new Set());
  // 刚到达节点的入场动画标记
  const arrivedIdsRef = useRef<Set<string>>(new Set());
  // 灵感对话框
  const [inspireTargetId, setInspireTargetId] = useState<string | null>(null);
  // 提前声明 handler 引用，供 buildFlow 使用
  const handleExploreRef = useRef<(nodeId: string) => void>(() => {});
  const handleInspireRef = useRef<(nodeId: string) => void>(() => {});
  const handleStatusChangeRef = useRef<(nodeId: string, status: string) => void>(() => {});
  // 涌现锚点（涌现无单一父节点，落位挂到这个可见节点下）
  const emergeAnchorRef = useRef<string | null>(null);
  const [, setEmergeThinking] = useState('');
  // 「整理」过渡：给画布加 .emergence-tidying，节点平滑滑行 600ms
  const [tidying, setTidying] = useState(false);

  // ── 并行探索流管理 ──
  interface ActiveExplore {
    controller: AbortController;
    typing: string;
    phase: SsePhase;
    message: string;
    startedAt: number;
  }
  const activeExploresRef = useRef<Map<string, ActiveExplore>>(new Map());
  const [exploreTick, setExploreTick] = useState(0);
  const bumpExplore = useCallback(() => setExploreTick(t => t + 1), []);

  const reactFlow = useReactFlow();

  // 平滑把镜头对准某节点
  const centerOnNode = useCallback((nodeId: string) => {
    requestAnimationFrame(() => {
      try {
        const n = reactFlow.getNode(nodeId);
        if (!n) return;
        reactFlow.setCenter(n.position.x + 130, n.position.y + 80, { zoom: 0.85, duration: 600 });
      } catch { /* 早期可能抛错，忽略 */ }
    });
  }, [reactFlow]);

  // ── 从 positionsRef + 生成槽 构建 React Flow 节点/边（不重算布局）──
  const buildFlow = useCallback(() => {
    const all = backendNodesRef.current;
    const byId = new Map(all.map(n => [n.id, n]));
    const has = (id: string) => byId.has(id);
    const positions = positionsRef.current;
    const arrivedIds = arrivedIdsRef.current;
    // 探索进行中 + 缓冲渐显中 的父节点都保持"探索态"脉冲，直到子节点全部出完
    const activeSet = new Set([...activeExploresRef.current.keys(), ...revealingRef.current]);

    const flowNodes: Node<EmergenceNodeData>[] = all.map(n => {
      // 后端持久化坐标优先；否则用位置权威；都没有则锚点下方兜底（不污染权威）
      let pos = positions.get(n.id);
      if (!pos) {
        if (n.positionX || n.positionY) pos = { x: n.positionX, y: n.positionY };
        else {
          const anchor = anchorParentId(n, has);
          const ap = anchor ? positions.get(anchor) : undefined;
          pos = ap ? { x: ap.x, y: ap.y + DEPTH_STEP } : { x: 0, y: 0 };
        }
        positions.set(n.id, pos);
      }
      return {
        id: n.id,
        type: 'emergence',
        position: pos,
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
          onExplore: () => handleExploreRef.current(n.id),
          onInspire: () => handleInspireRef.current(n.id),
          onStatusChange: (s: string) => handleStatusChangeRef.current(n.id, s),
          isJustArrived: arrivedIds.has(n.id),
          isExploring: activeSet.has(n.id),
        } satisfies EmergenceNodeData,
      };
    });

    // 临时生成面板：仅在"播放中"显示，父节点正下方居中，单一固定
    for (const slot of slotsRef.current.values()) {
      if (!slot.generating) continue;
      flowNodes.push({
        id: slot.slotId,
        type: 'emergence',
        position: { x: slot.panelX, y: slot.y },
        draggable: false,
        selectable: false,
        data: {
          label: '',
          description: '',
          dimension: slot.dim,
          nodeType: 'capability',
          valueScore: 0,
          difficultyScore: 0,
          status: 'idea',
          groundingContent: '',
          bridgeAssumptions: [],
          missingCapabilities: [],
          tags: [],
          isPlaceholder: true,
          placeholderIndex: 0,
          liveText: liveTextRef.current.get(slot.parentId) || undefined,
        } satisfies EmergenceNodeData,
      });
    }

    const flowEdges: Edge[] = [];
    for (const n of all) {
      if (n.parentId && byId.has(n.parentId)) {
        flowEdges.push({
          id: `${n.parentId}->${n.id}`,
          source: n.parentId,
          target: n.id,
          animated: n.dimension >= 2,
          style: { stroke: dimColor[n.dimension] ?? dimColor[1], strokeWidth: 1.5 },
        });
      }
      for (const pid of n.parentIds) {
        if (pid === n.parentId || !byId.has(pid)) continue;
        flowEdges.push({
          id: `${pid}->>${n.id}`,
          source: pid,
          target: n.id,
          animated: true,
          style: { stroke: dimColor[n.dimension] ?? dimColor[2], strokeWidth: 1, opacity: 0.5 },
        });
      }
    }
    for (const slot of slotsRef.current.values()) {
      if (!slot.generating || !byId.has(slot.parentId)) continue;
      flowEdges.push({
        id: `slot:${slot.parentId}->${slot.slotId}`,
        source: slot.parentId,
        target: slot.slotId,
        animated: true,
        style: { stroke: dimColor[slot.dim] ?? dimColor[1], strokeWidth: 1, strokeDasharray: '4 4', opacity: 0.5 },
      });
    }

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [setNodes, setEdges]);

  // 只更新某个生成槽的实时文本（绝不触发布局，槽尺寸固定）
  const pokeSlotText = useCallback((parentId: string) => {
    const slot = slotsRef.current.get(parentId);
    if (!slot) return;
    const text = liveTextRef.current.get(parentId) || undefined;
    setNodes(prev => prev.map(n =>
      n.id === slot.slotId ? { ...n, data: { ...n.data, liveText: text } } : n,
    ));
  }, [setNodes]);

  // 标记新到达节点，0.65s 后清除入场动画（只刷该节点，不重排）
  const markArrived = useCallback((nodeId: string) => {
    arrivedIdsRef.current = new Set([...arrivedIdsRef.current, nodeId]);
    setTimeout(() => {
      const next = new Set(arrivedIdsRef.current);
      next.delete(nodeId);
      arrivedIdsRef.current = next;
      setNodes(prev => prev.map(n =>
        n.id === nodeId ? { ...n, data: { ...n.data, isJustArrived: false } } : n,
      ));
    }, 650);
  }, [setNodes]);

  // 为某父节点预留一条子节点 band（不读写其它节点位置）
  const reserveBand = useCallback((parentId: string, dim: 1 | 2 | 3) => {
    const positions = positionsRef.current;
    let parentPos = positions.get(parentId);
    if (!parentPos) {
      // 极端兜底：父未定位时先做一次全量布局补齐
      positionsRef.current = computeFullLayout(backendNodesRef.current);
      parentPos = positionsRef.current.get(parentId) ?? { x: 0, y: 0 };
    }
    const y = parentPos.y + DEPTH_STEP;
    // 找该父已落位的子节点（同一 y 行），新 band 接在它们右侧，避免与历史子节点重叠
    const has = (id: string) => backendNodesRef.current.some(n => n.id === id);
    let maxChildX = -Infinity;
    for (const n of backendNodesRef.current) {
      if (anchorParentId(n, has) !== parentId) continue;
      const p = positions.get(n.id);
      if (p && Math.abs(p.y - y) < DEPTH_STEP / 2) maxChildX = Math.max(maxChildX, p.x);
    }
    const baseX = maxChildX > -Infinity
      ? maxChildX + LEAF_WIDTH
      : parentPos.x - ((EXPECTED_CHILDREN - 1) / 2) * LEAF_WIDTH;
    slotsRef.current.set(parentId, {
      parentId,
      slotId: `__gen_${parentId}_${Date.now()}`,
      panelX: parentPos.x,
      baseX,
      y,
      filled: 0,
      dim,
      generating: true,
    });
  }, []);

  // 解析一个到达节点应归属哪个临时面板（父 id / 锚点）
  const resolveSlotKey = useCallback((node: EmergenceNodeType): string | null => {
    if (node.parentId && slotsRef.current.has(node.parentId)) return node.parentId;
    const has = (id: string) => backendNodesRef.current.some(n => n.id === id);
    const a = anchorParentId(node, has);
    if (a && slotsRef.current.has(a)) return a;
    return emergeAnchorRef.current && slotsRef.current.has(emergeAnchorRef.current)
      ? emergeAnchorRef.current
      : null;
  }, []);

  // 生成期间：到达节点先缓冲，不落位（临时面板继续播放）
  const enqueueArrival = useCallback((node: EmergenceNodeType) => {
    const key = resolveSlotKey(node) ?? emergeAnchorRef.current ?? '__detached__';
    const buf = pendingByParentRef.current.get(key) ?? [];
    buf.push(node);
    pendingByParentRef.current.set(key, buf);
  }, [resolveSlotKey]);

  // 收尾某父：清掉面板/缓冲/定时器
  const cleanupParent = useCallback((parentId: string) => {
    const t = revealTimersRef.current.get(parentId);
    if (t) { clearTimeout(t); revealTimersRef.current.delete(parentId); }
    slotsRef.current.delete(parentId);
    liveTextRef.current.delete(parentId);
    pendingByParentRef.current.delete(parentId);
    revealingRef.current.delete(parentId);
    bumpExplore(); // 解锁后刷新 stop 按钮 / 探索态 / 整理·涌现可用性
  }, [bumpExplore]);

  // 中止/出错兜底：把已到达（后端已持久化）但尚未渐显的缓冲节点一次性落位，
  // 而不是丢弃——否则这些节点要等整树重载才出现（Bugbot medium）
  const flushPending = useCallback((parentId: string) => {
    const buf = pendingByParentRef.current.get(parentId);
    if (!buf || buf.length === 0) { pendingByParentRef.current.delete(parentId); return; }
    const existing = new Set(backendNodesRef.current.map(n => n.id));
    const positions = positionsRef.current;
    const slot = slotsRef.current.get(parentId);
    let baseX: number, y: number, startFilled: number;
    if (slot) {
      baseX = slot.baseX; y = slot.y; startFilled = slot.filled;
    } else {
      const has = (id: string) => backendNodesRef.current.some(n => n.id === id);
      const anchorId = buf[0] ? anchorParentId(buf[0], has) : null;
      const ap = (anchorId ? positions.get(anchorId) : undefined)
        ?? positions.get(parentId) ?? { x: 0, y: 0 };
      baseX = ap.x - ((Math.max(buf.length, 1) - 1) / 2) * LEAF_WIDTH;
      y = ap.y + DEPTH_STEP;
      startFilled = 0;
    }
    const added: EmergenceNodeType[] = [];
    for (const node of buf) {
      if (existing.has(node.id)) continue;
      existing.add(node.id); // 同一 flush 批内的重复 node 事件也要去重
      positions.set(node.id, { x: baseX + (startFilled + added.length) * LEAF_WIDTH, y });
      added.push(node);
    }
    if (added.length > 0) {
      backendNodesRef.current = [...backendNodesRef.current, ...added];
      if (slot) slot.filled = startFilled + added.length;
      setNodeCount(c => c + added.length);
    }
    pendingByParentRef.current.delete(parentId);
  }, []);

  // 逐个渐显：从缓冲弹一个 → 落到预留 band → 1s 后再下一个
  const revealNext = useCallback((parentId: string) => {
    revealTimersRef.current.delete(parentId);
    const slot = slotsRef.current.get(parentId);
    const buf = pendingByParentRef.current.get(parentId) ?? [];
    // 与 flushPending 去重逻辑保持一致：跳过已落位的重复节点（SSE 偶发重发 /
    // 与 flushPending 抢同一缓冲），避免重复 React Flow 节点 + nodeCount 多计
    const existing = new Set(backendNodesRef.current.map(n => n.id));
    let node = buf.shift();
    while (node && existing.has(node.id)) node = buf.shift();
    if (!node || !slot) {
      cleanupParent(parentId);
      buildFlow();
      return;
    }
    backendNodesRef.current = [...backendNodesRef.current, node];
    positionsRef.current.set(node.id, { x: slot.baseX + slot.filled * LEAF_WIDTH, y: slot.y });
    slot.filled += 1;
    markArrived(node.id);
    setNodeCount(c => c + 1);
    buildFlow();
    if (slot.filled === 1) centerOnNode(node.id);

    if (buf.length > 0) {
      const t = setTimeout(() => revealNext(parentId), REVEAL_INTERVAL_MS);
      revealTimersRef.current.set(parentId, t);
    } else {
      cleanupParent(parentId);
    }
  }, [markArrived, buildFlow, centerOnNode, cleanupParent]);

  // 生成"播放"结束：临时面板消失 → 等 1s → 开始逐个出节点
  const finishGeneration = useCallback((parentId: string) => {
    const slot = slotsRef.current.get(parentId);
    if (!slot) return;
    slot.generating = false;            // 临时面板立即消失
    liveTextRef.current.delete(parentId);
    // 渐显未完成前父节点保持锁定（阻止同父重复探索 / 涌现 / 整理交错）
    revealingRef.current.add(parentId);
    bumpExplore();
    buildFlow();
    const t = setTimeout(() => revealNext(parentId), REVEAL_DELAY_MS);
    revealTimersRef.current.set(parentId, t);
  }, [buildFlow, revealNext, bumpExplore]);

  // ── 涌现 SSE ──
  const {
    isStreaming: isEmerging,
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
        enqueueArrival(newNode);
      },
      onDone: (data) => {
        const pid = emergeAnchorRef.current;
        emergeAnchorRef.current = null; // 防止陈旧锚点把后续探索的节点误导到无槽 key
        if (pid) finishGeneration(pid);
        const d = data as { totalNew?: number; error?: string };
        if (d.error) toast.error('涌现失败', d.error);
        else if (!d.totalNew) toast.warning('涌现未生成节点', '已有节点可能不足以组合，请先探索更多节点。');
        else toast.success('涌现完成', `新增 ${d.totalNew} 个组合节点`);
      },
      onError: (msg) => {
        const pid = emergeAnchorRef.current;
        emergeAnchorRef.current = null; // 防止陈旧锚点把后续探索的节点误导到无槽 key
        // 已到达的持久化节点先落位再收尾，避免丢节点（Bugbot medium）
        if (pid) { flushPending(pid); cleanupParent(pid); buildFlow(); }
        toast.error('涌现失败', msg);
      },
    });

  // 涌现实时文本 → 喂锚点生成槽（不重排）
  useEffect(() => {
    const pid = emergeAnchorRef.current;
    if (pid && isEmerging) {
      liveTextRef.current.set(pid, emergeTyping ?? '');
      pokeSlotText(pid);
    }
  }, [emergeTyping, isEmerging, pokeSlotText]);

  // ── 加载树 ──
  const loadTree = useCallback(async () => {
    const res = await getEmergenceTree(treeId);
    if (!res.success) return;
    const { tree, nodes: backendNodes } = res.data;
    setTreeTitle(tree.title);
    setNodeCount(tree.nodeCount);
    backendNodesRef.current = backendNodes;
    positionsRef.current = computeFullLayout(backendNodes);
    buildFlow();
  }, [treeId, buildFlow]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // 卸载清理所有逐个渐显定时器
  useEffect(() => {
    const timers = revealTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  // ── 探索 ──
  const fireExplore = useCallback(async (nodeId: string, userPrompt?: string) => {
    if (isEmerging) return;
    if (activeExploresRef.current.has(nodeId)) return;
    if (revealingRef.current.has(nodeId)) return; // 该父渐显未完成，禁止重复探索导致交错

    const controller = new AbortController();
    const state: ActiveExplore = {
      controller,
      typing: '',
      phase: 'connecting',
      message: '连接中…',
      startedAt: Date.now(),
    };
    activeExploresRef.current.set(nodeId, state);
    bumpExplore();

    reserveBand(nodeId, 1);
    buildFlow();
    const gen = slotsRef.current.get(nodeId);
    if (gen) centerOnNode(gen.slotId);

    const body = userPrompt?.trim() ? { userPrompt: userPrompt.trim() } : undefined;

    try {
      await connectSse({
        url: api.emergence.nodes.explore(nodeId),
        method: 'POST',
        body,
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data);
            if (evt.event === 'stage') {
              state.phase = 'streaming';
              state.message = (data as { message?: string }).message || '';
              bumpExplore();
            } else if (evt.event === 'typing') {
              const t = (data as { text?: string; content?: string }).text || (data as { content?: string }).content || '';
              state.typing += t;
              liveTextRef.current.set(nodeId, state.typing);
              pokeSlotText(nodeId);
            } else if (evt.event === 'node') {
              enqueueArrival(data as EmergenceNodeType);
            } else if (evt.event === 'done') {
              state.phase = 'done';
              const d = data as { totalNew?: number; error?: string };
              if (d.error) toast.error('探索失败', d.error);
              else if (!d.totalNew) toast.warning('探索未生成节点', '可能是种子内容过短，请尝试提供更详细的描述。');
              else toast.success('探索完成', `新增 ${d.totalNew} 个节点`);
            } else if (evt.event === 'error') {
              state.phase = 'error';
              toast.error('探索失败', (data as { message?: string }).message || '出错');
            }
          } catch { /* ignore JSON parse */ }
        },
      });
    } finally {
      activeExploresRef.current.delete(nodeId);
      bumpExplore();
      // 生成"播放"结束：临时面板消失 → 等 1s → 逐个出节点
      // （若用户手动停止，slot 已被 stopAll 清掉，这里安全 no-op）
      finishGeneration(nodeId);
    }
  }, [isEmerging, bumpExplore, reserveBand, buildFlow, pokeSlotText, enqueueArrival, finishGeneration, centerOnNode]);

  // 中止所有活跃流
  const stopAll = useCallback(() => {
    for (const s of activeExploresRef.current.values()) s.controller.abort();
    activeExploresRef.current.clear();
    abortEmerge();
    for (const t of revealTimersRef.current.values()) clearTimeout(t);
    revealTimersRef.current.clear();
    // 丢弃前先把已到达的持久化节点落位（Bugbot medium）：停止 ≠ 删除已生成的节点
    for (const key of [...pendingByParentRef.current.keys()]) flushPending(key);
    pendingByParentRef.current.clear();
    revealingRef.current.clear();
    slotsRef.current.clear();
    liveTextRef.current.clear();
    emergeAnchorRef.current = null;
    bumpExplore();
    buildFlow();
  }, [abortEmerge, bumpExplore, buildFlow, flushPending]);

  const handleExplore = useCallback((nodeId: string) => { fireExplore(nodeId); }, [fireExplore]);

  const handleInspire = useCallback((nodeId: string) => {
    if (isEmerging) return;
    if (activeExploresRef.current.has(nodeId)) return;
    if (revealingRef.current.has(nodeId)) return;
    setInspireTargetId(nodeId);
  }, [isEmerging]);

  const handleInspireSubmit = useCallback((prompt: string) => {
    if (!inspireTargetId) return;
    const targetId = inspireTargetId;
    setInspireTargetId(null);
    fireExplore(targetId, prompt);
  }, [inspireTargetId, fireExplore]);

  const handleStatusChange = useCallback(async (nodeId: string, newStatus: string) => {
    const { updateEmergenceNode } = await import('@/services');
    await updateEmergenceNode(nodeId, { status: newStatus });
    backendNodesRef.current = backendNodesRef.current.map(n =>
      n.id === nodeId ? { ...n, status: newStatus as EmergenceNodeType['status'] } : n,
    );
    setNodes(prev => prev.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, status: newStatus as EmergenceNodeData['status'] } } : n
    ));
  }, [setNodes]);

  useEffect(() => { handleExploreRef.current = handleExplore; }, [handleExplore]);
  useEffect(() => { handleInspireRef.current = handleInspire; }, [handleInspire]);
  useEffect(() => { handleStatusChangeRef.current = handleStatusChange; }, [handleStatusChange]);

  const handleEmerge = useCallback((fantasy: boolean) => {
    if (activeExploresRef.current.size > 0 || isEmerging || revealingRef.current.size > 0) return;
    setEmergeThinking('');
    const anchorId = backendNodesRef.current[0]?.id ?? null;
    emergeAnchorRef.current = anchorId;
    if (anchorId) {
      reserveBand(anchorId, fantasy ? 3 : 2);
      buildFlow();
      const gen = slotsRef.current.get(anchorId);
      if (gen) centerOnNode(gen.slotId);
    }
    startEmerge({ url: `${api.emergence.trees.emerge(treeId)}${fantasy ? '?fantasy=true' : ''}` });
  }, [treeId, isEmerging, startEmerge, reserveBand, buildFlow, centerOnNode]);

  // 手动整理：唯一会移动既有节点的入口，平滑滑行
  const handleTidy = useCallback(() => {
    // 流式 / 渐显进行中禁止整理：整理会全量重排，与渐显落位冲突
    if (activeExploresRef.current.size > 0 || isEmerging || revealingRef.current.size > 0) return;
    positionsRef.current = computeFullLayout(backendNodesRef.current);
    setTidying(true);
    buildFlow();
    setTimeout(() => reactFlow.fitView({ padding: 0.25, duration: 500 }), 30);
    setTimeout(() => setTidying(false), 700);
  }, [buildFlow, reactFlow, isEmerging]);

  // 拖动后把位置写回权威，避免下次 buildFlow 弹回
  const handleNodeDragStop = useCallback((_e: unknown, node: Node) => {
    positionsRef.current.set(node.id, { x: node.position.x, y: node.position.y });
  }, []);

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
  const [guideStep, setGuideStep] = useState<'seed' | 'explored' | 'emerged'>('seed');
  const [guideDismissed, setGuideDismissed] = useState(false);

  useEffect(() => {
    if (guideDismissed) return;
    if (nodeCount <= 1) setGuideStep('seed');
    else if (nodeCount < 5) setGuideStep('explored');
    else setGuideStep('emerged');
  }, [nodeCount, guideDismissed]);

  void exploreTick; // 订阅 tick，stop 按钮 / 探索态随之刷新
  const exploreCount = activeExploresRef.current.size;
  const isExploring = exploreCount > 0;
  // 渐显未完成也算"流式中"：停止按钮保持、涌现/整理保持禁用，直到子节点全部出完
  const isStreaming = isExploring || isEmerging || revealingRef.current.size > 0;

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
                onClick={() => {
                  stopAll();
                  toast.info('已停止', '可以继续探索或涌现');
                }}
                title={isExploring && exploreCount > 1 ? `停止全部 ${exploreCount} 条探索` : '停止当前 AI 流式生成'}
              >
                <StopCircle size={13} style={{ color: 'rgba(239,68,68,0.85)' }} />
                {isExploring && exploreCount > 1 ? `停止 ${exploreCount} 条` : '停止'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={handleTidy}
              disabled={isStreaming || nodeCount === 0}
              title="重新排布整棵树并居中（生成期间不会自动重排，需要时手动整理）"
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

      {/* React Flow 画布（流式反馈下沉到父节点下的生成槽，不再有顶部横幅） */}
      <div className={`flex-1 min-h-0 ${tidying ? 'emergence-tidying' : ''}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={handleNodeDragStop}
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

          {/* 图例 */}
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

  const seedTitle = searchParams.get('seedTitle');
  const seedSourceType = searchParams.get('seedSourceType');
  const seedSourceId = searchParams.get('seedSourceId');

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

  // 介绍页
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
