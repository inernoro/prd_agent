import { useMemo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlowProvider,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { X, Workflow, ZoomIn } from 'lucide-react';

/**
 * 验收报告「证据关系图」——把 ZZ 风报告里的每个 `## 步骤 N · 标题` 解析成节点，
 * 自上而下按顺序连边，构成一张"探案证据板"：每个节点是测试者走到的一个页面/操作 +
 * 该步的证据截图，箭头表示页面之间的跳转关系（页面 A → 页面 B）。
 *
 * 清晰度优化（用户反馈"太小看不清"）：节点放大、纵向单列排布、连边加粗、
 * 缩略图点击弹出大图灯箱（看清截图细节）、默认缩放不过度缩小。
 * 手势遵循 gesture-unification.md 标准 B；模态遵循 frontend-modal.md（createPortal + inline 高度）。
 */

type StepNodeData = {
  index: number;
  title: string;
  thumb?: string;
  onEnlarge?: (src: string, caption: string) => void;
};

const NODE_W = 320;
const NODE_GAP_Y = 280;

function parseSteps(content: string): Omit<StepNodeData, 'onEnlarge'>[] {
  const lines = content.split('\n');
  const headings: { line: number; text: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s{0,3}##\s+(.+?)\s*$/);
    if (m) headings.push({ line: i, text: m[1].trim() });
  });
  if (headings.length === 0) return [];
  const stepHeadings = headings.filter(h => /步骤|step/i.test(h.text));
  const used = stepHeadings.length > 0 ? stepHeadings : headings;

  return used.map((h, idx) => {
    const end = idx + 1 < used.length ? used[idx + 1].line : lines.length;
    let thumb: string | undefined;
    for (let i = h.line + 1; i < end; i++) {
      const img = lines[i].match(/!\[[^\]]*\]\(([^)]+)\)/);
      if (img) { thumb = img[1]; break; }
    }
    return { index: idx + 1, title: h.text.replace(/^步骤\s*\d+\s*[·.、:：-]?\s*/i, ''), thumb };
  });
}

function StepNode({ data }: NodeProps) {
  const d = data as unknown as StepNodeData;
  const label = d.title || `步骤 ${d.index}`;
  return (
    <div
      style={{
        width: NODE_W,
        background: 'var(--bg-card, #1E1F20)',
        border: '1px solid var(--border-subtle, rgba(255,255,255,0.14))',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        <span
          style={{
            flexShrink: 0, width: 24, height: 24, borderRadius: 7, fontSize: 13, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(99,102,241,0.22)', color: 'rgba(165,180,252,0.98)',
          }}
        >
          {d.index}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35 }}>
          {label}
        </span>
      </div>
      {d.thumb && (
        <div
          onClick={(e) => { e.stopPropagation(); d.onEnlarge?.(d.thumb!, label); }}
          title="点击查看大图"
          style={{ position: 'relative', cursor: 'zoom-in', borderTop: '1px solid var(--border-faint)' }}
          className="nodrag"
        >
          <img
            src={d.thumb}
            alt={label}
            style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }}
          />
          <span
            style={{
              position: 'absolute', right: 8, bottom: 8, display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 7px', borderRadius: 7, fontSize: 11, fontWeight: 600,
              background: 'rgba(0,0,0,0.62)', color: '#fff',
            }}
          >
            <ZoomIn size={12} /> 看大图
          </span>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { evidence: StepNode };

function GraphInner({ steps, onEnlarge }: { steps: Omit<StepNodeData, 'onEnlarge'>[]; onEnlarge: (src: string, caption: string) => void }) {
  const nodes: Node[] = useMemo(
    () =>
      steps.map((s, i) => ({
        id: String(s.index),
        type: 'evidence',
        // 纵向单列、自上而下：证据链一眼读到底，节点保持大而清晰
        position: { x: 0, y: i * NODE_GAP_Y },
        data: { ...s, onEnlarge } as unknown as Record<string, unknown>,
        draggable: true,
      })),
    [steps, onEnlarge],
  );
  const edges: Edge[] = useMemo(
    () =>
      steps.slice(1).map((s, i) => ({
        id: `e${steps[i].index}-${s.index}`,
        source: String(steps[i].index),
        target: String(s.index),
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(129,140,248,0.95)', width: 22, height: 22 },
        style: { stroke: 'rgba(129,140,248,0.85)', strokeWidth: 2.5 },
      })),
    [steps],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
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
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="rgba(255,255,255,0.06)" />
      <Controls position="bottom-left" showInteractive={false} />
    </ReactFlow>
  );
}

export function AcceptanceEvidenceGraph({ content, title, onClose }: { content: string; title: string; onClose: () => void }) {
  const steps = useMemo(() => parseSteps(content), [content]);
  const [enlarged, setEnlarged] = useState<{ src: string; caption: string } | null>(null);
  const onEnlarge = useCallback((src: string, caption: string) => setEnlarged({ src, caption }), []);

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={handleBackdrop}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="flex flex-col rounded-xl border"
        style={{
          width: '95vw', maxWidth: 1320, height: '90vh', maxHeight: '90vh',
          background: 'var(--bg-primary, #131314)',
          borderColor: 'var(--border-subtle, rgba(255,255,255,0.12))',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-faint)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <Workflow size={16} style={{ color: 'rgba(129,140,248,0.95)' }} />
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>证据关系图 · {title}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{steps.length} 个步骤 · 点截图看大图 · ⌘/Ctrl+滚轮缩放</span>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer" style={{ color: 'var(--text-muted)' }} title="关闭（Esc）">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1" style={{ minHeight: 0 }}>
          {steps.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <Workflow size={40} style={{ color: 'var(--text-muted)', opacity: 0.3 }} />
              <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>这篇报告没有可解析的步骤</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>证据关系图依据报告里的「## 步骤 N」章节生成；ZZ 照做风报告天然适用。</p>
            </div>
          ) : (
            <ReactFlowProvider>
              <GraphInner steps={steps} onEnlarge={onEnlarge} />
            </ReactFlowProvider>
          )}
        </div>
      </div>

      {/* 大图灯箱：点节点截图后全屏看清细节 */}
      {enlarged && (
        <div
          className="fixed inset-0 z-[10010] flex flex-col items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.88)' }}
          onClick={(e) => { e.stopPropagation(); setEnlarged(null); }}
        >
          <div className="text-[12px] mb-3 px-3 py-1 rounded-full" style={{ color: '#fff', background: 'rgba(255,255,255,0.1)' }}>
            {enlarged.caption} · 点击任意处关闭
          </div>
          <img
            src={enlarged.src}
            alt={enlarged.caption}
            style={{ maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 10, boxShadow: '0 12px 48px rgba(0,0,0,0.6)' }}
          />
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
