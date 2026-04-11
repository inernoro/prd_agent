import { cn } from '@/lib/cn';
import { ProductMockup } from '../components/ProductMockup';

/**
 * Hero — Linear.app 风格：
 *   1. 只有一个顶部紫色径向光晕（不是 4 层 mesh，不是粒子网，不是浮动卡）
 *   2. 居中标题一行到位（字重单一，负字距，editorial 感）
 *   3. 一组 CTA
 *   4. 首屏下半部分直接露出 ProductMockup（真实产品壳），邀请用户滚动
 *
 * 稀缺渐变原则：HERO_GRADIENT 只出现在主 CTA + ProductMockup 的发送按钮 + 幕 7 CTA
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
      className={cn('relative overflow-hidden', className)}
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* Linear 签名动作：顶部单一径向光晕（紫→透明），不是 mesh 也不是粒子 */}
      <div
        className="absolute inset-x-0 top-0 h-[900px] pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 90% 70% at 50% 0%, rgba(124, 58, 237, 0.35) 0%, rgba(124, 58, 237, 0.12) 25%, rgba(59, 130, 246, 0.06) 50%, transparent 75%)',
        }}
      />

      {/* 第一屏：居中标题 + CTA，占 75vh（留 25vh 给产品壳从底部露出） */}
      <div
        className="relative z-10 min-h-[75vh] flex flex-col items-center justify-center px-6 pt-32"
        style={{ animation: 'hero-fade-up 0.9s cubic-bezier(0.2, 0.9, 0.2, 1) both' }}
      >
        {/* 品牌 chip —— 极简一行 */}
        <div
          className="inline-flex items-center gap-2.5 px-3.5 py-1.5 mb-10 rounded-full border border-white/10 bg-white/[0.03] backdrop-blur-sm"
          style={{ letterSpacing: '0.18em' }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-300 opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-purple-300" />
          </span>
          <span className="text-[10.5px] font-medium text-white/65 uppercase">
            MAP · 米多 Agent 平台
          </span>
        </div>

        {/* 主标题 —— 单字重、紧字距、单行（editorial） */}
        <h1
          className="text-center text-white font-medium"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2.75rem, 7.5vw, 6.5rem)',
            lineHeight: 1.02,
            letterSpacing: '-0.035em',
            maxWidth: '16ch',
          }}
        >
          让创造，自由呼吸
        </h1>

        {/* 副标题 —— 单句，克制 */}
        <p
          className="mt-7 text-center text-white/55 max-w-2xl mx-auto leading-relaxed"
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 'clamp(0.95rem, 1.2vw, 1.125rem)',
            letterSpacing: '0.005em',
          }}
        >
          融合大模型与多模态能力的 AI 工作台 —— 视觉、文学、产品、视频、缺陷，十余个专业 Agent 在同一个空间协同。
        </p>

        {/* CTA 组 */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={onGetStarted}
            className="group relative px-7 py-3 rounded-full font-medium text-[14px] text-white transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: HERO_GRADIENT,
              boxShadow:
                '0 0 44px rgba(124, 58, 237, 0.32), 0 8px 24px rgba(0, 0, 0, 0.4)',
              letterSpacing: '0.01em',
              fontFamily: 'var(--font-display)',
            }}
          >
            <span className="relative z-10 flex items-center gap-2">
              进入 MAP
              <svg
                className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
          </button>

          <button
            onClick={onWatchDemo}
            className="group px-6 py-3 rounded-full text-[14px] font-medium text-white/80 hover:text-white transition-colors"
            style={{ letterSpacing: '0.01em', fontFamily: 'var(--font-display)' }}
          >
            <span className="flex items-center gap-2">
              观看片花
              <svg
                className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </span>
          </button>
        </div>
      </div>

      {/* 产品壳 —— 从首屏底部往下"长出来"，给用户"滚一点就看到东西"的暗示 */}
      <div
        className="relative z-10 pb-32 md:pb-40 px-4 md:px-8"
        style={{ animation: 'mockup-rise 1.1s 0.3s cubic-bezier(0.2, 0.9, 0.2, 1) both' }}
      >
        <ProductMockup />
      </div>

      <style>{`
        @keyframes hero-fade-up {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes mockup-rise {
          from { opacity: 0; transform: translateY(48px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </section>
  );
}
