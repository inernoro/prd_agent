import { useLanguage } from '../contexts/LanguageContext';

/**
 * TechLogoBar — Hero 底部的"Powered by"大模型文字 logo 条
 *
 * 风格参照 Linear.app 的客户 logo 条：极小号 + 灰度 +
 * 横向均匀排布 + eyebrow 标签。不用图片 logo（规避侵权），
 * 改用文字 + mono 字体，配合 subtle 分隔点。
 */
export function TechLogoBar() {
  const { t } = useLanguage();

  return (
    <div className="w-full max-w-5xl mx-auto">
      {/* Eyebrow label */}
      <div
        className="text-center text-[10px] uppercase text-white/35 mb-5"
        style={{
          fontFamily: 'var(--font-terminal)',
          letterSpacing: '0.28em',
        }}
      >
        {t.hero.techBarLabel}
      </div>

      {/* Horizontal logo strip */}
      <div
        className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3 md:gap-x-10"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {t.hero.techItems.map((item, i) => (
          <span
            key={item}
            className="relative text-[13px] text-white/45 hover:text-white/90 transition-colors cursor-default"
            style={{ letterSpacing: '-0.005em' }}
          >
            {item}
            {/* 用 ::after 做分隔点，CSS 里直接写会污染全局，改用 JS 判断 */}
            {i < t.hero.techItems.length - 1 && (
              <span
                className="hidden md:inline-block absolute -right-5 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full"
                style={{ background: 'rgba(255, 255, 255, 0.12)' }}
              />
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
