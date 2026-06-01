import dagre from '@dagrejs/dagre';
import { MarkerType, type Node, type Edge } from '@xyflow/react';
import type { PmGoal, PmGoalScope } from '@/services/contracts/pmAgent';

export const TEAM_ROOT_ID = '__root_team__';
export const PERSONAL_ROOT_ID = '__root_personal__';

const NODE_W = 248;
const NODE_H = 112;
const ROOT_W = 220;
const ROOT_H = 82;

/** 画布节点数据。kind=root 为虚拟根（业务北极星 / 个人目标），kind=goal 为真实目标 */
export interface GoalNodeData {
  [key: string]: unknown;
  kind: 'root' | 'goal';
  // root 专用
  rootScope?: PmGoalScope;
  rootLabel?: string;
  rootSubtitle?: string;
  // goal 专用
  goal?: PmGoal;
  hasChildren?: boolean;
  collapsed?: boolean;
  canHaveChildren?: boolean;
  canWrite?: boolean;
  // 回调（构建时注入）
  onToggle?: (id: string) => void;
  onOpen?: (g: PmGoal) => void;
  onDecompose?: (g: PmGoal) => void;
  onAddChild?: (g: PmGoal) => void;
}

export type GoalScopeFilter = 'all' | 'team' | 'personal';

export interface BuildGoalGraphOpts {
  goals: PmGoal[];
  businessGoal: string;
  maxDepth: number;
  scopeFilter: GoalScopeFilter;
  collapsed: Set<string>;
  canManage: boolean;
  /** 当前用户能否写某目标（团队走 canManage，个人始终可写） */
  callbacks: Pick<GoalNodeData, 'onToggle' | 'onOpen' | 'onDecompose' | 'onAddChild'>;
}

/** 构建 ReactFlow 节点 + 边，并用 dagre（横向 LR）自动布局 */
export function buildGoalGraph(opts: BuildGoalGraphOpts): { nodes: Node<GoalNodeData>[]; edges: Edge[] } {
  const { goals, businessGoal, maxDepth, scopeFilter, collapsed, canManage, callbacks } = opts;

  const byId = new Map(goals.map((g) => [g.id, g]));
  const childrenByParent = new Map<string, PmGoal[]>();
  for (const g of goals) {
    if (g.parentId && byId.has(g.parentId)) {
      const arr = childrenByParent.get(g.parentId) ?? [];
      arr.push(g);
      childrenByParent.set(g.parentId, arr);
    }
  }

  // 某目标是否被折叠的祖先隐藏
  const isHidden = (g: PmGoal): boolean => {
    let cur: PmGoal | undefined = g.parentId ? byId.get(g.parentId) : undefined;
    let guard = 0;
    while (cur && guard++ < maxDepth + 1) {
      if (collapsed.has(cur.id)) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };

  const showTeam = scopeFilter === 'all' || scopeFilter === 'team';
  const showPersonal = scopeFilter === 'all' || scopeFilter === 'personal';
  const personalGoals = goals.filter((g) => g.scope === 'personal');

  const rfNodes: Node<GoalNodeData>[] = [];
  const rfEdges: Edge[] = [];

  if (showTeam) {
    rfNodes.push({
      id: TEAM_ROOT_ID, type: 'goalRoot', position: { x: 0, y: 0 },
      data: { kind: 'root', rootScope: 'team', rootLabel: '业务目标 · 北极星', rootSubtitle: businessGoal || '立项时未填写业务目标' },
    });
  }
  if (showPersonal && personalGoals.length > 0) {
    rfNodes.push({
      id: PERSONAL_ROOT_ID, type: 'goalRoot', position: { x: 0, y: 0 },
      data: { kind: 'root', rootScope: 'personal', rootLabel: '我的个人目标', rootSubtitle: '仅自己可见的个人计划' },
    });
  }

  const visible = goals.filter((g) => {
    if (g.scope === 'team' && !showTeam) return false;
    if (g.scope === 'personal' && !showPersonal) return false;
    return !isHidden(g);
  });

  for (const g of visible) {
    const kids = childrenByParent.get(g.id) ?? [];
    const depth = g.depth ?? 0;
    const canWrite = g.scope === 'personal' ? true : canManage;
    rfNodes.push({
      id: g.id, type: 'goal', position: { x: 0, y: 0 },
      data: {
        kind: 'goal', goal: g,
        hasChildren: kids.length > 0,
        collapsed: collapsed.has(g.id),
        canHaveChildren: depth + 1 < maxDepth,
        canWrite,
        ...callbacks,
      },
    });
    // 连边：有父且父可见同域 → 父；否则挂到对应根
    const parentVisible = g.parentId && byId.has(g.parentId) && !isHidden(byId.get(g.parentId)!);
    const source = parentVisible ? g.parentId! : (g.scope === 'team' ? TEAM_ROOT_ID : PERSONAL_ROOT_ID);
    // 根节点可能被过滤掉（personal 根无 personal 目标时不会发生），确保 source 存在
    if (rfNodes.some((n) => n.id === source)) {
      // 按目标 scope 着色（团队蓝 / 个人紫），用 rgba 保证深浅主题都可见；带箭头表达方向
      const edgeColor = g.scope === 'personal' ? 'rgba(168,85,247,0.75)' : 'rgba(59,130,246,0.75)';
      rfEdges.push({
        id: `${source}->${g.id}`, source, target: g.id, type: 'smoothstep',
        style: { stroke: edgeColor, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor, width: 14, height: 14 },
      });
    }
  }

  // dagre 横向布局
  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 64, marginx: 24, marginy: 24 });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of rfNodes) {
    const isRoot = n.type === 'goalRoot';
    dg.setNode(n.id, { width: isRoot ? ROOT_W : NODE_W, height: isRoot ? ROOT_H : NODE_H });
  }
  for (const e of rfEdges) dg.setEdge(e.source, e.target);
  dagre.layout(dg);
  for (const n of rfNodes) {
    const p = dg.node(n.id);
    const isRoot = n.type === 'goalRoot';
    const w = isRoot ? ROOT_W : NODE_W;
    const h = isRoot ? ROOT_H : NODE_H;
    if (p) n.position = { x: p.x - w / 2, y: p.y - h / 2 };
  }

  return { nodes: rfNodes, edges: rfEdges };
}
