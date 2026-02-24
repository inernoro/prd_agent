import { cn } from '@/lib/cn';
import { TypewriterText } from '../components/TypewriterText';
import { useEffect, useState } from 'react';

interface HeroSectionProps {
  className?: string;
  onGetStarted?: () => void;
  onWatchDemo?: () => void;
}

// Rotating text component for the headline
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
      style={{
        background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      }}
    >
      {texts[index]}
    </span>
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
      {/* Semi-transparent overlay for text readability (background is global) */}
      <div className="absolute inset-0 pointer-events-none bg-[#030305]/40" />

      {/* Main content - centered */}
      <div className="flex-1 flex items-center justify-center relative z-10">
        <div className="text-center px-6 max-w-5xl mx-auto pt-20">
          {/* Enhanced Badge with pulse animation */}
          <div className="inline-flex items-center gap-2 px-5 py-2.5 mb-8 rounded-full border border-amber-500/30 bg-amber-500/10 backdrop-blur-md">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
            </span>
            <span className="text-sm font-medium text-amber-400/90">新一代 AI Agent 平台</span>
          </div>

          {/* Main headline with underline decoration */}
          <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-4">
            <span
              className="block"
              style={{
                background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              MAP
            </span>
            <span className="block text-white/70 text-3xl sm:text-4xl md:text-5xl lg:text-6xl mt-2">米多Agent平台</span>
            <span className="relative inline-block mt-2">
              <RotatingText />
              {/* Golden underline decoration */}
              <svg className="absolute -bottom-2 left-0 w-full h-3" viewBox="0 0 200 12" fill="none" preserveAspectRatio="none">
                <path
                  d="M2 8C30 4 60 2 100 6C140 10 170 4 198 8"
                  stroke="url(#heroGoldGradient)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  fill="none"
                />
                <defs>
                  <linearGradient id="heroGoldGradient" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#f4e2b8" stopOpacity="0.3" />
                    <stop offset="50%" stopColor="#d6b26a" />
                    <stop offset="100%" stopColor="#f2d59b" stopOpacity="0.3" />
                  </linearGradient>
                </defs>
              </svg>
            </span>
          </h1>

          {/* Typewriter subtitle */}
          <div className="text-xl sm:text-2xl md:text-3xl text-white/50 mb-6 h-[1.5em]">
            <TypewriterText
              texts={typewriterTexts}
              typingSpeed={80}
              deletingSpeed={40}
              pauseDuration={2500}
            />
          </div>

          {/* Description */}
          <p className="text-base sm:text-lg text-white/40 max-w-2xl mx-auto mb-8 leading-relaxed">
            融合大语言模型与多模态能力，为您提供文学创作、视觉生成、需求分析、缺陷管理等全方位智能助手服务
          </p>

          {/* Key Stats */}
          <div className="flex items-center justify-center gap-8 sm:gap-12 mb-10">
            {[
              { value: '10+', label: '智能 Agent' },
              { value: '99.9%', label: '服务可用性' },
              { value: '50ms', label: '平均响应' },
            ].map((stat, i) => (
              <div key={i} className="text-center">
                <div
                  className="text-2xl sm:text-3xl md:text-4xl font-bold"
                  style={{
                    background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                  }}
                >
                  {stat.value}
                </div>
                <div className="text-xs sm:text-sm text-white/40 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
            {/* Primary CTA */}
            <button
              onClick={onGetStarted}
              className="group relative px-10 py-4 rounded-xl font-semibold text-lg transition-all duration-300 hover:scale-105 active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                color: '#0b0b0d',
                boxShadow: '0 0 60px rgba(214, 178, 106, 0.4), 0 8px 32px rgba(0,0,0,0.4)',
              }}
            >
              <span className="relative z-10 flex items-center gap-2">
                立即体验
                <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </span>
            </button>

            {/* Secondary CTA */}
            <button
              onClick={onWatchDemo}
              className="group px-10 py-4 rounded-xl font-semibold text-lg border border-white/20 text-white/80 bg-white/5 backdrop-blur-md transition-all duration-300 hover:bg-white/10 hover:border-white/30 hover:scale-105 active:scale-95"
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

          {/* Trust Indicators */}
          <div className="flex items-center justify-center gap-6 flex-wrap text-white/30 text-sm">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span>企业级安全</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              <span>免费试用</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span>即刻上手</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-purple-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <span>24/7 支持</span>
            </div>
          </div>
        </div>
      </div>

      {/* Scroll indicator - fixed at bottom of section */}
      <div className="relative z-10 pb-8 flex justify-center">
        <button
          onClick={onWatchDemo}
          className="flex flex-col items-center gap-2 text-white/30 hover:text-white/50 transition-colors"
        >
          <span className="text-xs tracking-wider">向下探索</span>
          <div className="w-6 h-10 rounded-full border border-white/20 flex items-start justify-center p-2">
            <div className="w-1 h-2 bg-white/40 rounded-full animate-scroll-down" />
          </div>
        </button>
      </div>
    </section>
  );
}
