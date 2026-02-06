import React from 'react';

/**
 * 基于 thirdparty/ref/加载动画-花瓣呼吸.html 的 CSS 加载动画（React 重写版）
 * - 只实现 loader 本体，不带页面背景
 * - 通过 size 控制尺寸（px），默认 92px
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

  // 让“1vmin”对应到原 demo 的基准：80vmin = 最大圈尺寸
  const unitPx = Math.max(1, px) / 80;

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
          // fill 模式：启用容器查询 + 裁剪溢出，保持花瓣正圆
          containerType: fill ? 'size' : undefined,
          overflow: fill ? 'hidden' : undefined,
          // 外层不做背景，避免覆盖你现有卡片/画布
          ...style,
          ['--prdPetalUnitPx']: `${unitPx}px`,
        } as CSSVars
      }
      aria-label="加载中"
      role="status"
    >
      <style>{`
/* 非 fill 模式：使用 grid 布局居中 */
.prd-petal-breath__petal {
  grid-row: 1 / -1;
  grid-column: 1 / -1;
  box-sizing: border-box;
  animation: prd-petal-breath 2s ease alternate infinite;
  transform: rotate(var(--prdPetalRot)) scale(1);
}

/* fill 模式：使用绝对定位 + translate 居中，溢出裁剪时保持中心对齐 */
.prd-petal-breath__petal--fill {
  position: absolute;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  animation: prd-petal-breath-fill 2s ease alternate infinite;
  transform: translate(-50%, -50%) rotate(var(--prdPetalRot)) scale(1);
}

.prd-petal-breath__petal--paused {
  animation-play-state: paused;
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
  }
}
      `}</style>

      {(petalPalettes[variant] ?? petalPalettes.gold).map((c, idx) => {
        const i = idx + 1; // 1..20
        const rot = i * 36;
        const delayMs = i * 80;
        const zIndex = 100 - i;
        // 保留所有 20 层花瓣，不跳过任何层

        // fill 模式：使用 max(cqw, cqh) 按较大边拉伸，溢出部分被父容器裁剪（cover 效果）
        // 非 fill 模式：使用固定 px 单位
        const petalSizeFill = `max(${i * 5}cqw, ${i * 5}cqh)`;
        const petalSizeFixed = `calc(${i} * 4 * var(--prdPetalUnitPx))`;

        // fill 模式用 --fill 类（绝对定位居中），非 fill 用普通类（grid 布局）
        const petalClass = fill ? 'prd-petal-breath__petal--fill' : 'prd-petal-breath__petal';

        return (
          <div
            key={c}
            className={`${petalClass}${paused ? ' prd-petal-breath__petal--paused' : ''}`}
            style={
              {
                // fill 模式：按较大边拉伸，居中后裁剪溢出
                width: fill ? petalSizeFill : petalSizeFixed,
                height: fill ? petalSizeFill : petalSizeFixed,
                // 尖锐花瓣：圆角要小（2-4%），不要太圆（原来8-26%太胖）
                borderRadius: fill ? `${2 + i * 0.1}%` : `calc(${1 + 0.2 * i} * var(--prdPetalUnitPx))`,
                boxShadow: fill
                  ? `0 0 ${Math.max(1, Math.round(i * 0.9))}px rgba(0,0,0,0.10)`
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


