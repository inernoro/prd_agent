import { cn } from '@/lib/cn';
import { DecryptedText, BlurText, ShinyText } from '@/components/reactbits';
import { useEffect, useState } from 'react';

/**
 * Shared landing page gradient — neon cyan → electric violet → rose
 * Exported so other sections can reference the same palette.
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

// Rotating text component for the headline — uses ShinyText for vivid shine
function RotatingText() {
  const texts = ['重塑创作', '提升效率', '释放潜能', '驱动创新'];
  const [index, setIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % texts.length);
        setIsAnimating(false);
      }, 300);
    }, 3000);
    return () => clearInterval(interval);
  }, [texts.length]);

  return (
    <span
      className={cn(
        'inline-block transition-all duration-300',
        isAnimating ? 'opacity-0 translate-y-4' : 'opacity-100 translate-y-0'
      )}
    >
      <ShinyText
        text={texts[index]}
        color="#7c3aed"
        shineColor="#00f0ff"
        speed={3}
        className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold"
      />
    </span>
  );
}

// Cycles through text array with DecryptedText animation
function DecryptedTextCycler({ texts }: { texts: string[] }) {
  const [index, setIndex] = useState(0);
  const [key, setKey] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % texts.length);
      setKey((prev) => prev + 1);
    }, 3500);
    return () => clearInterval(interval);
  }, [texts.length]);

  return (
    <DecryptedText
      key={key}
      text={texts[index]}
      speed={40}
      maxIterations={12}
      sequential
      revealDirection="center"
      animateOn="view"
      className="text-white/60"
      encryptedClassName="text-white/30"
    />
  );
}

export function HeroSection({ className, onGetStarted, onWatchDemo }: HeroSectionProps) {
  const typewriterTexts = [
    '智能文学创作',
    '视觉内容生成',
    'PRD 智能解读',
    '缺陷智能管理',
  ];

  return (
    <section className={cn('relative min-h-screen flex flex-col', className)}>
      {/* Reduced overlay — let the vibrant WebGL background shine through */}
      <div className="absolute inset-0 pointer-events-none bg-[#030305]/30" />

      {/* Main content - centered */}
      <div className="flex-1 flex items-center justify-center relative z-10">
        <div className="text-center px-6 max-w-5xl mx-auto pt-20">
          {/* Vivid badge with cyan pulse */}
          <div className="inline-flex items-center gap-2 px-5 py-2.5 mb-8 rounded-full border border-cyan-400/40 bg-cyan-400/10 backdrop-blur-md">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-400" />
            </span>
            <span className="text-sm font-medium text-cyan-300">新一代 AI Agent 平台</span>
          </div>

          {/* Main headline with vivid gradient */}
          <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-4">
            <span style={HERO_GRADIENT_TEXT}>
              <BlurText
                text="MAP"
                delay={150}
                animateBy="letters"
                direction="top"
                className="justify-center text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight"
                animationFrom={{ filter: 'blur(12px)', opacity: 0, y: -30 }}
                animationTo={[
                  { filter: 'blur(6px)', opacity: 0.6, y: 5 },
                  { filter: 'blur(0px)', opacity: 1, y: 0 },
                ]}
                stepDuration={0.4}
              />
            </span>
            <BlurText
              text="米多Agent平台"
              delay={100}
              animateBy="letters"
              direction="bottom"
              className="justify-center text-white/80 text-3xl sm:text-4xl md:text-5xl lg:text-6xl mt-2"
              stepDuration={0.35}
            />
            <span className="relative inline-block mt-2">
              <RotatingText />
              {/* Vivid underline decoration — cyan to purple to rose */}
              <svg className="absolute -bottom-2 left-0 w-full h-3" viewBox="0 0 200 12" fill="none" preserveAspectRatio="none">
                <path
                  d="M2 8C30 4 60 2 100 6C140 10 170 4 198 8"
                  stroke="url(#heroVividGradient)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  fill="none"
                />
                <defs>
                  <linearGradient id="heroVividGradient" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.6" />
                    <stop offset="50%" stopColor="#7c3aed" />
                    <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.6" />
                  </linearGradient>
                </defs>
              </svg>
            </span>
          </h1>

          {/* Decrypted subtitle */}
          <div className="text-xl sm:text-2xl md:text-3xl text-white/60 mb-6 h-[1.5em]">
            <DecryptedTextCycler texts={typewriterTexts} />
          </div>

          {/* Description with higher contrast */}
          <BlurText
            text="融合大语言模型与多模态能力，为您提供文学创作、视觉生成、需求分析、缺陷管理等全方位智能助手服务"
            delay={30}
            animateBy="letters"
            direction="bottom"
            className="justify-center text-base sm:text-lg text-white/55 max-w-2xl mx-auto mb-8 leading-relaxed"
            stepDuration={0.3}
          />

          {/* Key Stats with vivid gradient */}
          <div className="flex items-center justify-center gap-8 sm:gap-12 mb-10">
            {[
              { value: '10+', label: '智能 Agent' },
              { value: '99.9%', label: '服务可用性' },
              { value: '50ms', label: '平均响应' },
            ].map((stat, i) => (
              <div key={i} className="text-center">
                <div
                  className="text-2xl sm:text-3xl md:text-4xl font-bold"
                  style={HERO_GRADIENT_TEXT}
                >
                  {stat.value}
                </div>
                <div className="text-xs sm:text-sm text-white/50 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>

          {/* CTA Buttons — neon glow */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
            {/* Primary CTA — vivid gradient + cyan glow */}
            <button
              onClick={onGetStarted}
              className="group relative px-10 py-4 rounded-xl font-semibold text-lg transition-all duration-300 hover:scale-105 active:scale-95"
              style={{
                background: HERO_GRADIENT,
                color: '#ffffff',
                boxShadow: '0 0 40px rgba(0, 240, 255, 0.35), 0 0 80px rgba(124, 58, 237, 0.2), 0 8px 32px rgba(0,0,0,0.4)',
              }}
            >
              <span className="relative z-10 flex items-center gap-2">
                立即体验
                <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </span>
            </button>

            {/* Secondary CTA — brighter border */}
            <button
              onClick={onWatchDemo}
              className="group px-10 py-4 rounded-xl font-semibold text-lg border border-white/25 text-white/85 bg-white/5 backdrop-blur-md transition-all duration-300 hover:bg-white/10 hover:border-cyan-400/40 hover:text-white hover:scale-105 active:scale-95"
              style={{
                boxShadow: '0 0 20px rgba(0, 240, 255, 0) ',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 0 30px rgba(0, 240, 255, 0.15)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 0 20px rgba(0, 240, 255, 0)'; }}
            >
              <span className="flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                观看演示
              </span>
            </button>
          </div>

          {/* Trust Indicators — brighter */}
          <div className="flex items-center justify-center gap-6 flex-wrap text-white/45 text-sm">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span>企业级安全</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              <span>免费试用</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span>即刻上手</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <span>24/7 支持</span>
            </div>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="relative z-10 pb-8 flex justify-center">
        <button
          onClick={onWatchDemo}
          className="flex flex-col items-center gap-2 text-white/40 hover:text-white/60 transition-colors"
        >
          <span className="text-xs tracking-wider">向下探索</span>
          <div className="w-6 h-10 rounded-full border border-white/25 flex items-start justify-center p-2">
            <div className="w-1 h-2 bg-cyan-400/60 rounded-full animate-scroll-down" />
          </div>
        </button>
      </div>
    </section>
  );
}
