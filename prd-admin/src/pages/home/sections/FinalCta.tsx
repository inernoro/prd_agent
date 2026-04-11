import { ArrowRight, Sparkles, Star } from 'lucide-react';
import { HERO_GRADIENT } from './HeroSection';
import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';

interface FinalCtaProps {
  onGetStarted?: () => void;
  onContact?: () => void;
}

/**
 * FinalCta — 幕 8 · 最终收束
 *
 * 一个居中的巨标题 + 一个主 CTA。稀缺渐变的第二次也是最后一次出现。
 * 整块带一个柔和的底部光晕，作为整页的"尾音"。
 */
export function FinalCta({ onGetStarted, onContact }: FinalCtaProps) {
  const { t } = useLanguage();
  return (
    <section
      className="relative py-32 md:py-44 px-6 overflow-hidden"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* 背景：中心柔光 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(124, 58, 237, 0.22) 0%, rgba(0, 240, 255, 0.08) 40%, transparent 70%)',
        }}
      />

      <div className="relative max-w-4xl mx-auto text-center">
        <Reveal>
          <div
            className="inline-flex items-center gap-2 mb-7 px-3.5 py-1.5 rounded-md"
            style={{
              fontFamily: 'var(--font-mono)',
              background: 'rgba(244, 63, 94, 0.06)',
              border: '1px solid rgba(244, 63, 94, 0.32)',
              boxShadow: '0 0 22px rgba(244, 63, 94, 0.25)',
            }}
          >
            <Star className="w-3.5 h-3.5 text-rose-300" />
            <span
              className="text-[12.5px] uppercase"
              style={{
                color: '#fb7185',
                letterSpacing: '0.2em',
                textShadow: '0 0 10px rgba(244, 63, 94, 0.6)',
              }}
            >
              {t.cta.eyebrow}
            </span>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <h2
            className="text-white font-medium"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(2.25rem, 6.5vw, 5.5rem)',
              lineHeight: 1.02,
              letterSpacing: '-0.035em',
              textShadow:
                '0 0 40px rgba(244, 63, 94, 0.4), 0 0 100px rgba(168, 85, 247, 0.25)',
            }}
          >
            {t.cta.title}
          </h2>
        </Reveal>

        <Reveal delay={160}>
          <p className="mt-8 text-white/62 max-w-xl mx-auto text-[15.5px] leading-[1.7]">
            {t.cta.subtitle}
          </p>
        </Reveal>

        <Reveal delay={240}>
          <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onGetStarted}
              className="group relative inline-flex items-center gap-2.5 h-14 px-10 rounded-full font-medium text-[15px] text-white transition-all duration-300 hover:scale-[1.03] active:scale-[0.98]"
              style={{
                background: HERO_GRADIENT,
                boxShadow:
                  '0 0 60px rgba(124, 58, 237, 0.42), 0 0 140px rgba(0, 240, 255, 0.22), 0 12px 36px rgba(0, 0, 0, 0.55)',
                letterSpacing: '0.01em',
                fontFamily: 'var(--font-display)',
              }}
            >
              <Sparkles className="w-4 h-4" />
              <span>{t.cta.primary}</span>
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </button>

            <button
              onClick={onContact}
              className="inline-flex items-center gap-2 h-14 px-8 rounded-full text-[14.5px] font-medium text-white/80 hover:text-white transition-colors"
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.14)',
                fontFamily: 'var(--font-display)',
                letterSpacing: '0.01em',
              }}
            >
              {t.cta.secondary}
              <ArrowRight className="w-4 h-4 opacity-60" />
            </button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
