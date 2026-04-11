import { cn } from '@/lib/cn';
import { BlurText } from '@/components/reactbits';

/**
 * Shared landing page gradient — neon cyan → electric violet → rose.
 * 稀缺渐变原则：主渐变只许在 Hero 主 CTA + 幕 7 Final CTA 出现两次，其他地方不允许复用。
 */
export const HERO_GRADIENT = 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)';
export const HERO_GRADIENT_TEXT = {
  background: HERO_GRADIENT,
  WebkitBackgroundClip: 'text' as const,
  WebkitTextFillColor: 'transparent' as const,
  backgroundClip: 'text' as const,
};

interface HeroSectionProps {
  className?: string;
  onGetStarted?: () => void;
  onWatchDemo?: () => void;
}

export function HeroSection({ className, onGetStarted, onWatchDemo }: HeroSectionProps) {
  return (
    <section
      className={cn(
        'relative min-h-screen flex flex-col items-center justify-center',
        className,
      )}
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* 极薄的暗层，让粒子星云透出来，但不抢主角 */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-[#030306]/60 via-[#030306]/30 to-[#030306]/80" />

      {/* 主体内容 — 居中、极少元素、大留白 */}
      <div className="relative z-10 w-full max-w-5xl mx-auto px-6 text-center">
        {/* 品牌标识（唯一的小 chip） */}
        <div
          className="inline-flex items-center gap-2.5 px-4 py-1.5 mb-10 rounded-full border border-white/15 bg-white/[0.04] backdrop-blur-md"
          style={{ letterSpacing: '0.18em' }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300" />
          </span>
          <span className="text-[11px] font-medium text-white/70 uppercase">MAP · 米多 Agent 平台</span>
        </div>

        {/* 唯一主角：超大显示字体，纯白，单行主标题 */}
        <h1
          className="font-light leading-[0.95] tracking-tight text-white"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(3.25rem, 10vw, 9.5rem)',
            letterSpacing: '-0.04em',
          }}
        >
          <BlurText
            text="让创造自由呼吸"
            delay={120}
            animateBy="letters"
            direction="top"
            className="justify-center"
            animationFrom={{ filter: 'blur(18px)', opacity: 0, y: -20 }}
            animationTo={[
              { filter: 'blur(6px)', opacity: 0.5, y: 4 },
              { filter: 'blur(0px)', opacity: 1, y: 0 },
            ]}
            stepDuration={0.5}
          />
        </h1>

        {/* 单行副标题，克制、不堆料 */}
        <p
          className="mt-8 text-base sm:text-lg text-white/55 max-w-xl mx-auto leading-relaxed"
          style={{ letterSpacing: '0.02em' }}
        >
          融合大模型与多模态能力的 AI 工作台 — 让创作、分析、协作，
          <br className="hidden sm:inline" />
          在同一个宇宙里发生。
        </p>

        {/* 两个 CTA — 主 CTA 是全站渐变的"第一次出现" */}
        <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={onGetStarted}
            className="group relative px-9 py-3.5 rounded-full font-medium text-[15px] text-white transition-all duration-300 hover:scale-[1.03] active:scale-[0.98]"
            style={{
              background: HERO_GRADIENT,
              boxShadow:
                '0 0 48px rgba(0, 240, 255, 0.28), 0 0 96px rgba(124, 58, 237, 0.18), 0 10px 32px rgba(0,0,0,0.5)',
              letterSpacing: '0.02em',
              fontFamily: 'var(--font-display)',
            }}
          >
            <span className="relative z-10 flex items-center gap-2">
              进入 MAP
              <svg
                className="w-4 h-4 transition-transform group-hover:translate-x-1"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
          </button>

          <button
            onClick={onWatchDemo}
            className="group px-8 py-3.5 rounded-full text-[15px] font-medium text-white/80 bg-white/[0.03] border border-white/15 backdrop-blur-md transition-all duration-300 hover:bg-white/[0.08] hover:border-white/30 hover:text-white"
            style={{ letterSpacing: '0.02em', fontFamily: 'var(--font-display)' }}
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="9" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 9l5 3-5 3V9z" />
              </svg>
              观看片花
            </span>
          </button>
        </div>
      </div>

      {/* 向下探索 — 极细提示 */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
        <button
          onClick={onWatchDemo}
          className="flex flex-col items-center gap-2 text-white/35 hover:text-white/70 transition-colors"
          aria-label="向下滚动"
        >
          <span
            className="text-[10px] uppercase"
            style={{ letterSpacing: '0.3em', fontFamily: 'var(--font-display)' }}
          >
            scroll
          </span>
          <div className="w-5 h-9 rounded-full border border-white/20 flex items-start justify-center p-1.5">
            <div className="w-0.5 h-2 bg-cyan-300/70 rounded-full animate-scroll-down" />
          </div>
        </button>
      </div>
    </section>
  );
}
