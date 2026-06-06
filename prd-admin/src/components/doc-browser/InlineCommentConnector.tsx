import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';

// 激活批注的「牵引连线」（业界做法：Word 选中批注画虚线 / Figma tether）。
// 只给当前激活的一条画线（active-only），从正文激活高亮的气泡（[data-active-hl]）拉一条同色曲线
// 到右侧批注栏的激活卡片（[data-active-card]）。
//
// 关键实现（两个边界教训）：
//   1) 边界：高亮或卡片滚出正文可视区时不画线（否则端点按几何位置飞到窗口角 / 越过顶栏）。
//      两端都落在 boundsRef（正文滚动容器）的可视纵向范围内才画，端点再钳进该范围。
//   2) 丝滑：用连续 requestAnimationFrame 逐帧「直接改 DOM 属性」跟手，不走 setState（避免每帧
//      React 重渲染造成线段延迟/抖动，与画布高频交互同策略）。只在激活期间跑，开销可忽略。

export function InlineCommentConnector({
  activeKey,
  color,
  boundsRef,
}: {
  activeKey: string | null;
  color: string;
  boundsRef: RefObject<HTMLElement>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const dotARef = useRef<SVGCircleElement>(null);
  const dotBRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    if (!activeKey) return;
    let raf = 0;
    let alive = true;
    const hide = () => { if (svgRef.current) svgRef.current.style.opacity = '0'; };
    const frame = () => {
      if (!alive) return;
      const hl = document.querySelector('[data-active-hl="1"]') as HTMLElement | null;
      const card = document.querySelector('[data-active-card="1"]') as HTMLElement | null;
      if (hl && card && svgRef.current) {
        const a = hl.getBoundingClientRect();
        const b = card.getBoundingClientRect();
        const bounds = boundsRef.current?.getBoundingClientRect();
        const ay = a.top + a.height / 2;
        const bCenter = b.top + b.height / 2;
        // 两端都要在正文可视区内才画（看得见两头才连线，Docs 同理）
        const offscreen = bounds
          ? (ay < bounds.top + 4 || ay > bounds.bottom - 4 || bCenter < bounds.top + 4 || bCenter > bounds.bottom - 4)
          : false;
        if (offscreen) {
          hide();
        } else {
          const ax = a.right;
          const bx = b.left;
          let by = b.top + Math.min(26, b.height / 2);
          if (bounds) by = Math.max(bounds.top + 4, Math.min(bounds.bottom - 4, by));
          const mx = ax + (bx - ax) * 0.55;
          pathRef.current?.setAttribute('d', `M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`);
          dotARef.current?.setAttribute('cx', `${ax}`); dotARef.current?.setAttribute('cy', `${ay}`);
          dotBRef.current?.setAttribute('cx', `${bx}`); dotBRef.current?.setAttribute('cy', `${by}`);
          svgRef.current.style.opacity = '1';
        }
      } else {
        hide();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [activeKey, boundsRef]);

  if (!activeKey) return null;
  return createPortal(
    <svg
      ref={svgRef}
      aria-hidden
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 30, opacity: 0, transition: 'opacity 0.12s' }}
    >
      <path ref={pathRef} d="" fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.8} strokeLinecap="round" />
      <circle ref={dotARef} r={3.5} fill={color} />
      <circle ref={dotBRef} r={3.5} fill={color} />
    </svg>,
    document.body,
  );
}
