import { cn } from '@/lib/cn';
import { ParticleField } from '../components/ParticleField';
import { GlowOrb } from '../components/GlowOrb';
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
    <section className={cn('relative min-h-screen flex items-center justify-center overflow-hidden', className)}>
      {/* Background layers */}
      <div className="absolute inset-0 bg-[#050508]" />

      {/* Particle field */}
      <ParticleField className="opacity-60" />

      {/* Glow orbs */}
      <GlowOrb color="gold" size="xl" className="top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2" />
      <GlowOrb color="purple" size="lg" className="bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2" />
      <GlowOrb color="blue" size="md" className="top-1/3 right-1/3" />

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />

      {/* Radial vignette */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 80% 60% at 50% 50%, transparent 0%, rgba(5,5,8,0.8) 100%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 text-center px-6 max-w-5xl mx-auto">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 mb-8 rounded-full border border-white/10 bg-white/5 backdrop-blur-md">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-sm text-white/70">新一代 AI Agent 平台</span>
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
        <div className="text-xl sm:text-2xl md:text-3xl text-white/60 mb-4 h-[1.5em]">
          <TypewriterText
            texts={typewriterTexts}
            typingSpeed={80}
            deletingSpeed={40}
            pauseDuration={2500}
          />
        </div>

        {/* Description */}
        <p className="text-base sm:text-lg text-white/50 max-w-2xl mx-auto mb-10 leading-relaxed">
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
            className="group px-8 py-4 rounded-xl font-semibold text-lg border border-white/20 text-white/80 bg-white/5 backdrop-blur-md transition-all duration-300 hover:bg-white/10 hover:border-white/30 hover:scale-105 active:scale-95"
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

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
          <div className="w-6 h-10 rounded-full border-2 border-white/20 flex items-start justify-center p-2">
            <div className="w-1 h-2 bg-white/40 rounded-full animate-scroll-down" />
          </div>
        </div>
      </div>
    </section>
  );
}
