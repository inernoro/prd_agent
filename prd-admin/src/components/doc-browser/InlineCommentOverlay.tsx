import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { CommentLine, ReplyBox, groupKey } from './inlineCommentShared';

// 行内评论高亮 + 气泡/内联卡片浮层。
// 把每条评论的 selectedText 锚回「已渲染的 markdown DOM」，在原文上画高亮条。
// 两种布局（由 mode 控制）：
//   - inline：高亮末尾放可点气泡，点击就地展开评论卡片（GitHub 评论代码风），边读边可展开看。
//   - margin：不画气泡，只留高亮；评论卡片在右侧「批注栏」常驻（InlineCommentMargin），
//             hover 批注栏某条 → hoveredKey 命中 → 本层把对应高亮加亮（双向联动）。
//
// 坐标系巧思：本层是 contentAreaRef（滚动容器，position:relative）的 absolute 子元素，
// top:0/left:0、尺寸 0，作为子元素的包含块原点。子元素位置 = 文本 rect 减去本层 rect，
// 得到「相对本层原点」的偏移——本层与正文同在滚动内容里一起滚，故滚动时无需重算，天然对齐。

interface AnchorMark {
  key: string;
  rects: Array<{ top: number; left: number; width: number; height: number }>;
  bubble: { top: number; left: number };
  /** 内联展开卡片的锚点（高亮末行左下角，相对本层原点） */
  card: { top: number; left: number };
  comments: DocumentInlineComment[];
  orphaned: boolean;
}

// 纯逻辑核心（无 DOM 依赖，可在 node 环境单测）：
// 在若干文本片段（= 各文本节点的 data）里做「去空白」匹配，markdown 渲染会改变空白/跨块，
// 故按去空白后的字符序列查找。返回命中区间的起止 (片段下标, 片段内字符偏移)。
// 短于 2 个非空白字符不锚定，避免误命中。
// contextBefore（评论创建时记录的「选区前文」）：同一短语在文中多处出现时，用它挑「紧邻前文最吻合」
// 的那一处，避免重复短语的评论都锚到首次出现（Bugbot/Codex）。无 context 或仅一处时取首个，行为不变。
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
        let k = 0; // 紧邻前文与 contextBefore 的公共后缀长度
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

