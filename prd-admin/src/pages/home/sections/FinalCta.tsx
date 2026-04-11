import { ArrowRight } from 'lucide-react';
import { HERO_GRADIENT } from './HeroSection';

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
        <div
          className="inline-flex items-center gap-2 mb-6 px-3 py-1 rounded border border-rose-400/30"
          style={{ fontFamily: 'var(--font-mono)', background: 'rgba(244, 63, 94, 0.06)' }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
          </span>
          <span
            className="text-[12px] uppercase"
            style={{
              color: '#fb7185',
              letterSpacing: '0.18em',
              textShadow: '0 0 10px rgba(244, 63, 94, 0.55)',
            }}
          >
            ★ Ready Player One
          </span>
        </div>

        <h2
          className="text-white font-medium"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2.25rem, 6.5vw, 5.5rem)',
            lineHeight: 1.02,
            letterSpacing: '-0.035em',
            textShadow:
              '0 0 40px rgba(244, 63, 94, 0.35), 0 0 100px rgba(168, 85, 247, 0.22)',
          }}
        >
          现在，轮到你了。
        </h2>

        <p className="mt-7 text-white/60 max-w-xl mx-auto text-[15.5px] leading-relaxed">
          十五位 Agent 已经就位。你的第一个任务是什么？
        </p>

        <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={onGetStarted}
            className="group relative px-9 py-4 rounded-full font-medium text-[15px] text-white transition-all duration-300 hover:scale-[1.03] active:scale-[0.98]"
            style={{
              background: HERO_GRADIENT,
              boxShadow:
                '0 0 56px rgba(124, 58, 237, 0.4), 0 0 120px rgba(0, 240, 255, 0.22), 0 10px 32px rgba(0,0,0,0.5)',
              letterSpacing: '0.01em',
              fontFamily: 'var(--font-display)',
            }}
          >
            <span className="relative z-10 flex items-center gap-2">
              进入 MAP
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>

          <button
            onClick={onContact}
            className="px-7 py-4 rounded-full text-[14px] font-medium text-white/75 hover:text-white transition-colors"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
          >
            联系我们 →
          </button>
        </div>
      </div>
    </section>
  );
}
