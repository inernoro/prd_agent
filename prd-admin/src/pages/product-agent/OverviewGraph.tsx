/**
 * 产品管理智能体 — 跨产品总览图（公司级发布地图：产品为中心，连到各自版本）。
 * 产品节点可点击进入该产品。手势统一见 .claude/rules/gesture-unification.md。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { getOverviewGraph } from '@/services/real/productAgent';

function idType(id: string) {
  return id.split(':', 1)[0];
}

function OverviewGraphInner() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getOverviewGraph();
      if (!alive) return;
      if (res.success) {
        // 列布局：产品一列，其版本在右侧
        const products = res.data.nodes.filter((n) => n.type === 'product');
        const versions = res.data.nodes.filter((n) => n.type === 'version');
        const prodIndex = new Map(products.map((p, i) => [p.id, i]));
        const verCounter = new Map<string, number>();
        const rfNodes: Node[] = [];
        products.forEach((p, i) => {
          rfNodes.push({
            id: p.id,
            position: { x: 0, y: i * 120 },
            data: { label: `${p.label}\n${p.sub ?? ''}` },
            style: nodeStyle('#22D3EE', 210),
          });
        });
        // 版本按其父产品的 y 附近排布
        const parentOf = new Map<string, string>();
        res.data.edges.forEach((e) => parentOf.set(e.target, e.source));
        versions.forEach((v) => {
          const pid = parentOf.get(v.id);
          const baseRow = pid ? prodIndex.get(pid) ?? 0 : 0;
          const k = pid ?? 'none';
          const off = verCounter.get(k) ?? 0;
          verCounter.set(k, off + 1);
          rfNodes.push({
            id: v.id,
            position: { x: 320, y: baseRow * 120 + off * 46 },
            data: { label: `${v.label}\n${v.sub ?? ''}` },
            style: nodeStyle('#60A5FA', 170),
          });
        });
        const rfEdges: Edge[] = res.data.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, style: { stroke: 'rgba(255,255,255,0.16)' } }));
        setNodes(rfNodes);
        setEdges(rfEdges);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <MapSectionLoader text="正在生成总览图…" />;
  if (nodes.length === 0) return <div className="text-white/40 text-sm text-center py-12">还没有产品。先创建产品与版本。</div>;

  return (
    <div className="h-[calc(100vh-180px)] min-h-[400px] rounded-xl border border-white/10 overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        onNodeClick={(_e, n) => {
          if (idType(n.id) === 'product') navigate(`/product-agent/p/${n.id.slice('product:'.length)}`);
        }}
        panOnScroll
        panOnScrollSpeed={0.8}
        panOnDrag
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        zoomActivationKeyCode={['Meta', 'Control']}
        selectionOnDrag={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.04)" />
        <MiniMap style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }} maskColor="rgba(0,0,0,0.6)" nodeColor={(n) => (idType(n.id) === 'product' ? '#22D3EE' : '#60A5FA')} pannable zoomable={false} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="px-3 py-1.5 text-[11px] text-white/35 border-t border-white/10">点击产品节点进入该产品 · 拖拽/缩放浏览全公司发布地图</div>
    </div>
  );
}

function nodeStyle(color: string, width: number) {
  return {
    background: 'rgba(255,255,255,0.03)',
    border: `1px solid ${color}`,
    borderLeft: `4px solid ${color}`,
    borderRadius: 10,
    color: '#e8e8ec',
    fontSize: 11,
    width,
    whiteSpace: 'pre-line' as const,
    padding: '6px 10px',
  };
}

export function OverviewGraph() {
  return (
    <ReactFlowProvider>
      <OverviewGraphInner />
    </ReactFlowProvider>
  );
}
