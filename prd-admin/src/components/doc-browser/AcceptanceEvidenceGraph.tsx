import { useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { X, Workflow } from 'lucide-react';

/**
 * 验收报告「证据关系图」——把 ZZ 风报告里的每个 `## 步骤 N · 标题` 解析成节点，
 * 按顺序连边，构成一张"探案证据板"：每个节点是测试者走到的一个页面/操作 +
 * 该步的证据截图，箭头表示页面之间的跳转关系（页面 A → 页面 B）。
 *
 * 手势遵循 .claude/rules/gesture-unification.md 标准 B（两指拖动平移 / 捏合缩放 /
 * ⌘+滚轮缩放 / 禁双击缩放）。模态遵循 frontend-modal.md（createPortal + inline 高度 + min-h:0）。
 */

type StepNodeData = {
  index: number;
  title: string;
  thumb?: string;
};

function parseSteps(content: string): StepNodeData[] {
  const lines = content.split('\n');
  // 收集所有 H2 标题行索引；优先「步骤」语义，无则退化为全部 H2
  const headings: { line: number; text: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s{0,3}##\s+(.+?)\s*$/);
    if (m) headings.push({ line: i, text: m[1].trim() });
  });
  if (headings.length === 0) return [];
  const stepHeadings = headings.filter(h => /步骤|step/i.test(h.text));
  const used = stepHeadings.length > 0 ? stepHeadings : headings;

  return used.map((h, idx) => {
    // 在本段（到下一个 H2 之前）找第一张图片 URL 作缩略图
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
  return (
    <div
      style={{
        width: 220,
        background: 'var(--bg-card, #1E1F20)',
        border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px' }}>
        <span
          style={{
            flexShrink: 0, width: 20, height: 20, borderRadius: 6, fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(99,102,241,0.18)', color: 'rgba(165,180,252,0.95)',
          }}
        >
          {d.index}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
          {d.title || `步骤 ${d.index}`}
        </span>
      </div>
      {d.thumb && (
        <img
          src={d.thumb}
          alt={d.title}
          style={{ width: '100%', height: 124, objectFit: 'cover', display: 'block', borderTop: '1px solid var(--border-faint)' }}
        />
      )}
    </div>
  );
}

const nodeTypes = { evidence: StepNode };

function GraphInner({ steps }: { steps: StepNodeData[] }) {
  const nodes: Node[] = useMemo(
    () =>
      steps.map((s, i) => ({
        id: String(s.index),
        type: 'evidence',
        position: { x: (i % 2) * 300, y: i * 200 }, // 双列 zigzag，像证据板
        data: s as unknown as Record<string, unknown>,
        draggable: true,
      })),
    [steps],
  );
  const edges: Edge[] = useMemo(
    () =>
      steps.slice(1).map((s, i) => ({
        id: `e${steps[i].index}-${s.index}`,
        source: String(steps[i].index),
        target: String(s.index),
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(129,140,248,0.8)' },
        style: { stroke: 'rgba(129,140,248,0.55)', strokeWidth: 1.5 },
      })),
    [steps],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.2}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      // 手势统一（gesture-unification.md 标准 B）
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
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.05)" />
      <Controls position="bottom-left" showInteractive={false} />
    </ReactFlow>
  );
}

export function AcceptanceEvidenceGraph({ content, title, onClose }: { content: string; title: string; onClose: () => void }) {
  const steps = useMemo(() => parseSteps(content), [content]);

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
          width: '92vw', maxWidth: 1100, height: '88vh', maxHeight: '88vh',
          background: 'var(--bg-primary, #131314)',
          borderColor: 'var(--border-subtle, rgba(255,255,255,0.12))',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-faint)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <Workflow size={15} style={{ color: 'rgba(129,140,248,0.9)' }} />
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>证据关系图 · {title}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{steps.length} 个步骤</span>
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
              <GraphInner steps={steps} />
            </ReactFlowProvider>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
