import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { listWorkflows, createWorkflow, deleteWorkflow } from '@/services';
import type { Workflow, WorkflowNode, WorkflowEdge } from '@/services/contracts/workflowAgent';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { getEmojiForCapsule } from './capsuleRegistry';

// ═══════════════════════════════════════════════════════════════
// 工作流列表页 — 卡片网格 + 统计总览 + Mini DAG 预览
// ═══════════════════════════════════════════════════════════════

// ── 工具函数 ─────────────────────────────────────────────────

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim();
  if (!s) return '从未';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '从未';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/** 节点类型 → 分类色相 */
const CATEGORY_HUE: Record<string, number> = {
  'timer': 30, 'webhook-receiver': 200, 'manual-trigger': 280, 'file-upload': 170,
  'tapd-collector': 30, 'http-request': 210, 'llm-analyzer': 270,
  'script-executor': 150, 'data-extractor': 180, 'data-merger': 60,
  'report-generator': 150, 'file-exporter': 100, 'webhook-sender': 200, 'notification-sender': 340,
};

function getNodeHue(nodeType: string): number {
  return CATEGORY_HUE[nodeType] ?? 220;
}

// ── Mini DAG 预览 (纯 SVG) ────────────────────────────────────

function MiniDag({ nodes, edges }: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) {
  if (nodes.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-[10px] h-[52px] text-[11px]"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}
      >
        尚未添加节点
      </div>
    );
  }

  // 拓扑排序 → 分层
  const nodeMap = new Map(nodes.map(n => [n.nodeId, n]));
  const inDegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.nodeId, 0);
    downstream.set(n.nodeId, []);
  }
  for (const e of edges) {
    if (nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)) {
      inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
      downstream.get(e.sourceNodeId)?.push(e.targetNodeId);
    }
  }

  // BFS 分层
  const layers: string[][] = [];
  let queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const visited = new Set<string>();

  while (queue.length > 0) {
    layers.push(queue);
    const next: string[] = [];
    for (const id of queue) {
      visited.add(id);
      for (const d of downstream.get(id) ?? []) {
        if (!visited.has(d)) {
          const remaining = (inDegree.get(d) ?? 1) - 1;
          inDegree.set(d, remaining);
          if (remaining <= 0 && !next.includes(d)) next.push(d);
        }
      }
    }
    queue = next;
    if (layers.length > 20) break;
  }
  // 未被分层的孤立节点放最后
  const unvisited = nodes.filter(n => !visited.has(n.nodeId));
  if (unvisited.length > 0) layers.push(unvisited.map(n => n.nodeId));

  const R = 6;
  const gapX = 32;
  const gapY = 20;
  const padX = 16;
  const padY = 14;

  const maxPerLayer = Math.max(...layers.map(l => l.length));
  const svgW = padX * 2 + (layers.length - 1) * gapX + R * 2;
  const svgH = padY * 2 + (maxPerLayer - 1) * gapY + R * 2;

  // 计算节点位置
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) => {
    const x = padX + R + li * gapX;
    const totalH = (layer.length - 1) * gapY;
    const startY = (svgH - totalH) / 2;
    layer.forEach((id, ni) => {
      pos.set(id, { x, y: startY + ni * gapY });
    });
  });

  return (
    <div
      className="rounded-[10px] flex items-center justify-center overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <svg width="100%" height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} style={{ maxHeight: 64 }}>
        {/* 连线 */}
        {edges.map((e) => {
          const from = pos.get(e.sourceNodeId);
          const to = pos.get(e.targetNodeId);
          if (!from || !to) return null;
          return (
            <line
              key={e.edgeId}
              x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="rgba(255,255,255,0.12)" strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}
        {/* 节点 */}
        {nodes.map((n) => {
          const p = pos.get(n.nodeId);
          if (!p) return null;
          const hue = getNodeHue(n.nodeType);
          return (
            <circle
              key={n.nodeId}
              cx={p.x} cy={p.y} r={R}
              fill={`hsla(${hue}, 55%, 55%, 0.6)`}
              stroke={`hsla(${hue}, 55%, 65%, 0.3)`}
              strokeWidth={1.5}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── 节点类型芯片 ─────────────────────────────────────────────

function NodeChips({ nodes }: { nodes: WorkflowNode[] }) {
  // 去重 + 保持顺序
  const seen = new Set<string>();
  const types: { type: string; emoji: string }[] = [];
  for (const n of nodes) {
    if (!seen.has(n.nodeType)) {
      seen.add(n.nodeType);
      types.push({ type: n.nodeType, emoji: getEmojiForCapsule(n.nodeType) });
    }
  }
  if (types.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {types.map(({ type, emoji }) => (
        <span
          key={type}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
          style={{
            background: `hsla(${getNodeHue(type)}, 50%, 50%, 0.1)`,
            border: `1px solid hsla(${getNodeHue(type)}, 50%, 50%, 0.18)`,
            color: `hsla(${getNodeHue(type)}, 55%, 70%, 0.9)`,
          }}
        >
          <span>{emoji}</span>
          <span>{type.split('-').map(w => w[0]?.toUpperCase()).join('')}</span>
        </span>
      ))}
    </div>
  );
}

// ── 统计卡片 ─────────────────────────────────────────────────

function StatCard({ emoji, label, value, sub }: {
  emoji: string; label: string; value: string | number; sub?: string;
}) {
  return (
    <div
      className="flex-1 min-w-[120px] rounded-[12px] px-4 py-3"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[14px]">{emoji}</span>
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div className="text-[20px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</div>
      )}
    </div>
  );
}

// ── 工作流卡片 ───────────────────────────────────────────────

function WorkflowCard({ workflow, onEdit, onCanvas, onDelete }: {
  workflow: Workflow;
  onEdit: () => void;
  onCanvas: () => void;
  onDelete: () => void;
}) {
  return (
    <GlassCard
      interactive
      padding="none"
      onClick={onEdit}
      className="group"
      style={{ overflow: 'hidden' }}
    >
      <div className="p-4 pb-3">
        {/* 头部：emoji + 名称 + 状态 */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0 text-[18px]"
              style={{
                background: 'rgba(214,178,106,0.08)',
                border: '1px solid rgba(214,178,106,0.12)',
              }}
            >
              {workflow.icon || '⚡'}
            </div>
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {workflow.name || '未命名工作流'}
              </h3>
              {workflow.description ? (
                <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {workflow.description}
                </p>
              ) : (
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {workflow.nodes.length} 个节点 · {workflow.edges.length} 条连线
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {workflow.tags.map((tag) => (
              <Badge key={tag} variant="subtle" size="sm">{tag}</Badge>
            ))}
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                background: workflow.isEnabled ? 'rgba(34,197,94,0.7)' : 'rgba(255,255,255,0.15)',
                boxShadow: workflow.isEnabled ? '0 0 6px rgba(34,197,94,0.4)' : 'none',
              }}
              title={workflow.isEnabled ? '已启用' : '已禁用'}
            />
          </div>
        </div>

        {/* Mini DAG 预览 */}
        <MiniDag nodes={workflow.nodes} edges={workflow.edges} />

        {/* 节点类型芯片 */}
        <div className="mt-2.5">
          <NodeChips nodes={workflow.nodes} />
        </div>

        {/* 统计行 */}
        <div className="flex items-center justify-between mt-3 pt-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>
              <span style={{ color: 'var(--text-secondary)' }}>{workflow.executionCount}</span> 次执行
            </span>
            {workflow.lastExecutedAt && (
              <span>
                <span className="opacity-40">·</span> {timeAgo(workflow.lastExecutedAt)}
              </span>
            )}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {formatDate(workflow.createdAt)}
          </div>
        </div>
      </div>

      {/* 悬浮操作栏 */}
      <div
        className="flex items-center gap-1.5 px-4 py-2.5 transition-all duration-200"
        style={{
          background: 'rgba(255,255,255,0.03)',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          opacity: 1,
        }}
      >
        <button
          className="flex-1 h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150"
          style={{
            background: 'rgba(214,178,106,0.08)',
            border: '1px solid rgba(214,178,106,0.15)',
            color: 'rgba(214,178,106,0.85)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(214,178,106,0.15)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(214,178,106,0.08)'; }}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          ✎ 编辑
        </button>
        <button
          className="flex-1 h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150"
          style={{
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.15)',
            color: 'rgba(59,130,246,0.85)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.15)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.08)'; }}
          onClick={(e) => { e.stopPropagation(); onCanvas(); }}
        >
          ◇ 画布
        </button>
        <button
          className="w-7 h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150 flex items-center justify-center flex-shrink-0"
          style={{
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.12)',
            color: 'rgba(239,68,68,0.65)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.14)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.06)'; }}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >
          ✕
        </button>
      </div>
    </GlassCard>
  );
}

// ── 空状态 ─────────────────────────────────────────────────

function EmptyState({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <GlassCard>
      <div className="flex flex-col items-center py-12 gap-5">
        <div
          className="w-20 h-20 rounded-[20px] flex items-center justify-center text-[36px]"
          style={{
            background: 'linear-gradient(135deg, rgba(214,178,106,0.1) 0%, rgba(59,130,246,0.08) 100%)',
            border: '1px solid rgba(214,178,106,0.12)',
          }}
        >
          ⚡
        </div>
        <div className="text-center">
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            开始自动化
          </h3>
          <p className="text-[12px] mt-1.5 max-w-[280px]" style={{ color: 'var(--text-muted)' }}>
            创建工作流，用可视化的方式编排数据采集、分析和输出
          </p>
        </div>

        {/* 示意 DAG */}
        <div className="flex items-center gap-2 my-1">
          {['🐛', '→', '🧠', '→', '📝'].map((item, i) => (
            <span
              key={i}
              className={item === '→'
                ? 'text-[12px] opacity-30'
                : 'w-9 h-9 rounded-[10px] flex items-center justify-center text-[16px]'
              }
              style={item !== '→' ? {
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              } : undefined}
            >
              {item}
            </span>
          ))}
        </div>

        <Button variant="primary" size="sm" onClick={onCreate} disabled={creating}>
          {creating ? '⏳' : '＋'} 新建工作流
        </Button>
      </div>
    </GlassCard>
  );
}

// ── 主页面 ─────────────────────────────────────────────────

export function WorkflowListPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    reload();
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const res = await listWorkflows({ pageSize: 100 });
      if (res.success && res.data) {
        setWorkflows(res.data.items);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await createWorkflow({
        name: '新建工作流',
        description: '',
        icon: '⚡',
        tags: [],
      });
      if (res.success && res.data) {
        navigate(`/workflow-agent/${res.data.workflow.id}`);
      }
    } catch { /* ignore */ }
    setCreating(false);
  }

  async function handleDelete(wf: Workflow) {
    if (!confirm(`确定删除「${wf.name || '未命名'}」？`)) return;
    try {
      const res = await deleteWorkflow(wf.id);
      if (res.success) {
        setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
      }
    } catch { /* ignore */ }
  }

  // 统计
  const stats = useMemo(() => {
    const total = workflows.length;
    const totalExec = workflows.reduce((s, w) => s + w.executionCount, 0);
    const withNodes = workflows.filter(w => w.nodes.length > 0).length;
    const lastActive = workflows
      .filter(w => w.lastExecutedAt)
      .sort((a, b) => new Date(b.lastExecutedAt!).getTime() - new Date(a.lastExecutedAt!).getTime())[0];
    return { total, totalExec, withNodes, lastActive: lastActive?.lastExecutedAt };
  }, [workflows]);

  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      <TabBar
        title="TAPD 数据自动化"
        icon={<span className="text-[14px]">⚡</span>}
        actions={
          <Button
            variant="primary"
            size="xs"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? '⏳' : '＋'} 新建工作流
          </Button>
        }
      />

      <div className="px-5 pb-6 space-y-4 w-full max-w-5xl mx-auto">

        {/* 加载态 */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <span className="text-[16px] animate-spin inline-block">⏳</span>
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</span>
          </div>
        )}

        {/* 空状态 */}
        {!loading && workflows.length === 0 && (
          <EmptyState onCreate={handleCreate} creating={creating} />
        )}

        {/* 有数据 */}
        {!loading && workflows.length > 0 && (
          <>
            {/* 统计总览 */}
            <div className="flex gap-3 flex-wrap">
              <StatCard emoji="📊" label="工作流" value={stats.total} sub={`${stats.withNodes} 个已配置节点`} />
              <StatCard emoji="🔄" label="总执行" value={stats.totalExec} />
              <StatCard
                emoji="🔥"
                label="最近活跃"
                value={stats.lastActive ? timeAgo(stats.lastActive) : '–'}
                sub={stats.lastActive ? formatDate(stats.lastActive) : undefined}
              />
            </div>

            {/* 卡片网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {workflows.map((wf) => (
                <WorkflowCard
                  key={wf.id}
                  workflow={wf}
                  onEdit={() => navigate(`/workflow-agent/${wf.id}`)}
                  onCanvas={() => navigate(`/workflow-agent/${wf.id}/canvas`)}
                  onDelete={() => handleDelete(wf)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
