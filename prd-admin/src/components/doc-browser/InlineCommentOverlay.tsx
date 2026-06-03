import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';

// 行内评论高亮 + 气泡浮层。
// 把每条评论的 selectedText 锚回「已渲染的 markdown DOM」，在原文上画高亮条，
// 并在锚点末尾放一颗可点的评论气泡（点击 → 打开评论抽屉）。
//
// 坐标系巧思：本层是 contentAreaRef（滚动容器，position:relative）的 absolute 子元素，
// top:0/left:0、尺寸 0，作为子元素的包含块原点。高亮子元素位置 = 文本 rect 减去本层 rect，
// 得到「相对本层原点」的偏移——本层与正文同在滚动内容里一起滚，故滚动时无需重算，天然对齐。

interface AnchorMark {
  key: string;
  rects: Array<{ top: number; left: number; width: number; height: number }>;
  bubble: { top: number; left: number };
  count: number;
  preview: string;
  orphaned: boolean;
}

// 纯逻辑核心（无 DOM 依赖，可在 node 环境单测）：
// 在若干文本片段（= 各文本节点的 data）里做「去空白」匹配，markdown 渲染会改变空白/跨块，
// 故按去空白后的字符序列查找。返回命中区间的起止 (片段下标, 片段内字符偏移)。
// 短于 2 个非空白字符不锚定，避免误命中。
export function locateInSegments(
  segments: string[],
  query: string,
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
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  const a = points[idx];
  const b = points[idx + needle.length - 1];
  if (!a || !b) return null;
  return { startSeg: a.seg, startOff: a.off, endSeg: b.seg, endOff: b.off };
}

// DOM 适配层：收集容器内所有文本节点 → 交给纯核心匹配 → 把结果映射回 Range。
// 只扫正文：跳过 UI 控件文本——代码块「复制」按钮、本浮层自身（aria-hidden）的气泡等，
// 否则评论可能锚到按钮而非正文（Bugbot「Anchor scan includes copy buttons」）。
function findTextRange(root: HTMLElement, query: string): Range | null {
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
  const hit = locateInSegments(nodes.map((t) => t.data), query);
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
  onOpenComment,
}: {
  containerRef: RefObject<HTMLDivElement>;
  comments: DocumentInlineComment[];
  /** 变化即重算（切文档 / 正文内容变化） */
  reflowKey: string | number;
  onOpenComment: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [marks, setMarks] = useState<AnchorMark[]>([]);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) {
      setMarks([]);
      return;
    }
    // 同一句话的多条评论合并成一颗气泡（显示条数）；全文评论不参与行内锚定
    const groups = new Map<string, DocumentInlineComment[]>();
    for (const c of comments) {
      if (c.isWholeDocument || !c.selectedText) continue;
      const k = c.selectedText.replace(/\s+/g, ' ').trim();
      if (!k) continue;
      let g = groups.get(k);
      if (!g) { g = []; groups.set(k, g); }
      g.push(c);
    }
    if (groups.size === 0) {
      setMarks([]);
      return;
    }
    const oRect = overlay.getBoundingClientRect();
    const next: AnchorMark[] = [];
    groups.forEach((list, text) => {
      const range = findTextRange(container, text);
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
      const last = rectList[rectList.length - 1];
      next.push({
        key: text,
        rects,
        bubble: { top: last.top - oRect.top, left: last.right - oRect.left },
        count: list.length,
        preview: list.map((c) => `${c.authorDisplayName}：${c.content}`).join('\n').slice(0, 240),
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

  return (
    <div ref={overlayRef} aria-hidden style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }}>
      {marks.map((m) => (
        <div key={m.key}>
          {/* 高亮条：不挡正文点击/划词 */}
          {m.rects.map((r, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                top: r.top,
                left: r.left,
                width: r.width,
                height: r.height,
                background: m.orphaned ? 'rgba(148,163,184,0.16)' : 'rgba(250,204,21,0.18)',
                borderBottom: `2px solid ${m.orphaned ? 'rgba(148,163,184,0.5)' : 'rgba(234,179,8,0.7)'}`,
                borderRadius: 2,
                pointerEvents: 'none',
              }}
            />
          ))}
          {/* 气泡：可点击，打开评论抽屉；hover 显示作者+内容预览 */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenComment(); }}
            title={m.preview}
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
              boxShadow: '0 2px 6px rgba(0,0,0,0.28)',
              zIndex: 6,
            }}
          >
            <MessageSquare size={10} />
            {m.count > 1 ? m.count : ''}
          </button>
        </div>
      ))}
    </div>
  );
}
