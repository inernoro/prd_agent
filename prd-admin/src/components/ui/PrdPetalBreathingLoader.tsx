import React, { useLayoutEffect } from 'react';

/**
 * PrdPetalBreathingLoader — "Golden Nebula" 加载动画
 *
 * 设计理念：温暖的径向脉冲光晕 + 微光扫过，传达"AI 正在创作"的感觉。
 *
 * 性能设计：
 * - 仅 2 个 DOM 元素（光晕 + 微光），替代原来 20 层花瓣
 * - 动画仅使用 transform + opacity（纯 GPU 合成器属性，零布局/绘制开销）
 * - <style> 全局注入一次，不随组件重复创建
 * - 多个实例同时运行也不会导致 GPU 合成层爆炸
 */

// ============ 颜色主题 ============

const themes = {
  gold: {
    core: 'rgba(246, 195, 95, 0.55)',
    mid: 'rgba(215, 154, 68, 0.28)',
    outer: 'rgba(157, 97, 40, 0.10)',
    shimmer: 'rgba(255, 247, 223, 0.13)',
    ring: 'rgba(246, 195, 95, 0.18)',
  },
  red: {
    core: 'rgba(249, 153, 134, 0.55)',
    mid: 'rgba(239, 79, 67, 0.28)',
    outer: 'rgba(155, 23, 36, 0.10)',
    shimmer: 'rgba(255, 237, 230, 0.13)',
    ring: 'rgba(249, 153, 134, 0.18)',
  },
} as const;

type ThemeKey = keyof typeof themes;

// ============ 全局样式注入（单例） ============

const STYLE_ID = 'prd-nebula-loader-styles';

const GLOBAL_CSS = `
.prd-nebula-loader {
  position: relative;
  overflow: hidden;
  pointer-events: none;
}

/* 核心光晕：径向渐变 + 呼吸脉冲 */
.prd-nebula-glow {
  position: absolute;
  inset: -15%;
  border-radius: 50%;
  will-change: transform, opacity;
  animation: prd-nebula-pulse 2.8s ease-in-out infinite;
}

/* 微光扫过 */
.prd-nebula-shimmer {
  position: absolute;
  inset: 0;
  will-change: transform;
  animation: prd-nebula-sweep 3.5s ease-in-out infinite;
  border-radius: inherit;
}

/* 暂停态 */
.prd-nebula-glow--paused {
  animation-play-state: paused;
  will-change: auto;
  opacity: 0.5;
  transform: scale(0.92);
}
.prd-nebula-shimmer--paused {
  animation-play-state: paused;
  will-change: auto;
  opacity: 0;
}

@keyframes prd-nebula-pulse {
  0%, 100% {
    transform: scale(0.82);
    opacity: 0.45;
  }
  50% {
    transform: scale(1.08);
    opacity: 0.95;
  }
}

@keyframes prd-nebula-sweep {
  0% {
    transform: translateX(-130%) skewX(-8deg);
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  100% {
    transform: translateX(130%) skewX(-8deg);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .prd-nebula-glow,
  .prd-nebula-shimmer {
    animation: none !important;
    will-change: auto;
  }
}
`;

let styleInjected = false;

function ensureGlobalStyles() {
  if (styleInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) {
    styleInjected = true;
    return;
  }
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = GLOBAL_CSS;
  document.head.appendChild(el);
  styleInjected = true;
}

// ============ 组件 ============

export function PrdPetalBreathingLoader({
  size = 92,
  fill = false,
  variant = 'gold',
  paused = false,
  grayscale = false,
  className,
  style,
}: {
  size?: number;
  /** 为 true 时，铺满父容器 */
  fill?: boolean;
  /** 主题色 */
  variant?: ThemeKey;
  /** 为 true 时，动画暂停 */
  paused?: boolean;
  /** 为 true 时，变成灰色 */
  grayscale?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  useLayoutEffect(ensureGlobalStyles, []);

  const px = Math.max(36, Math.round(size));
  const t = themes[variant] ?? themes.gold;

  const glowGradient = `radial-gradient(ellipse at center, ${t.core} 0%, ${t.mid} 32%, ${t.outer} 58%, transparent 78%)`;
  const shimmerGradient = `linear-gradient(105deg, transparent 38%, ${t.shimmer} 50%, transparent 62%)`;

  return (
    <div
      className={`prd-nebula-loader ${className ?? ''}`}
      style={{
        width: fill ? '100%' : px,
        height: fill ? '100%' : px,
        borderRadius: fill ? 'inherit' : '50%',
        contain: 'layout style paint',
        filter: grayscale ? 'grayscale(1) brightness(0.55)' : undefined,
        ...style,
      }}
      aria-label="加载中"
      role="status"
    >
      {/* 核心光晕 */}
      <div
        className={`prd-nebula-glow${paused ? ' prd-nebula-glow--paused' : ''}`}
        style={{ background: glowGradient }}
      />
      {/* 微光扫过 */}
      <div
        className={`prd-nebula-shimmer${paused ? ' prd-nebula-shimmer--paused' : ''}`}
        style={{ background: shimmerGradient }}
      />
    </div>
  );
}
