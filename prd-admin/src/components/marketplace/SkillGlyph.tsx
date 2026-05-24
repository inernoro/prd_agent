import { useEffect, useRef, useState } from 'react';
import {
  GLYPH_SIZE,
  buildGlyphInner,
  glyphFilterSeed,
} from '@/lib/skillGlyphRegistry';

/**
 * 技能卡图标：黑色手绘抽象线条 + 少量陶土橙锚点（纸张/炭黑/陶土编辑气质）。
 *
 * - 内容由 skillGlyphRegistry 生成：优先专属象形符号，否则哈希抽象兜底
 * - feTurbulence 轻度做旧成手绘抖线；无辉光、无多彩（唯一陶土色只在锚点圆点）
 * - 视口懒渲染：滚进视口才挂 SVG 滤镜，避免一屏几十张卡同时跑 turbulence
 * - 安静悬浮：陶土锚点轻微放大（CSS，见 surface.css）
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
        >
          <defs>
            <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.018"
                numOctaves={2}
                seed={glyphFilterSeed(seed)}
                result="n"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="n"
                scale={1.1}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
          {/* 确定性哈希生成的纯几何（无用户文本注入），dangerouslySetInnerHTML 安全 */}
          <g filter={`url(#${filterId})`} dangerouslySetInnerHTML={{ __html: inner }} />
        </svg>
      )}
    </div>
  );
}

export default SkillGlyph;
