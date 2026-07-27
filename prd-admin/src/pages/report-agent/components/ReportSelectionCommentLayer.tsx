import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { ReportComment } from '@/services/contracts/reportAgent';
import { findTextRange } from '@/components/doc-browser/InlineCommentOverlay';
import { groupKey } from '@/components/doc-browser/inlineCommentShared';
import {
  buildAnchorFromText,
  underlineStroke,
  underlineTint,
  type ReportCommentAnchor,
} from './reportCommentAnchor';

// 周报划词评论层：
//   1. 捕获正文选区（限单个段落容器 [data-report-section] 内）→ 浮出「评论」按钮；
//   2. 把带锚点的评论重定位回已渲染 DOM，画「黄色下划线」（非底色高亮，遵循用户要求）；
//   3. 下划线末尾放评论数角标，点击联动滚动到该段落下的评论线程。
// 锚定算法复用知识库 SSOT（findTextRange / locateInSegments），本层只做周报侧的轻量视觉。
// 坐标系同 doc-browser InlineCommentOverlay：本层是 relative 容器内 0x0 的 absolute 原点，
// 子元素位置 = 文本 rect 减本层 rect，随内容一起滚动，无需监听 scroll。

interface UnderlineMark {
  key: string;
  rects: Array<{ top: number; left: number; width: number; height: number }>;
  badge: { top: number; left: number };
  comments: ReportComment[];
}

