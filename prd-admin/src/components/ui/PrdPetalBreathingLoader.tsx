import React, { useLayoutEffect } from 'react';

/**
 * 基于 thirdparty/ref/加载动画-花瓣呼吸.html 的 CSS 加载动画（React 重写版）
 * - 只实现 loader 本体，不带页面背景
 * - 通过 size 控制尺寸（px），默认 92px
 *
 * 性能优化 (2026-02):
 * - <style> 全局注入一次（避免 N 个实例 N 份样式表触发样式重算）
 * - fill 模式花瓣从 20 层减少到 12 层（GPU 合成层 -40%，视觉几乎无差异）
 * - 移除 fill 模式的 boxShadow（缩放到画布比例时不可见，但每帧都要重绘）
 * - 添加 will-change: transform 和 contain 提示浏览器优化合成
 */
const petalPalettes = {
  // 偏暖金：更贴近 admin 登录页的主色调
  gold: [
    '#fff7df',
    '#ffefc3',
    '#ffe3a0',
    '#ffd47a',
    '#f6c35f',
    '#e9b152',
    '#d79a44',
    '#c5863a',
    '#b27431',
    '#9d6128',
    '#8a5322',
    '#76461d',
    '#643a18',
    '#533014',
    '#432611',
    '#351e0e',
    '#2a170b',
    '#201106',
    '#160b03',
    '#0b0501',
  ],
  // 保留原红系（如需回退可用）
  red: [
    '#ffede6',
    '#fedacd',
    '#fdc6b5',
    '#fbb09d',
    '#f99986',
    '#f6816f',
    '#f36859',
    '#ef4f43',
    '#ea342e',
    '#e61919',
    '#cc191f',
    '#b41823',
    '#9b1724',
    '#841524',
    '#6c1322',
    '#56101e',
    '#3f0d19',
    '#2a0912',
    '#15050a',
    '#000',
  ],
} as const;

type CSSVars = React.CSSProperties & {
  ['--prdPetalUnitPx']?: string;
  ['--prdPetalI']?: number;
  ['--prdPetalRot']?: string;
};

// ============ 全局样式注入（单例，不随组件重复创建） ============

const STYLE_ID = 'prd-petal-breath-styles';

const GLOBAL_CSS = `
/* 非 fill 模式：使用 grid 布局居中 */
.prd-petal-breath__petal {
  grid-row: 1 / -1;
  grid-column: 1 / -1;
  box-sizing: border-box;
  will-change: transform;
  animation: prd-petal-breath 2s ease alternate infinite;
  transform: rotate(var(--prdPetalRot)) scale(1);
}

/* fill 模式：使用绝对定位 + translate 居中，溢出裁剪时保持中心对齐 */
.prd-petal-breath__petal--fill {
  position: absolute;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  will-change: transform;
  animation: prd-petal-breath-fill 2s ease alternate infinite;
  transform: translate(-50%, -50%) rotate(var(--prdPetalRot)) scale(1);
}

.prd-petal-breath__petal--paused {
  animation-play-state: paused;
  will-change: auto;
}

@keyframes prd-petal-breath {
  to {
    transform: rotate(var(--prdPetalRot)) scale(0.6);
  }
}

@keyframes prd-petal-breath-fill {
  to {
    transform: translate(-50%, -50%) rotate(var(--prdPetalRot)) scale(0.6);
  }
}

@media (prefers-reduced-motion: reduce) {
  .prd-petal-breath__petal,
  .prd-petal-breath__petal--fill {
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

// ============ fill 模式的精简调色板（12 层，视觉几乎无差异，GPU 负载 -40%） ============

/** 从 20 色中等间距采样 12 色 */
function samplePalette(palette: readonly string[], count: number): string[] {
  const step = (palette.length - 1) / (count - 1);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(palette[Math.round(i * step)]!);
  }
  return out;
}

const FILL_PETAL_COUNT = 12;
const fillPaletteCache = new Map<string, string[]>();

function getFillPalette(variant: keyof typeof petalPalettes): string[] {
  const cached = fillPaletteCache.get(variant);
  if (cached) return cached;
  const sampled = samplePalette(petalPalettes[variant] ?? petalPalettes.gold, FILL_PETAL_COUNT);
  fillPaletteCache.set(variant, sampled);
  return sampled;
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
  /** 为 true 时，铺满父容器（cover 效果：按较大边拉伸，裁剪溢出） */
  fill?: boolean;
  /** 主题色 */
  variant?: keyof typeof petalPalettes;
  /** 为 true 时，动画暂停（静止状态） */
  paused?: boolean;
  /** 为 true 时，花瓣变成灰色 */
  grayscale?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const px = Math.max(36, Math.round(size));
  const unitPx = Math.max(1, px) / 80;

  useLayoutEffect(ensureGlobalStyles, []);

  // fill 模式使用精简调色板（12 层），非 fill 保留完整 20 层
  const palette = fill
    ? getFillPalette(variant)
    : (petalPalettes[variant] ?? petalPalettes.gold);
  const totalPetals = palette.length;

  return (
    <div
      className={className}
      style={
        {
          position: 'relative',
          width: fill ? '100%' : px,
          height: fill ? '100%' : px,
          display: 'grid',
          placeItems: 'center',
          pointerEvents: 'none',
          containerType: fill ? 'size' : undefined,
          overflow: fill ? 'hidden' : undefined,
          // contain 提示：防止内部动画触发外部布局/绘制
          contain: 'layout style paint',
          ...style,
          ['--prdPetalUnitPx']: `${unitPx}px`,
        } as CSSVars
      }
      aria-label="加载中"
      role="status"
    >
      {palette.map((c, idx) => {
        const i = idx + 1;
        // 均匀分布旋转角度（适配不同花瓣数）
        const rot = (360 / totalPetals) * idx;
        const delayMs = i * 80;
        const zIndex = 100 - i;

        // fill 模式：花瓣尺寸按比例缩放（保持最大花瓣 = 100cqw）
        const fillScale = i / totalPetals;
        const petalSizeFill = `max(${Math.round(fillScale * 100)}cqw, ${Math.round(fillScale * 100)}cqh)`;
        const petalSizeFixed = `calc(${i} * 4 * var(--prdPetalUnitPx))`;

        const petalClass = fill ? 'prd-petal-breath__petal--fill' : 'prd-petal-breath__petal';

        return (
          <div
            key={c}
            className={`${petalClass}${paused ? ' prd-petal-breath__petal--paused' : ''}`}
            style={
              {
                width: fill ? petalSizeFill : petalSizeFixed,
                height: fill ? petalSizeFill : petalSizeFixed,
                borderRadius: fill ? `${2 + idx * 0.15}%` : `calc(${1 + 0.2 * i} * var(--prdPetalUnitPx))`,
                // fill 模式移除 boxShadow（缩放到画布比例时不可见，但每帧都要重绘）
                boxShadow: fill
                  ? undefined
                  : `0 0 calc(${0.5 * i} * var(--prdPetalUnitPx)) rgba(0,0,0,0.1)`,
                background: c,
                animationDelay: `${delayMs}ms`,
                zIndex,
                filter: grayscale ? 'grayscale(1) brightness(0.6)' : undefined,
                ['--prdPetalI']: i,
                ['--prdPetalRot']: `${rot}deg`,
              } as CSSVars
            }
          />
        );
      })}
    </div>
  );
}
