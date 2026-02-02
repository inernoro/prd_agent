import { cn } from '@/lib/cn';
import { TypewriterText } from '../components/TypewriterText';

interface HeroSectionProps {
  className?: string;
  onGetStarted?: () => void;
  onWatchDemo?: () => void;
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
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-8 rounded-full border border-white/10 bg-white/[0.03] backdrop-blur-md">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-sm text-white/60">新一代 AI Agent 平台</span>
          </div>

          {/* Main headline */}
          <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6">
            <span className="block text-white/90">智能 Agent</span>
            <span
              className="block mt-2"
              style={{
                background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              重塑创作
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
          <p className="text-base sm:text-lg text-white/40 max-w-2xl mx-auto mb-12 leading-relaxed">
            融合大语言模型与多模态能力，为您提供文学创作、视觉生成、需求分析、缺陷管理等全方位智能助手服务
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            {/* Primary CTA */}
            <button
              onClick={onGetStarted}
              className="group relative px-8 py-4 rounded-xl font-semibold text-lg transition-all duration-300 hover:scale-105 active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                color: '#0b0b0d',
                boxShadow: '0 0 40px rgba(214, 178, 106, 0.3), 0 8px 32px rgba(0,0,0,0.4)',
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
              className="group px-8 py-4 rounded-xl font-semibold text-lg border border-white/20 text-white/70 bg-white/[0.03] backdrop-blur-md transition-all duration-300 hover:bg-white/[0.06] hover:border-white/30 hover:scale-105 active:scale-95"
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
