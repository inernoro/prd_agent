import { memo, useId } from 'react';

/**
 * 真液态大玻璃 —— SVG feDisplacementMap + CSS backdrop-filter 的组合,
 * 直接折射 DOM 内容(不像 WebGL 方案只能折射 canvas 内部场景),
 * 这是 iOS 26 / macOS 26 Liquid Glass 的工程实现路线。
 *
 * 视觉构成:
 *   1. backdrop-filter: blur(N) saturate(S) → 标准毛玻璃(Safari 也支持)
 *   2. backdrop-filter: url(#feDisplacementMap) → 透过去的 DOM 被
 *      noise 扰动出轻微"液体"质感(仅 Chromium 支持;Safari/Firefox 自动降级)
 *   3. 内描边 + 顶部高光 + 底部阴影 → 模拟玻璃边缘折射光
 *
 * 设计取舍:
 *   - 默认 distortion=0 静态清透,内容必须可读;调大 distortion 才出"液体感"
 *   - 不画任何彩色 blob 之类的额外元素,玻璃就是玻璃
 *   - WebGL 一概不用,bundle 零增量(不依赖 R3F/three)
 */

export interface LiquidGlassSurfaceProps {
  /** 背后模糊半径(px),默认 16。越大越朦胧 */
  blur?: number;
  /** 饱和度增益(%),默认 180。让背后的颜色更鲜活,玻璃感更强 */
  saturation?: number;
  /** SVG 折射强度(px),默认 0。>0 启用液体扰动(仅 Chromium 生效)
   * 建议范围 4-12;>16 内容会糊到看不清 */
  distortion?: number;
  /** 折射 noise 频率,默认 0.012。越大波纹越密 */
  distortionFrequency?: number;
  className?: string;
}

function LiquidGlassSurfaceImpl({
  blur = 16,
  saturation = 180,
  distortion = 0,
  distortionFrequency = 0.012,
  className,
}: LiquidGlassSurfaceProps) {
  // useId 含 `:`,SVG id 不能用,清掉
  const rawId = useId();
  const filterId = `lg-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const hasDistortion = distortion > 0;

  // backdrop-filter 链:Chromium 走带折射的版本,Safari/Firefox 走标准链
  // Safari 完全不支持 url() 引用 SVG filter,所以 -webkit- 前缀只放安全的部分
  const standardChain = `blur(${blur}px) saturate(${saturation}%)`;
  const fullChain = hasDistortion
    ? `url(#${filterId}) ${standardChain}`
    : standardChain;

  return (
    <>
      {hasDistortion && (
        // SVG defs 单独挂一份;尺寸为 0 不占布局
        <svg
          aria-hidden
          style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
        >
          <defs>
            <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency={`${distortionFrequency} ${distortionFrequency * 1.3}`}
                numOctaves={2}
                seed={4}
                result="noise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="noise"
                scale={distortion}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      )}
      <div
        aria-hidden
        className={className}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 0,
          borderRadius: 'inherit',
          // Chromium:带 SVG 折射;Safari/Firefox:仅 blur + saturate
          backdropFilter: fullChain,
          WebkitBackdropFilter: standardChain,
          // 极淡的暖白底色给玻璃一点"实体感",不挡内容(alpha 仅 0.04)
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.015) 50%, rgba(255,255,255,0.04) 100%)',
          // 玻璃边缘的光学细节:顶高光 + 底阴影 + 极细内描边
          boxShadow: [
            'inset 0 1px 0 rgba(255,255,255,0.22)',
            'inset 0 -1px 0 rgba(0,0,0,0.18)',
            'inset 0 0 0 0.5px rgba(255,255,255,0.08)',
          ].join(', '),
        }}
      />
    </>
  );
}

export const LiquidGlassSurface = memo(LiquidGlassSurfaceImpl);