interface PendingSelection {
  sectionIndex: number;
  anchor: ReportCommentAnchor;
  pos: { top: number; left: number };
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

export function ReportSelectionCommentLayer({
  containerRef,
  comments,
  isLight,
  reflowKey,
  onCreateFromSelection,
  onActivateThread,
}: {
  /** relative 定位的正文容器（内含带 data-report-section 的段落内容块） */
  containerRef: RefObject<HTMLDivElement | null>;
  comments: ReportComment[];
  isLight: boolean;
  /** 正文内容变化时触发重排（报告 id / 段落数等拼接串） */
  reflowKey: string | number;
  /** 用户选中一段正文并点「评论」 */
  onCreateFromSelection: (sectionIndex: number, anchor: ReportCommentAnchor) => void;
  /** 点击下划线角标 → 滚到对应评论线程（传该组第一条顶级评论） */
  onActivateThread: (comment: ReportComment) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [marks, setMarks] = useState<UnderlineMark[]>([]);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);

  // ---------- 下划线重定位 ----------
  const recompute = useCallback(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) { setMarks([]); return; }

    // 顶级 + 带锚点的评论按「段落 + 归一化选中文本」分组，同一段文字多条评论共用一条下划线
    const groups = new Map<string, ReportComment[]>();
    for (const c of comments) {
      if (c.parentCommentId || !c.selectedText) continue;
      const text = groupKey(c.selectedText);
      if (!text) continue;
      const key = `${c.sectionIndex}::${text}`;
      const g = groups.get(key) ?? [];
      g.push(c);
      groups.set(key, g);
    }
    if (groups.size === 0) { setMarks([]); return; }

    const oRect = overlay.getBoundingClientRect();
    const next: UnderlineMark[] = [];
    groups.forEach((list, key) => {
      const sectionIndex = list[0].sectionIndex;
      const root = container.querySelector<HTMLElement>(`[data-report-section="${sectionIndex}"]`);
      if (!root) return;
      const text = groupKey(list[0].selectedText ?? '');
      const range = findTextRange(root, text, list[0].contextBefore ?? undefined);
      if (!range) return; // 正文已更新且找不到原片段：不画线，评论列表仍可见（优雅降级）
      const rectList = Array.from(range.getClientRects());
      if (rectList.length === 0) return;
      const rects = rectList.map((r) => ({
        top: r.top - oRect.top,
        left: r.left - oRect.left,
        width: r.width,
        height: r.height,
      }));
      const last = rectList[rectList.length - 1];
      next.push({
        key,
        rects,
        badge: { top: last.top - oRect.top - 4, left: last.right - oRect.left + 3 },
        comments: list,
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
    // markdown 图片/字体异步就位后再对齐两次（同 doc-browser 经验值）
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

  // ---------- 选区捕获 ----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePointerUp = () => {
      // 等浏览器把选区结算完再读（双击选词等场景 pointerup 时选区未定）
      window.setTimeout(() => {
        const overlay = overlayRef.current;
        if (!overlay || !containerRef.current) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const startEl = elementOf(range.startContainer);
        const endEl = elementOf(range.endContainer);
        const root = startEl?.closest<HTMLElement>('[data-report-section]') ?? null;
        // 选区必须完整落在同一个段落内容块内（跨段落/选到标题、评论区一律忽略）
        if (!root || !endEl || endEl.closest('[data-report-section]') !== root) return;
        const sectionIndex = Number(root.getAttribute('data-report-section'));
        if (!Number.isFinite(sectionIndex)) return;

        // 选区起点相对段落纯文本的偏移：selectNodeContents + setEnd 的标准算法
        const pre = range.cloneRange();
        pre.selectNodeContents(root);
        pre.setEnd(range.startContainer, range.startOffset);
        const start = pre.toString().length;
        const end = start + range.toString().length;
        const anchor = buildAnchorFromText(root.textContent ?? '', start, end);
        if (!anchor) return;

        const rect = range.getBoundingClientRect();
        const oRect = overlay.getBoundingClientRect();
        setPending({
          sectionIndex,
          anchor,
          pos: {
            top: rect.bottom - oRect.top + 6,
            left: Math.min(
              Math.max(0, rect.left - oRect.left),
              Math.max(0, containerRef.current.clientWidth - 130),
            ),
          },
        });
      }, 0);
    };

    // 选区塌陷（点击空白等）即收起「评论」按钮
    const handleSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPending(null);
    };

    container.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      container.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [containerRef]);

  // 角标：黄金底 + 统一深墨字（两种主题的黄底上对比度都 >=4.5，无需按主题翻转）。
  // 深色字面量写 rgba 形式——它衬在黄底上、双主题都成立，
  // 不属于 themeHardcodeRatchet 要拦的「浅色主题下漂浮暗块」场景
  const badgeBg = isLight ? '#ca8a04' : '#eab308';
  const badgeFg = 'rgba(26, 18, 5, 0.92)';

  return (
    <div ref={overlayRef} style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }}>
      {marks.map((m) => {
        const emphasized = hoveredKey === m.key;
        const stroke = underlineStroke(isLight, emphasized);
        return (
          <div key={m.key}>
            {/* 黄色下划线：常态只画线不铺底色；hover 角标时加柔和底色提示范围。
                pointerEvents:none —— 不挡正文再次划词/点击链接 */}
            {m.rects.map((r, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: r.top,
                  left: r.left,
                  width: r.width,
                  height: r.height,
                  background: emphasized ? underlineTint(isLight) : 'transparent',
                  borderBottom: `2px solid ${stroke}`,
                  borderRadius: 2,
                  pointerEvents: 'none',
                  transition: 'background 0.12s, border-color 0.12s',
                }}
              />
            ))}
            {/* 评论数角标：点击滚到该线程 */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onActivateThread(m.comments[0]); }}
              onMouseEnter={() => setHoveredKey(m.key)}
              onMouseLeave={() => setHoveredKey((k) => (k === m.key ? null : k))}
              title={`${m.comments.length} 条划词评论，点击查看`}
              className="cursor-pointer"
              style={{
                position: 'absolute',
                top: m.badge.top,
                left: m.badge.left,
                minWidth: 16,
                height: 16,
                padding: '0 4px',
                borderRadius: 8,
                border: 'none',
                background: badgeBg,
                color: badgeFg,
                fontSize: 9,
                fontWeight: 800,
                lineHeight: '16px',
                pointerEvents: 'auto',
                zIndex: 6,
                boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
              }}
            >
              {m.comments.length}
            </button>
          </div>
        );
      })}

      {/* 选中后浮出的「评论」按钮 */}
      {pending && (
        <div
          style={{ position: 'absolute', top: pending.pos.top, left: pending.pos.left, zIndex: 20, pointerEvents: 'auto' }}
        >
          <button
            type="button"
            // preventDefault：避免 pointerdown 令选区塌陷 → selectionchange 把按钮先收掉
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              onCreateFromSelection(pending.sectionIndex, pending.anchor);
              setPending(null);
              window.getSelection()?.removeAllRanges();
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-medium cursor-pointer"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: `1px solid ${underlineStroke(isLight, true)}`,
              boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
            }}
          >
            <MessageSquarePlus size={13} style={{ color: badgeBg }} />
            评论
          </button>
        </div>
      )}
    </div>
  );
}
