import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { CommentLine, ReplyBox, groupKey, threadColor, withAlpha } from './inlineCommentShared';

// 行内评论高亮 + 气泡/内联卡片浮层。
// 把每条评论的 selectedText 锚回「已渲染的 markdown DOM」，在原文上画高亮条（按线程配色）。
// 两种布局（由 mode 控制）：
//   - inline：高亮末尾放气泡，点击就地展开评论卡片（GitHub 评论代码风）。
//   - margin：高亮末尾放小气泡，点击「激活」右侧批注栏对应卡片（onActivate）；评论卡常驻在 InlineCommentMargin。
// 强关联（业界做法 Word/Figma/Docs）：同色锚定（高亮下划线=右侧卡片色条同色）+ 激活态（高亮加亮 + 画连线）。
// activeKey/hoveredKey 由父组件统一管理，margin 与 overlay 双向联动；激活的气泡带 data-active-hl，供连线层取锚点。
//
// 坐标系巧思：本层是 contentAreaRef（滚动容器，position:relative）的 absolute 子元素，
// top:0/left:0、尺寸 0，作为子元素的包含块原点。子元素位置 = 文本 rect 减去本层 rect。

interface AnchorMark {
  key: string;
  rects: Array<{ top: number; left: number; width: number; height: number }>;
  bubble: { top: number; left: number };
  card: { top: number; left: number };
  comments: DocumentInlineComment[];
  orphaned: boolean;
}

// 纯逻辑核心（无 DOM 依赖，可在 node 环境单测）：去空白匹配，contextBefore 消歧多处出现。
export function locateInSegments(
  segments: string[],
  query: string,
  contextBefore?: string,
): { startSeg: number; startOff: number; endSeg: number; endOff: number } | null {
  const needle = query.replace(/\s+/g, '');
  if (needle.length < 2) return null;
  let hay = '';
  const points: Array<{ seg: number; off: number }> = [];
  for (let s = 0; s < segments.length; s++) {
    const data = segments[s];
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i])) continue;
      hay += data[i];
      points.push({ seg: s, off: i });
    }
  }
  const idxs: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) idxs.push(i);
  if (idxs.length === 0) return null;
  let chosen = idxs[0];
  if (idxs.length > 1 && contextBefore) {
    const ctx = contextBefore.replace(/\s+/g, '');
    if (ctx) {
      let best = -1;
      for (const i of idxs) {
        const before = hay.slice(Math.max(0, i - ctx.length), i);
        let k = 0;
        while (k < before.length && k < ctx.length && before[before.length - 1 - k] === ctx[ctx.length - 1 - k]) k++;
        if (k > best) { best = k; chosen = i; }
      }
    }
  }
  const a = points[chosen];
  const b = points[chosen + needle.length - 1];
  if (!a || !b) return null;
  return { startSeg: a.seg, startOff: a.off, endSeg: b.seg, endOff: b.off };
}

