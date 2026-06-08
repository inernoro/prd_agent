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
 * 验收报告「证据板」——不再是把步骤按文档顺序串成假关系图(旧版被用户批"名不副实、看不懂")，
 * 而是用报告里**已有的结构化表**(「## 需求一一对应表」+「## 验收用例一览」)建一张**真关系图**：
 *
 *   左列 = 诉求 / 用例（按结论上色：绿 已落地·通过 / 黄 部分 / 红 未做·不通过）
 *   右列 = 证据截图（报告里的 ## 步骤 N 配图）
 *   连线 = 该诉求/用例由这几张图证明（解析 证据列里的「图N」引用，连到第 N 步截图）
 *
 * 这样图回答的是报告文字一眼看不出的问题：**哪条诉求被哪张图证明、结论是过还是不过**。
 * 没有对应表的旧报告 → 优雅降级：仅竖排展示证据截图（不画假箭头）+ 提示。
 *
 * 模态遵循 frontend-modal.md(createPortal + inline 高度)；手势遵循 gesture-unification.md 标准 B。
 */

type StatusKey = 'pass' | 'partial' | 'fail' | 'unknown';
const STATUS: Record<StatusKey, { label: string; color: string; bg: string; border: string }> = {
  pass: { label: '已落地', color: '#34d399', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.55)' },
  partial: { label: '部分', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.55)' },
  fail: { label: '未做', color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.55)' },
  unknown: { label: '—', color: '#9ca3af', bg: 'rgba(156,163,175,0.10)', border: 'rgba(156,163,175,0.4)' },
};

function statusOf(text: string): StatusKey {
  const t = text || '';
  if (/部分/.test(t)) return 'partial';
  if (/未做|不通过|fail|失败/i.test(t)) return 'fail';
  if (/已落地|通过|pass|done|完成/i.test(t)) return 'pass';
  return 'unknown';
}

type Evidence = { step: number; title: string; thumb?: string };
type Claim = { id: string; kind: '诉求' | '用例'; idx: string; text: string; status: StatusKey; refs: number[] };

/** 解析「## 步骤 N · 标题」+ 该段第一张图，作为证据节点。step = 真实步骤号（用于「图N」连线）。 */
function parseEvidence(content: string): Evidence[] {
  const lines = content.split('\n');
  const out: Evidence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}##\s+步骤\s*(\d+)\s*[·.、:：-]?\s*(.+?)\s*$/);
    if (!m) continue;
    const step = parseInt(m[1], 10);
    let thumb: string | undefined;
    for (let j = i + 1; j < lines.length && !/^\s{0,3}##\s/.test(lines[j]); j++) {
      const img = lines[j].match(/!\[[^\]]*\]\(([^)]+)\)/);
      if (img) { thumb = img[1]; break; }
    }
    out.push({ step, title: m[2].trim(), thumb });
  }
  return out;
}

/** 抽出某个 ## 章节下的 markdown 表格行（去表头 + 分隔行），每行是 cells 数组。 */
function tableRows(content: string, sectionRe: RegExp): string[][] {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => sectionRe.test(l));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{0,3}##\s/.test(lines[i])) break;
    const l = lines[i].trim();
    if (!l.startsWith('|')) continue;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // |---| 分隔行
    rows.push(cells);
  }
  return rows;
}

function refsOf(text: string): number[] {
  const out: number[] = [];
  const re = /图\s*0*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || '')) !== null) out.push(parseInt(m[1], 10));
  return Array.from(new Set(out));
}

