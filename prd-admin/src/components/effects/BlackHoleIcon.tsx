/**
 * RibbonIcon - 基于 canvas 的丝带动画图标
 * 参考: thirdparty/ref/加载-丝带动画.html
 */
import { useEffect, useRef } from 'react';

interface RibbonIconProps {
  size?: number;
  className?: string;
}

export function RibbonIcon({ size = 48, className }: RibbonIconProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置高清渲染
    const dpr = window.devicePixelRatio || 1;
    const CSIZE = size / 2;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.translate(CSIZE, CSIZE);
    ctx.rotate(-Math.PI / 2);
    ctx.lineWidth = 1.5;

    // 丝带数量和旋转参数
    const rCount = 12;
    let DS = 0;
    const DSinc = 0.003;

    // Roulette 参数
    const roulette = {
      dz: -1,
      type1: 1,
      c0: 1,
      c1: 5,
      r1: CSIZE * 0.35,
      r2: CSIZE * 0.55,
    };

    const getMetrics = (rotFrac: number, n: number) => {
      const t = roulette.dz * (rotFrac + n / rCount) * roulette.c0 * 2 * Math.PI;
      const f1 = 1 + (roulette.type1 * roulette.c1) / roulette.c0;
      const x = roulette.r1 * Math.cos(t) + roulette.r2 * Math.cos(f1 * t);
      const y = roulette.r1 * Math.sin(t) + roulette.r2 * Math.sin(f1 * t);
      return { x, y };
    };

    const getMetricsX = (rotFrac: number, n: number) => {
      const t = roulette.dz * (rotFrac + n / rCount) * roulette.c0 * 2 * Math.PI;
      const f1 = 1 + (-roulette.type1 * roulette.c1) / roulette.c0;
      const x = roulette.r1 * Math.cos(t) + roulette.r2 * Math.cos(f1 * t);
      const y = roulette.r1 * Math.sin(t) + roulette.r2 * Math.sin(f1 * t);
      return { x, y };
    };

    const draw = () => {
      if (!ctx) return;

      // 淡出效果
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.fillRect(0, 0, size * dpr, size * dpr);
      ctx.restore();

      // 绘制丝带
      for (let i = 0; i < rCount; i++) {
        const xy1 = getMetrics(DS, i);
        const xy2 = getMetricsX(DS, i);

        ctx.beginPath();
        ctx.moveTo(xy1.x, xy1.y);
        ctx.lineTo(xy2.x, xy2.y);

        // 白色丝带，带透明度变化
        const alpha = 0.6 + 0.4 * Math.sin((i / rCount) * Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.stroke();
        ctx.closePath();
      }

      DS += DSinc;
      animationRef.current = requestAnimationFrame(draw);
    };

    // 初始化画布为透明/深色
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, size * dpr, size * dpr);
    ctx.restore();

    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
      }}
    />
  );
}

// 保留导出名兼容
export { RibbonIcon as BlackHoleIcon };
