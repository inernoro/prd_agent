import { ArrowRight, Play, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ProductMockup } from '../components/ProductMockup';
import { Reveal } from '../components/Reveal';
import { TechLogoBar } from '../components/TechLogoBar';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Hero — Linear.app × Retro-Futurism 融合
 *
 * 修正记录：
 *   · synthwave 地平线/太阳/Tron 地板从 StaticBackdrop 搬到 Hero 本地，避免
 *     fixed 中部亮带穿透后续 section 产生"银色光带"伪影
 *   · CTA 重做为对称两颗（主实 pill + 次对称 outline pill，同高同 radius）
 *   · 所有进入视口元素走 Reveal 组件做 fade-up 滚动动效
 *   · Hero 主标题接入 ambient neon pulse（极慢呼吸发光）
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
  const { t } = useLanguage();
  return (
    <section
      className={cn('relative overflow-hidden', className)}
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* ── Hero 本地 retro 装饰（只影响 Hero 自己，不会穿透后续 section） ── */}

      {/* Synthwave 地平线光带（Hero 底部 · 去紫版：玫瑰 → 冷白 → 青）*/}
      <div
        className="absolute inset-x-0 pointer-events-none"
        style={{
          top: '72vh',
          height: '2px',
          background:
            'linear-gradient(90deg, transparent 0%, rgba(244, 63, 94, 0.5) 30%, rgba(226, 232, 240, 0.9) 50%, rgba(0, 240, 255, 0.5) 70%, transparent 100%)',
          boxShadow:
            '0 0 28px rgba(226, 232, 240, 0.5), 0 -1px 40px rgba(244, 63, 94, 0.3)',
        }}
      />

      {/* 合成太阳半圆 · 去紫版 */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: '72vh',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'clamp(360px, 34vw, 560px)',
          height: 'clamp(360px, 34vw, 560px)',
          background:
            'radial-gradient(circle at center, rgba(244, 63, 94, 0.32) 0%, rgba(203, 213, 225, 0.15) 35%, rgba(0, 240, 255, 0.05) 60%, transparent 75%)',
          filter: 'blur(6px)',
        }}
      />

      {/* Tron 透视地板 · 去紫版（冷白 + 青双向 grid）*/}
      <div
        className="absolute inset-x-0 pointer-events-none"
        style={{
          top: '72vh',
          bottom: '0',
          perspective: '420px',
          perspectiveOrigin: '50% 0%',
        }}
      >
        <div
          className="absolute inset-x-[-35%] top-0 bottom-0"
          style={{
            background: `
              repeating-linear-gradient(
                180deg,
                transparent 0,
                transparent 43px,
                rgba(203, 213, 225, 0.38) 43px,
                rgba(203, 213, 225, 0.38) 44px
              ),
              repeating-linear-gradient(
                90deg,
                transparent 0,
                transparent 43px,
                rgba(0, 240, 255, 0.38) 43px,
                rgba(0, 240, 255, 0.38) 44px
              )
            `,
            transform: 'rotateX(62deg)',
            transformOrigin: '50% 0%',
            maskImage:
              'linear-gradient(180deg, transparent 0%, black 38%, black 100%)',
            WebkitMaskImage:
              'linear-gradient(180deg, transparent 0%, black 38%, black 100%)',
          }}
        />
      </div>

      {/* ── 第一屏内容（居中标题 + CTA） ── */}
      <div
        className="relative z-10 min-h-[82vh] flex flex-col items-center justify-center px-6 pt-32 pb-16"
      >
        {/*
         * 呼吸设计 — 学习 Linear.app 的节奏
         *
         * 秘诀："出现得很快，雾散得很慢"
         * · 极端 ease-out 曲线 (0.19,1,0.22,1) → 前 15% 时间到达 85% 可见
         * · 超长 duration（标题 4s）→ 最后 15% 的模糊慢慢散开，营造深度
         * · 标题还在散雾时，副标题和 CTA 已经开始出现 → 层次交叠
         *
         * Phase 1 · 核心信息            delay=0~500ms, duration=2~4s
         * Phase 2 · 装饰               delay=1200ms+
         * Phase 3 · 产品 Mockup        delay=1800ms+
         */}

        {/* ── Phase 2 · HUD 状态条 — 装饰性，比核心信息晚出 ── */}
        <Reveal delay={1200} duration={2000} offset={6}>
          <div
            className="inline-flex items-center gap-3 px-4 py-2 mb-12 rounded-md"
            style={{
              background: 'rgba(10, 14, 22, 0.72)',
              border: '1px solid rgba(203, 213, 225, 0.22)',
              boxShadow:
                '0 0 28px rgba(148, 163, 184, 0.18), inset 0 0 14px rgba(148, 163, 184, 0.05)',
              fontFamily: 'var(--font-terminal)',
              animation: 'hud-pulse 4s ease-in-out infinite',
            }}
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70" />
              <span
                className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"
                style={{ boxShadow: '0 0 10px #34d399' }}
              />
            </span>
            <span
              className="text-[14px] text-emerald-300"
              style={{
                letterSpacing: '0.14em',
                textShadow: '0 0 8px rgba(52, 211, 153, 0.6)',
              }}
            >
              {t.hero.status}
            </span>
            <span className="w-px h-3.5 bg-white/15" />
            <span
              className="text-[14px] text-slate-200"
              style={{
                letterSpacing: '0.14em',
                textShadow: '0 0 10px rgba(203, 213, 225, 0.5)',
              }}
            >
              {t.hero.brand}
            </span>
          </div>
        </Reveal>

        {/* ── Phase 1 · 核心信息 ── */}
        {/* ★ 主标题 — 4s duration，前 600ms 可读，后 3.4s 雾慢慢散 */}
        <Reveal delay={0} blur={10} duration={4000} offset={30}>
          <h1
            className="text-center text-white font-medium"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(2.75rem, 7.5vw, 6.5rem)',
              lineHeight: 1.02,
              letterSpacing: '-0.035em',
              maxWidth: '16ch',
              animation: 'hero-title-pulse 5s ease-in-out infinite',
            }}
          >
            {t.hero.title}
          </h1>
        </Reveal>

        {/* 副标题 — 标题已可读时加入（标题还在散雾），2s duration */}
        {/* 容器放宽到 max-w-3xl、字号收到 clamp(13.6,0.95vw,16px)，承载 100 字中文定义 */}
        <Reveal delay={500} duration={2000} offset={20}>
          <p
            className="mt-8 text-center text-white/62 max-w-3xl mx-auto leading-relaxed"
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 'clamp(0.85rem, 0.95vw, 1rem)',
              letterSpacing: '0.005em',
            }}
          >
            {t.hero.subtitle}
          </p>
        </Reveal>

        {/* CTA — 和副标题同时出发，2s duration */}
        <Reveal delay={500} duration={2000} offset={20}>
          <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
            {/* 主 CTA */}
            <button
              onClick={onGetStarted}
              className="group relative inline-flex items-center gap-2.5 h-12 px-8 rounded-full font-medium text-[14.5px] text-white transition-all duration-200 hover:scale-[1.03] active:scale-[0.98]"
              style={{
                background: HERO_GRADIENT,
                boxShadow:
                  '0 0 48px rgba(124, 58, 237, 0.35), 0 0 100px rgba(0, 240, 255, 0.2), 0 10px 32px rgba(0, 0, 0, 0.5)',
                letterSpacing: '0.01em',
                fontFamily: 'var(--font-display)',
              }}
            >
              <Sparkles className="w-4 h-4" />
              <span>{t.hero.primaryCta}</span>
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </button>

            {/* 次 CTA —— 对称 outline pill，hover 冷白高亮（去紫）*/}
            <button
              onClick={onWatchDemo}
              className="group inline-flex items-center gap-2.5 h-12 px-8 rounded-full text-[14.5px] font-medium text-white/90 transition-all duration-200 hover:text-white hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                letterSpacing: '0.01em',
                fontFamily: 'var(--font-display)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(203, 213, 225, 0.5)';
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.18)';
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
              }}
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{t.hero.secondaryCta}</span>
              <ArrowRight className="w-4 h-4 opacity-60 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </Reveal>

        {/* ── Phase 2 · Powered by — 装饰性 ── */}
        <Reveal delay={1400} duration={2000} offset={6}>
          <div className="mt-20 md:mt-24 w-full">
            <TechLogoBar />
          </div>
        </Reveal>
      </div>

      {/* ── Phase 3 · 产品壳 mockup — 核心信息就位后，视觉证据最后浮出 ── */}
      <Reveal delay={1800} offset={60} blur={6} duration={3000}>
        <div className="relative z-10 pb-32 md:pb-40 px-4 md:px-8">
          <ProductMockup />
        </div>
      </Reveal>

      <style>{`
        @keyframes hero-title-pulse {
          0%, 100% {
            text-shadow:
              0 0 30px rgba(203, 213, 225, 0.32),
              0 0 90px rgba(0, 240, 255, 0.22),
              0 0 140px rgba(59, 130, 246, 0.12);
          }
          50% {
            text-shadow:
              0 0 40px rgba(226, 232, 240, 0.45),
              0 0 110px rgba(0, 240, 255, 0.30),
              0 0 160px rgba(59, 130, 246, 0.18);
          }
        }
        @keyframes hud-pulse {
          0%, 100% {
            box-shadow:
              0 0 28px rgba(148, 163, 184, 0.18),
              inset 0 0 14px rgba(148, 163, 184, 0.05);
          }
          50% {
            box-shadow:
              0 0 38px rgba(203, 213, 225, 0.28),
              inset 0 0 20px rgba(203, 213, 225, 0.08);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          h1, [style*="hud-pulse"] { animation: none !important; }
        }
      `}</style>
    </section>
  );
}
