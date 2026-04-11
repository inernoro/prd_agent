import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { BlurText } from '@/components/reactbits';
import { FloatingAgentCards } from '../components/FloatingAgentCards';

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
  const contentRef = useRef<HTMLDivElement>(null);

  // 中心内容的微视差 —— 不抢戏，但让 Hero 永远在呼吸
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const nx = (e.clientX / window.innerWidth - 0.5) * 2;
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      if (contentRef.current) {
        contentRef.current.style.setProperty('--hmx', nx.toFixed(3));
        contentRef.current.style.setProperty('--hmy', ny.toFixed(3));
      }
    };
    window.addEventListener('mousemove', handler, { passive: true });
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return (
    <section
      className={cn(
        'relative min-h-screen flex flex-col items-center justify-center overflow-hidden',
        className,
      )}
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* 底部暗角渐变 — 只压暗底部，让 Aurora 在标题附近自由发光 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(3,3,6,0.35) 0%, transparent 18%, transparent 75%, rgba(3,3,6,0.75) 100%)',
        }}
      />

      {/* 四角悬浮 Agent 活动卡（lg+ 可见） */}
      <FloatingAgentCards />

      {/* 中心内容（带鼠标微视差） */}
      <div
        ref={contentRef}
        className="relative z-10 w-full max-w-5xl mx-auto px-6 text-center hero-parallax"
        style={{ '--hmx': '0', '--hmy': '0' } as React.CSSProperties}
      >
        {/* 品牌 chip */}
        <div
          className="inline-flex items-center gap-2.5 px-4 py-1.5 mb-10 rounded-full border border-white/15 bg-white/[0.05] backdrop-blur-md"
          style={{ letterSpacing: '0.18em' }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300" />
          </span>
          <span className="text-[11px] font-medium text-white/75 uppercase">MAP · 米多 Agent 平台</span>
        </div>

        {/* 主标题 — 拆两行防换行，第一行细、第二行重，形成视觉节奏 */}
        <h1
          className="text-white"
          style={{
            fontFamily: 'var(--font-display)',
            lineHeight: 0.92,
            letterSpacing: '-0.03em',
          }}
        >
          <div
            style={{
              fontSize: 'clamp(3rem, 9vw, 7.5rem)',
              fontWeight: 300,
              marginBottom: '0.05em',
            }}
          >
            <BlurText
              text="让创造"
              delay={110}
              animateBy="letters"
              direction="top"
              className="justify-center"
              animationFrom={{ filter: 'blur(18px)', opacity: 0, y: -20 }}
              animationTo={[
                { filter: 'blur(6px)', opacity: 0.55, y: 4 },
                { filter: 'blur(0px)', opacity: 1, y: 0 },
              ]}
              stepDuration={0.5}
            />
          </div>
          <div
            style={{
              fontSize: 'clamp(3.5rem, 10vw, 8.5rem)',
              fontWeight: 500,
            }}
          >
            <BlurText
              text="自由呼吸"
              delay={100}
              animateBy="letters"
              direction="bottom"
              className="justify-center"
              animationFrom={{ filter: 'blur(18px)', opacity: 0, y: 22 }}
              animationTo={[
                { filter: 'blur(6px)', opacity: 0.55, y: -4 },
                { filter: 'blur(0px)', opacity: 1, y: 0 },
              ]}
              stepDuration={0.5}
            />
          </div>
        </h1>

        {/* 副标题 */}
        <p
          className="mt-10 text-base sm:text-lg text-white/65 max-w-xl mx-auto leading-relaxed"
          style={{ letterSpacing: '0.02em' }}
        >
          融合大模型与多模态能力的 AI 工作台 — 让创作、分析、协作，
          <br className="hidden sm:inline" />
          在同一个宇宙里发生。
        </p>

        {/* CTA */}
        <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={onGetStarted}
            className="group relative px-9 py-3.5 rounded-full font-medium text-[15px] text-white transition-all duration-300 hover:scale-[1.03] active:scale-[0.98]"
            style={{
              background: HERO_GRADIENT,
              boxShadow:
                '0 0 56px rgba(0, 240, 255, 0.38), 0 0 110px rgba(124, 58, 237, 0.24), 0 10px 32px rgba(0,0,0,0.5)',
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
            className="group px-8 py-3.5 rounded-full text-[15px] font-medium text-white/85 bg-white/[0.05] border border-white/20 backdrop-blur-md transition-all duration-300 hover:bg-white/[0.1] hover:border-white/35 hover:text-white"
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

      {/* Scroll 提示 */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
        <button
          onClick={onWatchDemo}
          className="flex flex-col items-center gap-2 text-white/35 hover:text-white/75 transition-colors"
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

      <style>{`
        .hero-parallax {
          transform: translate3d(
            calc(var(--hmx, 0) * 8px),
            calc(var(--hmy, 0) * 6px),
            0
          );
          transition: transform 0.6s cubic-bezier(0.2, 0.9, 0.2, 1);
          will-change: transform;
        }
      `}</style>
    </section>
  );
}