function parseClaims(content: string): Claim[] {
  const out: Claim[] = [];
  // 需求一一对应表：| # | 诉求 | 状态 | 实现/证据 |
  const reqRows = tableRows(content, /^\s{0,3}##\s+需求一一对应表/);
  reqRows.forEach((cells) => {
    if (cells[0] === '#' || /诉求|状态/.test(cells[0] || '')) return; // 表头
    if (cells.length < 3) return;
    const idx = cells[0];
    const text = cells[1];
    const status = statusOf(cells[2]);
    const refs = refsOf(cells.slice(2).join(' '));
    if (!text) return;
    out.push({ id: `req-${idx}`, kind: '诉求', idx, text, status, refs });
  });
  // 验收用例一览：| # | 操作 | 预期 | 实际 | 状态 | 证据 |
  const caseRows = tableRows(content, /^\s{0,3}##\s+验收用例/);
  caseRows.forEach((cells) => {
    if (cells[0] === '#' || /操作|预期/.test(cells[1] || '')) return;
    if (cells.length < 5) return;
    const idx = cells[0];
    const text = cells[1];
    const status = statusOf(cells[cells.length - 2]); // 倒数第二列=状态
    const refs = refsOf(cells[cells.length - 1]); // 末列=证据
    if (!text) return;
    out.push({ id: `case-${idx}`, kind: '用例', idx, text, status, refs });
  });
  return out;
}

const CLAIM_W = 290;
const EV_W = 300;
const CLAIM_GAP = 104;
const EV_GAP = 250;
const COL_X_EV = 520;

function ClaimNode({ data }: NodeProps) {
  const d = data as unknown as { kind: string; idx: string; text: string; status: StatusKey; dim?: boolean; sel?: boolean };
  const s = STATUS[d.status];
  return (
    <div
      style={{
        width: CLAIM_W, background: 'var(--bg-card, #1E1F20)', borderRadius: 12,
        border: d.sel ? `2px solid ${s.color}` : `1px solid var(--border-subtle, rgba(255,255,255,0.14))`,
        borderLeft: `4px solid ${s.border}`,
        boxShadow: d.sel ? `0 0 0 3px ${s.color}44, 0 8px 26px rgba(0,0,0,0.45)` : '0 6px 22px rgba(0,0,0,0.35)',
        padding: '10px 12px', opacity: d.dim ? 0.22 : 1, transition: 'opacity .18s, box-shadow .18s', cursor: 'pointer',
      }}
    >
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} isConnectable={false} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: 'rgba(99,102,241,0.18)', color: 'rgba(165,180,252,0.95)' }}>
          {d.kind} {d.idx}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
          {s.label}
        </span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.4 }}>
        {d.text}
      </div>
    </div>
  );
}

