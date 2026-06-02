/**
 * 产品管理智能体 — 知识图谱画布（P2）。
 *
 * 节点=产品/版本/需求/功能/客户/追溯缺陷，边=包含/关联/落需求/连客户/追溯。
 * 复用 @xyflow/react，手势统一见 .claude/rules/gesture-unification.md（标准 B）：
 * 两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、禁用双击缩放。
 * 布局：按对象类型分列（左→右：客户/需求/版本/产品/功能/缺陷），同列纵向堆叠。
 */
import { useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getProductGraph, type GraphNode } from '@/services/real/productAgent';

const TYPE_META: Record<GraphNode['type'], { color: string; col: number; label: string }> = {
  customer: { color: '#4ADE80', col: 0, label: '客户' },
  requirement: { color: '#FBBF24', col: 1, label: '需求' },
  version: { color: '#60A5FA', col: 2, label: '版本' },
  product: { color: '#22D3EE', col: 3, label: '产品' },
  feature: { color: '#A78BFA', col: 4, label: '功能' },
  defect: { color: '#F87171', col: 5, label: '缺陷' },
};

const COL_GAP = 260;
const ROW_GAP = 76;

function ProductGraphInner({ productId }: { productId: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const res = await getProductGraph(productId);
      if (!alive) return;
      if (res.success) {
        const colCounters: Record<number, number> = {};
        const rfNodes: Node[] = res.data.nodes.map((n) => {
          const meta = TYPE_META[n.type];
          const col = meta.col;
          const row = colCounters[col] ?? 0;
          colCounters[col] = row + 1;
          return {
            id: n.id,
            position: { x: col * COL_GAP, y: row * ROW_GAP },
            data: { label: `${n.label}${n.sub ? `\n${n.sub}` : ''}` },
            style: {
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${meta.color}`,
              borderLeft: `4px solid ${meta.color}`,
              borderRadius: 10,
              color: '#e8e8ec',
              fontSize: 11,
              width: 200,
              whiteSpace: 'pre-line',
              padding: '6px 10px',
            },
          };
        });
        const rfEdges: Edge[] = res.data.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          style: { stroke: 'rgba(255,255,255,0.18)' },
          animated: e.type === 'traces',
        }));
        setNodes(rfNodes);
        setEdges(rfEdges);
      } else {
        setError(res.error?.message ?? '加载图谱失败');
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [productId]);

  if (loading) return <MapSectionLoader text="正在生成知识图谱…" />;
  if (error) return <div className="text-sm text-red-300/80 text-center py-10">{error}</div>;
  if (nodes.length <= 1) {
    return (
      <div className="text-center text-white/40 text-sm py-16 px-6">
        图谱还很空。先在 版本/需求/功能/客户 tab 创建对象并互相关联，关系会自动显示在这里。
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        /* 画布手势统一，详见 .claude/rules/gesture-unification.md */
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
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.04)" />
        <MiniMap
          style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
          maskColor="rgba(0,0,0,0.6)"
          pannable
          zoomable={false}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
      {/* 图例 */}
      <div className="absolute top-3 left-3 flex flex-wrap gap-2 bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5">
        {Object.entries(TYPE_META).map(([k, m]) => (
          <span key={k} className="flex items-center gap-1 text-[10px] text-white/60">
            <span className="w-2 h-2 rounded-sm" style={{ background: m.color }} />
            {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProductGraphCanvas({ productId }: { productId: string }) {
  // ReactFlow 需要 Provider 包裹
  return (
    <ReactFlowProvider>
      <ProductGraphInner productId={productId} />
    </ReactFlowProvider>
  );
}
