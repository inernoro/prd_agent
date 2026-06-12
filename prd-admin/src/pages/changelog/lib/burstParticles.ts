/**
 * 点击迸发彩色粒子（筛选标签彩蛋）。
 * DOM + Web Animations API，无依赖；prefers-reduced-motion 时不触发。
 */
export function burstParticles(x: number, y: number, color: string): void {
  if (typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const palette = [color, '#ffffff', color, color];
  for (let i = 0; i < 14; i++) {
    const p = document.createElement('span');
    p.className = 'clg-particle';
    p.style.background = palette[i % palette.length];
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    if (i % 3 === 0) p.style.borderRadius = '50%';
    document.body.appendChild(p);

    const angle = Math.random() * Math.PI * 2;
    const dist = 36 + Math.random() * 54;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 18;
    const animation = p.animate(
      [
        { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx}px,${dy}px) scale(.2) rotate(${Math.random() * 240 - 120}deg)`, opacity: 0 },
      ],
      { duration: 560 + Math.random() * 240, easing: 'cubic-bezier(.21,.61,.35,1)' },
    );
    animation.onfinish = () => p.remove();
    // 兜底：动画被打断（如页面隐藏）也要清掉节点
    animation.oncancel = () => p.remove();
  }
}