// DOM 适配层：收集容器内所有文本节点 → 交给纯核心匹配 → 把结果映射回 Range。
// 只扫正文：跳过 UI 控件文本——代码块「复制」按钮、本浮层自身（aria-hidden）的气泡等，
// 否则评论可能锚到按钮而非正文（Bugbot「Anchor scan includes copy buttons」）。
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
  canCreate = false,
  onCreate,
  onDelete,
}: {
  containerRef: RefObject<HTMLDivElement>;
  comments: DocumentInlineComment[];
  /** 变化即重算（切文档 / 正文内容变化） */
  reflowKey: string | number;
  mode?: 'inline' | 'margin';
  /** margin 模式下，批注栏 hover 命中的分组 key（高亮加亮） */
  hoveredKey?: string | null;
  canCreate?: boolean;
  onCreate?: (input: {
    selectedText: string;
    contextBefore?: string;
    contextAfter?: string;
    startOffset: number;
    endOffset: number;
    content: string;
  }) => Promise<boolean>;
  onDelete?: (comment: DocumentInlineComment) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [marks, setMarks] = useState<AnchorMark[]>([]);
  // inline 模式：当前展开的分组（点气泡就地展开卡片）
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) {
      setMarks([]);
      return;
    }
    // 同一短语的多条评论合并成一颗气泡/一张卡（显示条数）；全文评论不参与行内锚定。
    const groups = new Map<string, DocumentInlineComment[]>();
    for (const c of comments) {
      if (c.isWholeDocument || !c.selectedText) continue;
      const text = groupKey(c.selectedText);
      if (!text) continue;
      let g = groups.get(text);
      if (!g) { g = []; groups.set(text, g); }
      g.push(c);
    }
    if (groups.size === 0) {
      setMarks([]);
      return;
    }
    const oRect = overlay.getBoundingClientRect();
    const maxLeft = Math.max(0, container.clientWidth - 348);
    const next: AnchorMark[] = [];
    groups.forEach((list, text) => {
      const range = findTextRange(container, text, list[0].contextBefore ?? undefined);
      if (!range) return;
      const rectList = Array.from(range.getClientRects());
      if (rectList.length === 0) return;
      const orphaned = list.every((c) => c.status === 'orphaned');
      const rects = rectList.map((r) => ({
        top: r.top - oRect.top,
        left: r.left - oRect.left,
        width: r.width,
        height: r.height,
      }));
      const first = rectList[0];
      const last = rectList[rectList.length - 1];
      next.push({
        key: text,
        rects,
        bubble: { top: last.top - oRect.top, left: last.right - oRect.left },
        card: {
          top: last.bottom - oRect.top + 6,
          left: Math.min(Math.max(0, first.left - oRect.left), maxLeft),
        },
        comments: list,
        orphaned,
      });
    });
    setMarks(next);
  }, [comments, containerRef]);

  // rAF 合并高频触发（resize / 拖宽侧栏），避免每帧全量重算
  const schedule = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; recompute(); });
  }, [recompute]);

  useLayoutEffect(() => {
    recompute();
    // 图片/字体/公式渲染后正文高度会变，延迟两次兜底重算
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

  // 切文档 / 切布局时收起展开的内联卡片
  useEffect(() => { setExpandedKey(null); }, [reflowKey, mode]);

  return (
    <div ref={overlayRef} aria-hidden style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }}>
      {marks.map((m) => {
        const active = hoveredKey === m.key || expandedKey === m.key;
        const expanded = mode === 'inline' && expandedKey === m.key;
        return (
          <div key={m.key}>
            {/* 高亮条：不挡正文点击/划词；active 时加亮（批注栏 hover / 内联展开联动） */}
            {m.rects.map((r, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: r.top,
                  left: r.left,
                  width: r.width,
                  height: r.height,
                  background: m.orphaned
                    ? (active ? 'rgba(148,163,184,0.30)' : 'rgba(148,163,184,0.16)')
                    : (active ? 'rgba(250,204,21,0.34)' : 'rgba(250,204,21,0.18)'),
                  borderBottom: `2px solid ${m.orphaned ? 'rgba(148,163,184,0.5)' : 'rgba(234,179,8,0.7)'}`,
                  borderRadius: 2,
                  pointerEvents: 'none',
                  transition: 'background 0.12s',
                }}
              />
            ))}

            {/* inline 模式：可点气泡，就地展开/收起卡片 */}
            {mode === 'inline' && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setExpandedKey((k) => (k === m.key ? null : m.key)); }}
                title={m.comments.map((c) => `${c.authorDisplayName}：${c.content}`).join('\n').slice(0, 240)}
                className="inline-flex items-center gap-0.5 cursor-pointer"
                style={{
                  position: 'absolute',
                  top: m.bubble.top - 7,
                  left: m.bubble.left + 2,
                  height: 17,
                  padding: '0 5px',
                  borderRadius: 9,
                  pointerEvents: 'auto',
                  background: m.orphaned ? 'rgba(100,116,139,0.95)' : 'rgba(234,179,8,0.96)',
                  color: m.orphaned ? '#e2e8f0' : '#3a2d05',
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: '17px',
                  boxShadow: expanded ? '0 0 0 2px rgba(234,179,8,0.4)' : '0 2px 6px rgba(0,0,0,0.28)',
                  zIndex: 6,
                }}
              >
                <MessageSquare size={10} />
                {m.comments.length > 1 ? m.comments.length : ''}
              </button>
            )}

            {/* inline 展开卡片：就地（GitHub 评论代码风），可读可回复可删 */}
            {expanded && (
              <div
                style={{
                  position: 'absolute',
                  top: m.card.top,
                  left: m.card.left,
                  width: 338,
                  maxHeight: 360,
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                  pointerEvents: 'auto',
                  zIndex: 8,
                  borderRadius: 12,
                  padding: '12px 13px',
                  background: 'linear-gradient(180deg, rgba(30,28,46,0.97), rgba(20,19,28,0.98))',
                  border: '1px solid rgba(168,85,247,0.3)',
                  boxShadow: '0 18px 44px -10px rgba(0,0,0,0.6)',
                  backdropFilter: 'blur(40px)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold truncate" style={{ color: 'var(--text-muted)' }}>
                    {m.comments.length} 条批注
                  </span>
                  <button
                    onClick={() => setExpandedKey(null)}
                    className="text-[10px] cursor-pointer hover:underline flex-none"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    收起
                  </button>
                </div>
                <div className="space-y-2.5">
                  {m.comments.map((c) => (
                    <CommentLine key={c.id} comment={c} canDelete={canCreate} onDelete={onDelete} />
                  ))}
                </div>
                {canCreate && onCreate && (
                  <div className="mt-3">
                    <ReplyBox
                      onSubmit={async (text) => {
                        const base = m.comments[0];
                        return onCreate({
                          selectedText: base.selectedText,
                          contextBefore: base.contextBefore,
                          contextAfter: base.contextAfter,
                          startOffset: base.startOffset,
                          endOffset: base.endOffset,
                          content: text,
                        });
                      }}
                    />
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
