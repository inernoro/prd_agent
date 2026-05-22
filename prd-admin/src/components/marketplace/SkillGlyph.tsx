import { useEffect, useRef, useState } from 'react';
import {
  GLYPH_SIZE,
  buildGlyphInner,
  glyphFilterSeed,
  glyphGlow,
  resolveGlyphStyle,
} from '@/lib/skillGlyphRegistry';

/**
 * 官方技能卡的「手绘古典线描」标志。
 *
 * - 形态/色相由 tags 命中 skillGlyphRegistry 决定，无匹配回退名字哈希
 * - feTurbulence + feDisplacementMap 做轻度手绘抖线，drop-shadow 暖光
 * - hover「绽放」靠 CSS（父级 .mkt-card:hover .skill-glyph .ink），见 surface.css
 * - 视口懒渲染：滚进视口才挂 SVG 滤镜，避免一屏几十张卡同时跑 turbulence 拖慢
 */
export function SkillGlyph({
  seed,
  tags,
  className,
}: {
  seed: string;
  tags?: string[];
  className?: string;
}) {
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

  const style = resolveGlyphStyle(seed, tags);
  const filterId = `skill-glyph-${glyphFilterSeed(seed)}`;
  const inner = buildGlyphInner(seed, style);

  return (
    <div ref={ref} className={`skill-glyph-wrap ${className ?? ''}`}>
      {visible && (
        <svg
          className="skill-glyph"
          width={GLYPH_SIZE}
          height={GLYPH_SIZE}
          viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
          xmlns="http://www.w3.org/2000/svg"
          style={{ ['--glyphGlow' as string]: glyphGlow(style) }}
        >
          <defs>
            <filter id={filterId} x="-25%" y="-25%" width="150%" height="150%">
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
                scale={1.4}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
          {/* 内容是确定性哈希生成的纯几何（无任何用户文本注入），dangerouslySetInnerHTML 安全 */}
          <g
            className="ink"
            filter={`url(#${filterId})`}
            dangerouslySetInnerHTML={{ __html: inner }}
          />
        </svg>
      )}
    </div>
  );
}

export default SkillGlyph;
