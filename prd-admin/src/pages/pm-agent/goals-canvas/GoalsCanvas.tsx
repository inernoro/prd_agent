import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  useNodesState, useEdgesState, useReactFlow, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Sparkles, Plus, Lock, Users, Maximize2, Minimize2, Target } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { PmGoal, PmGoalScope } from '@/services/contracts/pmAgent';
import { GOAL_MAX_DEPTH } from '../pmConstants';
import { GoalDecomposePanel } from '../GoalDecomposePanel';
import { GoalFlowNode, GoalRootNode } from './GoalFlowNode';
import { GoalDetailDrawer, type DrawerCreateCtx } from './GoalDetailDrawer';
import { buildGoalGraph, type GoalNodeData, type GoalScopeFilter } from './goalCanvasLayout';

const nodeTypes = { goal: GoalFlowNode, goalRoot: GoalRootNode };

interface Props {
  projectId: string;
  businessGoal: string;
  canManage: boolean;
  goals: PmGoal[];
  onReload: () => void;
  onNavigateTask?: (taskId: string) => void;
  onNavigateWeekly?: (reportId: string) => void;
}

const FILTER_CHIPS: { key: GoalScopeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'team', label: '团队' },
  { key: 'personal', label: '个人' },
];

function GoalsCanvasInner({ projectId, businessGoal, canManage, goals, onReload, onNavigateTask, onNavigateWeekly }: Props) {
  const reactFlow = useReactFlow();
  const [scopeFilter, setScopeFilter] = useState<GoalScopeFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<PmGoal | null>(null);
  const [createCtx, setCreateCtx] = useState<DrawerCreateCtx | null>(null);
  const [aiTarget, setAiTarget] = useState<{ parentGoalId?: string; parentTitle?: string; scope: PmGoalScope } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<GoalNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const fitKeyRef = useRef('');

  const goalById = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  // selected/createCtx 指向的目标可能在 reload 后变化，保持引用新鲜
  const selectedFresh = selected ? goalById.get(selected.id) ?? null : null;

  const onToggle = useCallback((id: string) => {
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const onOpen = useCallback((g: PmGoal) => { setCreateCtx(null); setSelected(g); }, []);
  const onDecompose = useCallback((g: PmGoal) => { setSelected(null); setCreateCtx(null); setAiTarget({ parentGoalId: g.id, parentTitle: g.title, scope: g.scope }); }, []);
  const onAddChild = useCallback((g: PmGoal) => { setSelected(null); setCreateCtx({ scope: g.scope, parentId: g.id, parentTitle: g.title }); }, []);

  const callbacks = useMemo(() => ({ onToggle, onOpen, onDecompose, onAddChild }), [onToggle, onOpen, onDecompose, onAddChild]);

  const graph = useMemo(
    () => buildGoalGraph({ goals, businessGoal, maxDepth: GOAL_MAX_DEPTH, scopeFilter, collapsed, canManage, callbacks }),
    [goals, businessGoal, scopeFilter, collapsed, canManage, callbacks],
  );

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    // 仅在初次加载 / 过滤切换时自动 fitView，避免每次编辑都重置缩放
    const key = `${scopeFilter}:${goals.length > 0}`;
    if (fitKeyRef.current !== key) {
      fitKeyRef.current = key;
      setTimeout(() => reactFlow.fitView({ padding: 0.2, duration: 400, maxZoom: 1 }), 30);
    }
  }, [graph, setNodes, setEdges, reactFlow, scopeFilter, goals.length]);

  const allParentIds = useMemo(() => goals.filter((g) => goals.some((c) => c.parentId === g.id)).map((g) => g.id), [goals]);
  const allCollapsed = allParentIds.length > 0 && allParentIds.every((id) => collapsed.has(id));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(allParentIds));

  const afterMutation = () => { setSelected(null); setCreateCtx(null); setAiTarget(null); onReload(); };

  const selectedDepth = selectedFresh?.depth ?? 0;

  return (
    <div className="flex-1 min-h-0 relative">
      {goals.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-center pointer-events-auto">
            <Target size={32} style={{ color: 'var(--text-muted)' }} />
            <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>还没有目标。围绕业务目标种下第一个，或让 AI 一键拆解</div>
            {canManage && (
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => setAiTarget({ scope: 'team' })}><Sparkles size={13} />AI 拆目标</Button>
                <Button variant="ghost" size="sm" onClick={() => setCreateCtx({ scope: 'team' })}><Plus size={13} />新增目标</Button>
              </div>
            )}
          </div>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        /* 手势统一（.claude/rules/gesture-unification.md 标准 B） */
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
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(128,128,128,0.18)" />
        <MiniMap
          style={{ background: 'var(--bg-elevated)', borderRadius: 10, border: '1px solid var(--border-subtle)' }}
          maskColor="rgba(0,0,0,0.35)"
          nodeColor={(n) => {
            const d = n.data as GoalNodeData;
            if (d?.kind === 'root') return d.rootScope === 'personal' ? '#A855F7' : '#F59E0B';
            return d?.goal?.scope === 'personal' ? '#A855F7' : '#3B82F6';
          }}
          pannable zoomable={false}
        />

        <Panel position="top-left">
          <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
            {FILTER_CHIPS.map((c) => (
              <button key={c.key} onClick={() => setScopeFilter(c.key)}
                className="px-2.5 py-1 rounded text-[11.5px] flex items-center gap-1"
                style={{ background: scopeFilter === c.key ? 'var(--bg-card)' : 'transparent', color: scopeFilter === c.key ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {c.key === 'team' && <Users size={11} />}{c.key === 'personal' && <Lock size={11} />}{c.label}
              </button>
            ))}
          </div>
        </Panel>

        <Panel position="top-right">
          <div className="flex items-center gap-1.5">
            {canManage && <Button variant="ghost" size="sm" onClick={() => setAiTarget({ scope: 'team' })}><Sparkles size={13} />AI 拆目标</Button>}
            {canManage && <Button variant="ghost" size="sm" onClick={() => setCreateCtx({ scope: 'team' })}><Plus size={13} />团队目标</Button>}
            <Button variant="ghost" size="sm" onClick={() => setCreateCtx({ scope: 'personal' })}><Plus size={13} />个人目标</Button>
            {allParentIds.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleAll}>{allCollapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}{allCollapsed ? '全部展开' : '全部折叠'}</Button>
            )}
          </div>
        </Panel>
      </ReactFlow>

      {(selectedFresh || createCtx) && (
        <GoalDetailDrawer
          projectId={projectId}
          goal={selectedFresh}
          createCtx={createCtx}
          canWrite={selectedFresh ? (selectedFresh.scope === 'personal' ? true : canManage) : true}
          canHaveChildren={selectedDepth + 1 < GOAL_MAX_DEPTH}
          onClose={() => { setSelected(null); setCreateCtx(null); }}
          onSaved={afterMutation}
          onDecompose={onDecompose}
          onAddChild={onAddChild}
          onNavigateTask={onNavigateTask}
          onNavigateWeekly={onNavigateWeekly}
        />
      )}

      {aiTarget && (
        <GoalDecomposePanel
          projectId={projectId} businessGoal={businessGoal}
          parentGoalId={aiTarget.parentGoalId} parentTitle={aiTarget.parentTitle} scope={aiTarget.scope}
          onClose={() => setAiTarget(null)} onCreated={afterMutation} />
      )}
    </div>
  );
}

export function GoalsCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <GoalsCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