function EvidenceNode({ data }: NodeProps) {
  const d = data as unknown as { step: number; title: string; thumb?: string; dim?: boolean; sel?: boolean; onEnlarge?: (s: string, c: string) => void };
  const label = `步骤 ${d.step} · ${d.title}`;
  return (
    <div style={{
      width: EV_W, background: 'var(--bg-card, #1E1F20)',
      border: d.sel ? '2px solid rgba(129,140,248,0.95)' : '1px solid var(--border-subtle, rgba(255,255,255,0.14))',
      borderRadius: 12, overflow: 'hidden',
      boxShadow: d.sel ? '0 0 0 3px rgba(129,140,248,0.4), 0 8px 28px rgba(0,0,0,0.5)' : '0 8px 28px rgba(0,0,0,0.4)',
      opacity: d.dim ? 0.22 : 1, transition: 'opacity .18s, box-shadow .18s', cursor: 'pointer',
    }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} isConnectable={false} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px' }}>
        <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 7, fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(99,102,241,0.22)', color: 'rgba(165,180,252,0.98)' }}>
          {d.step}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{d.title}</span>
      </div>
      {d.thumb && (
        // 点节点(含缩略图)= 选中聚焦(看它证明了哪些诉求);只有「看大图」徽标 stopPropagation 才放大截图。
        <div title="点本卡看它证明了哪些诉求;点「看大图」放大截图" style={{ position: 'relative', cursor: 'pointer', borderTop: '1px solid var(--border-faint)' }} className="nodrag">
          <img src={d.thumb} alt={label} style={{ width: '100%', height: 170, objectFit: 'cover', display: 'block' }} />
          <span
            onClick={(e) => { e.stopPropagation(); d.onEnlarge?.(d.thumb!, label); }}
            style={{ position: 'absolute', right: 8, bottom: 8, cursor: 'zoom-in', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', borderRadius: 7, fontSize: 11, fontWeight: 600, background: 'rgba(0,0,0,0.62)', color: '#fff' }}
          >
            <ZoomIn size={12} /> 看大图
          </span>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { claim: ClaimNode, evidence: EvidenceNode };

function GraphInner({ claims, evidence, onEnlarge, onlyUnfinished }: { claims: Claim[]; evidence: Evidence[]; onEnlarge: (s: string, c: string) => void; onlyUnfinished: boolean }) {
  // 点击某节点 → 进入「聚焦」：只高亮它的连线 + 直接相连的节点，其余淡出。解决线条错综复杂看不清。
  const [selId, setSelId] = useState<string | null>(null);

  // 「只看未完成」：折叠 已落地 的 claim，证据只保留被剩余 claim 引用到的，让 部分/未做 一眼跳出。
  const shownClaims = useMemo(() => (onlyUnfinished ? claims.filter((c) => c.status !== 'pass') : claims), [claims, onlyUnfinished]);
  const shownEvidence = useMemo(() => {
    if (!onlyUnfinished) return evidence;
    const refset = new Set(shownClaims.flatMap((c) => c.refs));
    return evidence.filter((e) => refset.has(e.step));
  }, [evidence, shownClaims, onlyUnfinished]);

  // 邻接表：claimId → [ev-step...]，ev-step → [claimId...]
  const adj = useMemo(() => {
    const evSteps = new Set(shownEvidence.map((e) => e.step));
    const claimToEv = new Map<string, string[]>();
    const evToClaim = new Map<string, string[]>();
    shownClaims.forEach((c) => {
      const evs = c.refs.filter((s) => evSteps.has(s)).map((s) => `ev-${s}`);
      claimToEv.set(c.id, evs);
      evs.forEach((ev) => { if (!evToClaim.has(ev)) evToClaim.set(ev, []); evToClaim.get(ev)!.push(c.id); });
    });
    return { claimToEv, evToClaim };
  }, [shownClaims, shownEvidence]);

  // 选中后高亮哪些节点（自己 + 直接相连）
  const focusSet = useMemo(() => {
    if (!selId) return null;
    const conn = selId.startsWith('ev-') ? adj.evToClaim.get(selId) : adj.claimToEv.get(selId);
    return new Set([selId, ...(conn || [])]);
  }, [selId, adj]);

  const { nodes, edges } = useMemo(() => {
    const claimNodes: Node[] = shownClaims.map((c, i) => ({
      id: c.id, type: 'claim', position: { x: 0, y: i * CLAIM_GAP },
      data: { ...c, dim: focusSet ? !focusSet.has(c.id) : false, sel: c.id === selId } as unknown as Record<string, unknown>,
      draggable: true,
    }));
    const evNodes: Node[] = shownEvidence.map((e, j) => ({
      id: `ev-${e.step}`, type: 'evidence', position: { x: COL_X_EV, y: j * EV_GAP },
      data: { ...e, onEnlarge, dim: focusSet ? !focusSet.has(`ev-${e.step}`) : false, sel: `ev-${e.step}` === selId } as unknown as Record<string, unknown>,
      draggable: true,
    }));
    const evByStep = new Set(shownEvidence.map((e) => e.step));
    const es: Edge[] = [];
    shownClaims.forEach((c) => {
      c.refs.forEach((step) => {
        if (!evByStep.has(step)) return;
        const s = STATUS[c.status];
        const touches = !!selId && (c.id === selId || `ev-${step}` === selId);
        const faded = !!selId && !touches;
        es.push({
          id: `${c.id}->ev-${step}`, source: c.id, target: `ev-${step}`,
          animated: touches || (!selId && c.status !== 'fail'),
          markerEnd: { type: MarkerType.ArrowClosed, color: s.color, width: 18, height: 18 },
          style: { stroke: s.color, strokeWidth: touches ? 3.5 : 2, opacity: faded ? 0.05 : (touches ? 1 : 0.8) },
        });
      });
    });
    return { nodes: [...claimNodes, ...evNodes], edges: es };
  }, [shownClaims, shownEvidence, onEnlarge, selId, focusSet]);

  // 选中项的文字说明：直接回答「这张证据指向什么 / 这条诉求由什么证明」
  const info = useMemo(() => {
    if (!selId) return null;
    if (selId.startsWith('ev-')) {
      const step = parseInt(selId.slice(3), 10);
      const e = evidence.find((x) => x.step === step);
      const cs = claims.filter((c) => c.refs.includes(step));
      return { head: `步骤 ${step} · ${e?.title ?? ''}`, sub: `这张证据证明了 ${cs.length} 条诉求/用例：`, chips: cs.map((c) => ({ t: `${c.kind}${c.idx} ${c.text.slice(0, 14)}`, k: c.status })) };
    }
    const c = claims.find((x) => x.id === selId);
    if (!c) return null;
    const steps = c.refs.filter((s) => evidence.some((e) => e.step === s));
    return { head: `${c.kind} ${c.idx} · ${STATUS[c.status].label}`, sub: `「${c.text.slice(0, 22)}」由 ${steps.length} 张证据证明：`, chips: steps.map((s) => ({ t: `步骤${s} ${evidence.find((e) => e.step === s)?.title.slice(0, 12) ?? ''}`, k: 'unknown' as StatusKey })) };
  }, [selId, claims, evidence]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodeClick={(_, n) => setSelId(n.id)} onPaneClick={() => setSelId(null)}
        fitView fitViewOptions={{ padding: 0.18, maxZoom: 1 }} minZoom={0.3} maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        panOnScroll panOnScrollSpeed={0.8} panOnDrag zoomOnScroll={false} zoomOnPinch
        zoomOnDoubleClick={false} zoomActivationKeyCode={['Meta', 'Control']} panActivationKeyCode="Space" selectionOnDrag={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="rgba(255,255,255,0.06)" />
        <Controls position="top-left" showInteractive={false} />
      </ReactFlow>
      {info ? (
        <div style={{ position: 'absolute', left: 12, right: 12, bottom: 12, maxWidth: 600, background: 'var(--bg-elevated, #282A2C)', border: '1px solid var(--border-subtle, rgba(255,255,255,0.18))', borderRadius: 12, padding: '11px 13px', boxShadow: '0 12px 32px rgba(0,0,0,0.55)', zIndex: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{info.head}</span>
            <button onClick={() => setSelId(null)} style={{ fontSize: 11, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}>取消选中</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 5, marginBottom: 6 }}>{info.sub}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {info.chips.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>（无连线）</span>
              : info.chips.map((ch, i) => (
                <span key={i} style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: STATUS[ch.k].bg, color: STATUS[ch.k].color, border: `1px solid ${STATUS[ch.k].border}` }}>{ch.t}</span>
              ))}
          </div>
        </div>
      ) : (
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 12, fontSize: 11, color: 'var(--text-muted)', background: 'rgba(0,0,0,0.5)', padding: '5px 11px', borderRadius: 999, pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap' }}>
          点任意 诉求/证据 节点 → 高亮它的连线、其余淡出 + 下方列出它连了谁
        </div>
      )}
    </div>
  );
}

/** 无对应表时的降级：竖排证据截图，不画假箭头。 */
function EvidenceOnly({ evidence, onEnlarge }: { evidence: Evidence[]; onEnlarge: (s: string, c: string) => void }) {
  const nodes: Node[] = useMemo(
    () => evidence.map((e, j) => ({ id: `ev-${e.step}`, type: 'evidence', position: { x: 0, y: j * EV_GAP }, data: { ...e, onEnlarge } as unknown as Record<string, unknown>, draggable: true })),
    [evidence, onEnlarge],
  );
  return (
    <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.3} maxZoom={2.5} proOptions={{ hideAttribution: true }} panOnScroll panOnDrag zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick={false} zoomActivationKeyCode={['Meta', 'Control']} selectionOnDrag={false}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="rgba(255,255,255,0.06)" />
      <Controls position="bottom-left" showInteractive={false} />
    </ReactFlow>
  );
}

function LegendChip({ k }: { k: StatusKey }) {
  const s = STATUS[k];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color }} /> {s.label}
    </span>
  );
}

export function AcceptanceEvidenceGraph({ content, title, onClose }: { content: string; title: string; onClose: () => void }) {
  const evidence = useMemo(() => parseEvidence(content), [content]);
  const claims = useMemo(() => parseClaims(content), [content]);
  const hasBoard = claims.length > 0 && evidence.length > 0;
  const [enlarged, setEnlarged] = useState<{ src: string; caption: string } | null>(null);
  const onEnlarge = useCallback((src: string, caption: string) => setEnlarged({ src, caption }), []);
  const [onlyUnfinished, setOnlyUnfinished] = useState(false);
  const unfinished = useMemo(() => claims.filter((c) => c.status !== 'pass').length, [claims]);
  const handleBackdrop = useCallback((e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose(); }, [onClose]);

  const modal = (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={handleBackdrop} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="flex flex-col rounded-xl border" style={{ width: '95vw', maxWidth: 1320, height: '90vh', maxHeight: '90vh', background: 'var(--bg-primary, #131314)', borderColor: 'var(--border-subtle, rgba(255,255,255,0.12))' }} onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border-faint)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <Workflow size={16} style={{ color: 'rgba(129,140,248,0.95)' }} />
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>证据板 · {title}</span>
          </div>
          {/* 图例 + 一句"这是什么"：让人 3 秒看懂怎么读这张图 */}
          {hasBoard && (
            <div className="hidden md:flex items-center gap-3 shrink-0">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>左 诉求/用例 → 右 证据图，连线=被这些图证明</span>
              <LegendChip k="pass" /><LegendChip k="partial" /><LegendChip k="fail" />
            </div>
          )}
          {hasBoard && unfinished > 0 && (
            <button
              onClick={() => setOnlyUnfinished((v) => !v)}
              className="shrink-0 text-[11px] font-semibold px-2.5 rounded-[8px] cursor-pointer transition-colors"
              style={onlyUnfinished
                ? { height: 28, background: 'rgba(248,113,113,0.16)', color: '#fca5a5', border: '1px solid rgba(248,113,113,0.5)' }
                : { height: 28, background: 'var(--bg-input)', color: 'var(--text-secondary)', border: '1px solid var(--border-faint)' }}
              title="只显示 部分/未做 的诉求 + 它们的证据，已落地的折叠起来"
            >
              {onlyUnfinished ? '显示全部' : `只看未完成 (${unfinished})`}
            </button>
          )}
          <button onClick={onClose} className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer shrink-0" style={{ color: 'var(--text-muted)' }} title="关闭（Esc）">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1" style={{ minHeight: 0 }}>
          {evidence.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <Workflow size={40} style={{ color: 'var(--text-muted)', opacity: 0.3 }} />
              <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>这篇报告没有可解析的证据步骤</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>证据板依据「## 步骤 N」配图 +「需求一一对应表/验收用例」生成；ZZ 照做风报告天然适用。</p>
            </div>
          ) : (
            <ReactFlowProvider>
              {hasBoard ? <GraphInner claims={claims} evidence={evidence} onEnlarge={onEnlarge} onlyUnfinished={onlyUnfinished} /> : <EvidenceOnly evidence={evidence} onEnlarge={onEnlarge} />}
            </ReactFlowProvider>
          )}
        </div>
        {!hasBoard && evidence.length > 0 && (
          <div className="shrink-0 px-4 py-2 text-[11px] border-t" style={{ borderColor: 'var(--border-faint)', color: 'var(--text-muted)' }}>
            本报告未解析到「需求一一对应表/验收用例」，仅展示证据截图（不画关系连线）。
          </div>
        )}
      </div>

      {enlarged && (
        <div className="fixed inset-0 z-[10010] flex flex-col items-center justify-center" style={{ background: 'rgba(0,0,0,0.88)' }} onClick={(e) => { e.stopPropagation(); setEnlarged(null); }}>
          <div className="text-[12px] mb-3 px-3 py-1 rounded-full" style={{ color: '#fff', background: 'rgba(255,255,255,0.1)' }}>{enlarged.caption} · 点击任意处关闭</div>
          <img src={enlarged.src} alt={enlarged.caption} style={{ maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 10, boxShadow: '0 12px 48px rgba(0,0,0,0.6)' }} />
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
