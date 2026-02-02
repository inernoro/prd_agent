import { cn } from '@/lib/cn';
import { BlackholeBackground } from '../components/BlackholeBackground';

interface CtaFooterProps {
  className?: string;
  onGetStarted?: () => void;
  onContact?: () => void;
}

export function CtaFooter({ className, onGetStarted, onContact }: CtaFooterProps) {
  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Blackhole vortex background */}
      <BlackholeBackground />

      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Content */}
      <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
        {/* Headline */}
        <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-6">
          <span className="text-white/90">开启你的</span>
          <br />
          <span
            style={{
              background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Agent 之旅
          </span>
        </h2>

        <p className="text-lg sm:text-xl text-white/50 max-w-2xl mx-auto mb-10">
          立即注册，免费体验智能 Agent 平台的强大能力
        </p>

        {/* CTA buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
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
              免费注册
              <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
          </button>

          <button
            onClick={onContact}
            className="px-10 py-4 rounded-xl font-semibold text-lg border border-white/20 text-white/80 bg-white/5 backdrop-blur-md transition-all duration-300 hover:bg-white/10 hover:border-white/30 hover:scale-105 active:scale-95"
          >
            联系我们
          </button>
        </div>

        {/* Footer links */}
        <div className="border-t border-white/10 pt-8">
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-white/40">
            <a href="#" className="hover:text-white/60 transition-colors">关于我们</a>
            <a href="#" className="hover:text-white/60 transition-colors">使用文档</a>
            <a href="#" className="hover:text-white/60 transition-colors">API 接口</a>
            <a href="#" className="hover:text-white/60 transition-colors">隐私政策</a>
            <a href="#" className="hover:text-white/60 transition-colors">服务条款</a>
          </div>

          <div className="mt-6 text-xs text-white/30">
            © 2026 MAP. All rights reserved.
          </div>
        </div>
      </div>
    </section>
  );
}
