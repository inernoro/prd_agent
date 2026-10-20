import { cn } from '@/lib/cn';
import { Reveal } from '../components/Reveal';
import { VisualCanvasStage } from '../scenes/VisualCanvasScene';
import { TechLogoBar } from '../components/TechLogoBar';
import { useLanguage } from '../contexts/LanguageContext';
import { HeroStage } from './HeroStage';

/**
 * Hero —— 第一屏（HeroStage：满屏无字循环 + 标题 + 输入框）+ Powered by + 视觉创作工作台。
 *
 * 修正记录：
 *   · 2026-09-29 第一屏改为满屏循环（借可灵首屏的结构），撤掉左文右墨滴两栏与
 *     地平线 / 合成太阳 / 透视地板三层装饰，次 CTA 由右下角「观看完整片花」取代
 *   · 所有进入视口元素走 Reveal 组件做 fade-up 滚动动效
 *   · 禁止给标题加无限循环的 text-shadow / box-shadow 动画（绘制属性逐帧重绘，实测导致整页卡顿）
 */
// 品牌渐变的 SSOT 在 ./heroGradient（独立成文件是为了断开循环引用：片花调色板要取这组色标，
// 而本文件又要引用首屏组件 HeroStage → 片花调色板）。这里原样转出，调用方不用改。
export { HERO_GRADIENT, HERO_GRADIENT_FG, HERO_GRADIENT_STOPS, HERO_GRADIENT_TEXT } from './heroGradient';

interface HeroSectionProps {
  className?: string;
  onGetStarted?: () => void;
}

export function HeroSection({ className, onGetStarted }: HeroSectionProps) {
  const { t } = useLanguage();
  return (
    <section
      className={cn('relative overflow-hidden', className)}
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/*
        * 第一屏：满屏无字循环（HeroStage）。
        *
        * 2026-09-29 按可灵首屏的结构重做：背景就是作品本身，输入框里写着生成它的那句话，
        * 声音交给用户开。原来的左文右墨滴两栏、地平线 / 合成太阳 / 透视地板三层装饰一并撤掉——
        * 满屏画面之上再叠这些，两层动画抢眼，低端机也多起一个 WebGL 上下文。
        */}
      <HeroStage onGetStarted={onGetStarted} />

      {/* ── Powered by — 压在第一屏底下 ── */}
      <Reveal delay={200} duration={2000} offset={6}>
        <div className="relative z-10 pt-14 md:pt-16 px-6 w-full max-w-[1280px] mx-auto">
          <TechLogoBar />
        </div>
      </Reveal>

      {/* ── Phase 3 · 第一屏的产品证据：视觉创作工作台 ──
          这里原来是一个通用的「对话壳」mockup，任何 AI 产品都能套。
          换成照真实面板复刻、还能点的视觉创作画布：第一屏必须是本系统的核心，
          而不是一张谁都能画的示意图。
          不带 blur：对 ~1000px 宽的大块做 3s 滤镜动画 = 大面积逐帧重绘，只保留 fade + rise */}
      <Reveal delay={1800} offset={60} duration={3000}>
        <div className="relative z-10 pb-20 md:pb-28 px-4 md:px-8">
          <div className="max-w-[1280px] mx-auto">
            <div className="flex flex-col lg:flex-row lg:items-end gap-4 lg:gap-10 mb-5">
              <div className="shrink-0">
                <div
                  className="flex items-center gap-2 uppercase text-white/42"
                  style={{ fontFamily: 'var(--font-terminal)', fontSize: '15px', letterSpacing: '0.18em' }}
                >
                  <span
                    className="block w-[5px] h-[5px] rounded-full shrink-0"
                    style={{ background: 'hsl(16 54% 62%)' }}
                  />
                  {t.scenes.visual.eyebrow}
                </div>
                <h2
                  className="mt-2.5 font-medium text-white"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.6rem, 2.8vw, 2.1rem)',
                    lineHeight: 1.34,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {t.scenes.visual.title}
                </h2>
              </div>
              <p
                className="text-white/62 lg:pb-1.5"
                style={{ fontSize: '13.5px', lineHeight: 1.8, maxWidth: '29em' }}
              >
                {t.scenes.visual.description}
              </p>
            </div>
            <VisualCanvasStage />
          </div>
        </div>
      </Reveal>
    </section>
  );
}
