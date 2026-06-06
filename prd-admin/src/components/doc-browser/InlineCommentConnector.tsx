import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// 激活批注的「牵引连线」（业界做法：Word 选中批注画虚线 / Figma tether）。
// 只给当前激活的一条画线（active-only，不同时画所有线，避免花哨）。
// 从正文里激活高亮的气泡（[data-active-hl]）拉一条同色曲线到右侧批注栏的激活卡片（[data-active-card]）。
// 锚点用 DOM data 属性解耦：overlay 与 margin 各自打标，本层只负责按两点画线 + 跟随滚动/缩放刷新。

export function InlineCommentConnector({ activeKey, color }: { activeKey: string | null; color: string }) {
  const [geo, setGeo] = useState<{ d: string; ax: number; ay: number; bx: number; by: number } | null>(null);

  useEffect(() => {
    if (!activeKey) { setGeo(null); return; }
    let raf = 0;
    const compute = () => {
      const hl = document.querySelector('[data-active-hl="1"]') as HTMLElement | null;
      const card = document.querySelector('[data-active-card="1"]') as HTMLElement | null;
      if (!hl || !card) { setGeo(null); return; }
      const a = hl.getBoundingClientRect();
      const b = card.getBoundingClientRect();
      const ax = a.right, ay = a.top + a.height / 2;
      const bx = b.left, by = b.top + Math.min(26, b.height / 2);
      const mx = ax + (bx - ax) * 0.55;
      const d = `M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`;
      setGeo({ d, ax, ay, bx, by });
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute); };
    schedule();
    // capture=true 捕获任意内层滚动容器（正文区 + 批注栏各自独立滚）；resize + 兜底定时覆盖异步布局位移
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const timer = window.setInterval(schedule, 400);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.clearInterval(timer);
    };
  }, [activeKey]);

  if (!geo) return null;
  return createPortal(
    <svg aria-hidden style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 30 }}>
      <path d={geo.d} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.78} strokeLinecap="round" />
      <circle cx={geo.ax} cy={geo.ay} r={3.5} fill={color} />
      <circle cx={geo.bx} cy={geo.by} r={3.5} fill={color} />
    </svg>,
    document.body,
  );
}
