import { useEffect, useRef, useState } from 'react';
import {
  GLYPH_SIZE,
  buildGlyphInner,
  glyphFilterSeed,
  glyphGlow,
} from '@/lib/skillGlyphRegistry';

/**
 * 技能卡图标（v6 游戏技能图标）：暖彩手绘线条 + 六边技能槽框 + 专属/哈希符号。
 *
 * - 内容由 skillGlyphRegistry 生成（含框 + 符号）
 * - feTurbulence 轻度做旧成手绘抖线，暖色辉光（drop-shadow）
 * - 视口懒渲染：滚进视口才挂 SVG 滤镜，避免一屏几十张卡同时跑 turbulence
 * - 悬浮：技能槽框缓缓旋转（CSS，见 surface.css），像游戏点亮技能
 */
export function SkillGlyph({ seed, className }: { seed: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [visible]);

  const filterId = `skill-glyph-${glyphFilterSeed(seed)}`;
  const inner = buildGlyphInner(seed);

  return (
    <div ref={ref} className={`skill-glyph-wrap ${className ?? ''}`}>
      {visible && (
        <svg
          className="skill-glyph"
          width={GLYPH_SIZE}
          height={GLYPH_SIZE}
          viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{ ['--glyphGlow' as string]: glyphGlow(seed) }}
        >
          <defs>
            <filter id={filterId} x="-30%" y="-30%" width="160%" height="160%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.02"
                numOctaves={2}
                seed={glyphFilterSeed(seed)}
                result="n"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="n"
                scale={1.3}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
          {/* 确定性哈希生成的纯几何（无用户文本注入），dangerouslySetInnerHTML 安全 */}
          <g className="ink" filter={`url(#${filterId})`} dangerouslySetInnerHTML={{ __html: inner }} />
        </svg>
      )}
    </div>
  );
}

export default SkillGlyph;