// DOM 适配层：收集容器内所有文本节点 → 交给纯核心匹配 → 把结果映射回 Range。跳过 UI 控件文本。
function findTextRange(root: HTMLElement, query: string, contextBefore?: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (el.tagName === 'BUTTON' || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('data-no-anchor') === 'true') {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  const hit = locateInSegments(nodes.map((t) => t.data), query, contextBefore);
  if (!hit) return null;
  try {
    const range = document.createRange();
    range.setStart(nodes[hit.startSeg], hit.startOff);
    range.setEnd(nodes[hit.endSeg], hit.endOff + 1);
    return range;
  } catch {
    return null;
  }
}

export function InlineCommentOverlay({
  containerRef,
  comments,
  reflowKey,
  mode = 'inline',
  hoveredKey = null,
  activeKey = null,
  onActivate,
  canCreate = false,
  canDelete,
  onCreate,
  onDelete,
}: {
  containerRef: RefObject<HTMLDivElement>;
  comments: DocumentInlineComment[];
  reflowKey: string | number;
  mode?: 'inline' | 'margin';
  /** 批注栏 hover 命中的分组 key（高亮微亮） */
  hoveredKey?: string | null;
  /** 当前激活的分组 key（点高亮/气泡或点卡片）：高亮加亮、inline 展开卡片、margin 出连线锚点 */
  activeKey?: string | null;
  /** 点气泡 → 激活该分组（margin 联动右侧卡 / inline 展开） */
  onActivate?: (key: string, selectedText: string) => void;
  canCreate?: boolean;
  /** 逐条删除权限（库主 / 作者）；缺省不可删 */
  canDelete?: (comment: DocumentInlineComment) => boolean;
  onCreate?: (input: {
    selectedText: string;
    contextBefore?: string;
    contextAfter?: string;
    startOffset: number;
    endOffset: number;
    content: string;
  }, entryId?: string) => Promise<boolean>;
  onDelete?: (comment: DocumentInlineComment) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [marks, setMarks] = useState<AnchorMark[]>([]);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) { setMarks([]); return; }
    const groups = new Map<string, DocumentInlineComment[]>();
    for (const c of comments) {
      if (c.isWholeDocument || !c.selectedText) continue;
      const text = groupKey(c.selectedText);
      if (!text) continue;
      const g = groups.get(text) ?? [];
      g.push(c); groups.set(text, g);
    }
    if (groups.size === 0) { setMarks([]); return; }
    const oRect = overlay.getBoundingClientRect();
    const maxLeft = Math.max(0, container.clientWidth - 348);
    const next: AnchorMark[] = [];
    groups.forEach((list, text) => {
      const range = findTextRange(container, text, list[0].contextBefore ?? undefined);
      if (!range) return;
      const rectList = Array.from(range.getClientRects());
      if (rectList.length === 0) return;
      const orphaned = list.every((c) => c.status === 'orphaned');
      const rects = rectList.map((r) => ({ top: r.top - oRect.top, left: r.left - oRect.left, width: r.width, height: r.height }));
      const first = rectList[0];
      const last = rectList[rectList.length - 1];
      next.push({
        key: text,
        rects,
        bubble: { top: last.top - oRect.top, left: last.right - oRect.left },
        card: { top: last.bottom - oRect.top + 6, left: Math.min(Math.max(0, first.left - oRect.left), maxLeft) },
        comments: list,
        orphaned,
      });
    });
    setMarks(next);
  }, [comments, containerRef]);

  const schedule = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; recompute(); });
  }, [recompute]);

  useLayoutEffect(() => {
    recompute();
    const t1 = window.setTimeout(recompute, 120);
    const t2 = window.setTimeout(recompute, 500);
    const container = containerRef.current;
    const ro = container ? new ResizeObserver(schedule) : null;
    if (container && ro) ro.observe(container);
    window.addEventListener('resize', schedule);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [recompute, schedule, reflowKey, containerRef]);

  return (
    <div ref={overlayRef} aria-hidden style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }}>
      {marks.map((m) => {
        const col = m.orphaned ? '#94a3b8' : threadColor(m.key);
        const active = activeKey === m.key;
        const hover = hoveredKey === m.key;
        const inlineExpanded = mode === 'inline' && active;
        const bg = active ? withAlpha(col, 0.34) : hover ? withAlpha(col, 0.24) : withAlpha(col, 0.15);
        return (
          <div key={m.key}>
            {/* 高亮条：按线程配色，激活/hover 加亮；不挡正文点击/划词 */}
            {m.rects.map((r, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute', top: r.top, left: r.left, width: r.width, height: r.height,
                  background: bg, borderBottom: `2px solid ${withAlpha(col, 0.85)}`, borderRadius: 2,
                  pointerEvents: 'none', transition: 'background 0.12s',
                }}
              />
            ))}

            {/* 气泡：两种布局都有。点击 → 激活该分组（margin 联动右侧卡 + 连线 / inline 就地展开）。
                激活的气泡带 data-active-hl，供连线层 InlineCommentConnector 取锚点。 */}
            <button
              type="button"
              data-active-hl={active ? '1' : undefined}
              onClick={(e) => { e.stopPropagation(); onActivate?.(m.key, m.comments[0].selectedText); }}
              title={m.comments.map((c) => `${c.authorDisplayName}：${c.content}`).join('\n').slice(0, 240)}
              className="inline-flex items-center gap-0.5 cursor-pointer"
              style={{
                position: 'absolute', top: m.bubble.top - 7, left: m.bubble.left + 2,
                height: 17, padding: '0 5px', borderRadius: 9, pointerEvents: 'auto',
                background: withAlpha(col, 0.96), color: m.orphaned ? '#e2e8f0' : '#1a1205',
                fontSize: 10, fontWeight: 700, lineHeight: '17px',
                boxShadow: active ? `0 0 0 2px ${withAlpha(col, 0.45)}` : '0 2px 6px rgba(0,0,0,0.28)',
                zIndex: 6,
              }}
            >
              <MessageSquare size={10} />
              {m.comments.length > 1 ? m.comments.length : ''}
            </button>

            {/* inline 展开卡片：就地（GitHub 评论代码风），可读可回复可删 */}
            {inlineExpanded && (
              <div
                style={{
                  position: 'absolute', top: m.card.top, left: m.card.left, width: 338, maxHeight: 360,
                  overflowY: 'auto', overscrollBehavior: 'contain', pointerEvents: 'auto', zIndex: 8,
                  borderRadius: 12, padding: '12px 13px',
                  background: 'linear-gradient(180deg, rgba(30,28,46,0.97), rgba(20,19,28,0.98))',
                  border: `1px solid ${withAlpha(col, 0.45)}`, boxShadow: '0 18px 44px -10px rgba(0,0,0,0.6)', backdropFilter: 'blur(40px)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold truncate" style={{ color: 'var(--text-muted)' }}>{m.comments.length} 条批注</span>
                  <button onClick={() => onActivate?.(m.key, m.comments[0].selectedText)} className="text-[10px] cursor-pointer hover:underline flex-none" style={{ color: 'var(--text-muted)' }}>收起</button>
                </div>
                <div className="space-y-2.5">
                  {m.comments.map((c) => <CommentLine key={c.id} comment={c} canDelete={canDelete?.(c)} onDelete={onDelete} />)}
                </div>
                {canCreate && onCreate && (
                  <div className="mt-3">
                    <ReplyBox onSubmit={async (text) => {
                      const base = m.comments[0];
                      // 回复落到该线程所属条目（base.entryId），防切档后写到别的文档（Bugbot Medium）
                      return onCreate({ selectedText: base.selectedText, contextBefore: base.contextBefore, contextAfter: base.contextAfter, startOffset: base.startOffset, endOffset: base.endOffset, content: text }, base.entryId);
                    }} />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
