import { cn } from '@/lib/cn';
import BlurText from '@/components/reactbits/BlurText';
import { HERO_GRADIENT, HERO_GRADIENT_TEXT } from './HeroSection';

interface CtaFooterProps {
  className?: string;
  onGetStarted?: () => void;
  onContact?: () => void;
}

export function CtaFooter({ className, onGetStarted, onContact }: CtaFooterProps) {
  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Semi-transparent overlay — reduced for vibrancy */}
      <div className="absolute inset-0 bg-[#030306]/35" />

      {/* Decorative glow orbs */}
      {/* Vivid glow orbs — cyan + violet + rose */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full opacity-25 blur-[100px]"
        style={{ background: 'radial-gradient(circle, rgba(0, 240, 255, 0.5) 0%, transparent 70%)' }}
      />
      <div className="absolute top-0 right-0 w-80 h-80 rounded-full opacity-15 blur-[80px]"
        style={{ background: 'radial-gradient(circle, rgba(124, 58, 237, 0.7) 0%, transparent 70%)' }}
      />
      <div className="absolute bottom-0 left-0 w-80 h-80 rounded-full opacity-15 blur-[80px]"
        style={{ background: 'radial-gradient(circle, rgba(244, 63, 94, 0.7) 0%, transparent 70%)' }}
      />

      {/* Grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Floating sparkles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {[...Array(12)].map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 bg-cyan-400/60 rounded-full animate-pulse"
            style={{
              left: `${10 + (i * 7) % 80}%`,
              top: `${15 + (i * 11) % 70}%`,
              animationDelay: `${i * 0.3}s`,
              animationDuration: `${2 + (i % 3)}s`,
            }}
          />
        ))}
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 mb-8 rounded-full border border-cyan-400/30 bg-cyan-400/10 backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
          </span>
          <span className="text-sm text-cyan-300">限时免费体验中</span>
        </div>

        {/* Headline */}
        <h2 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold mb-6">
          <span className="text-white">开启你的</span>
          <br />
          <span
            className="relative inline-block"
            style={HERO_GRADIENT_TEXT}
          >
            Agent 之旅
            {/* Underline decoration — vivid */}
            <svg className="absolute -bottom-2 left-0 w-full" viewBox="0 0 200 8" fill="none">
              <path
                d="M2 6C50 2 150 2 198 6"
                stroke="url(#ctaVividGradient)"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <defs>
                <linearGradient id="ctaVividGradient" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#00f0ff" />
                  <stop offset="50%" stopColor="#7c3aed" />
                  <stop offset="100%" stopColor="#f43f5e" />
                </linearGradient>
              </defs>
            </svg>
          </span>
        </h2>

        <BlurText
          text="立即注册，免费体验智能 Agent 平台的强大能力"
          delay={30}
          animateBy="letters"
          direction="bottom"
          className="justify-center text-lg sm:text-xl text-white/60 max-w-2xl mx-auto mb-10"
          stepDuration={0.3}
        />

        {/* Quick stats */}
        <div className="flex items-center justify-center gap-8 sm:gap-12 mb-10">
          {[
            { value: '10+', label: '智能 Agent' },
            { value: '99.9%', label: '可用性' },
            { value: '24/7', label: '技术支持' },
          ].map((stat, i) => (
            <div key={i} className="text-center">
              <div className="text-2xl sm:text-3xl font-bold text-white/90">{stat.value}</div>
              <div className="text-xs sm:text-sm text-white/55">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* CTA buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
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
              免费注册
              <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
          </button>

          <button
            onClick={onContact}
            className="px-10 py-4 rounded-xl font-semibold text-lg border border-white/25 text-white/85 bg-white/5 backdrop-blur-md transition-all duration-300 hover:bg-white/10 hover:border-cyan-400/40 hover:text-white hover:scale-105 active:scale-95"
          >
            联系我们
          </button>
        </div>

        {/* Trust indicators */}
        <div className="flex items-center justify-center gap-6 mb-12 text-white/45 text-sm">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span>企业级安全</span>
          </div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <span>免费试用</span>
          </div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>即刻上手</span>
          </div>
        </div>

        {/* Footer links */}
        <div className="border-t border-white/10 pt-8">
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-white/50">
            <a href="#" className="hover:text-white/80 transition-colors">关于我们</a>
            <a href="#" className="hover:text-white/80 transition-colors">使用文档</a>
            <a href="#" className="hover:text-white/80 transition-colors">API 接口</a>
            <a href="#" className="hover:text-white/80 transition-colors">隐私政策</a>
            <a href="#" className="hover:text-white/80 transition-colors">服务条款</a>
          </div>

          <div className="mt-6 text-xs text-white/40">
            © 2026 MAP. All rights reserved.
          </div>
        </div>
      </div>
    </section>
  );
}
