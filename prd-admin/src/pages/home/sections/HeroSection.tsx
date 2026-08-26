import { ArrowRight, Play, Sparkles } from 'lucide-react';
import { InkOrb } from '@/components/backgrounds/InkOrb';
import { cn } from '@/lib/cn';
import { Reveal } from '../components/Reveal';
import { VisualCanvasStage } from '../scenes/VisualCanvasScene';
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
 *   · Hero 主标题辉光为静态 text-shadow —— 禁止改回无限循环的
 *     text-shadow / box-shadow 动画（绘制属性逐帧重绘，实测导致整页卡顿）
 */
/**
 * 品牌主渐变（SSOT）：登录 CTA / 落地页 CTA / Arena 主按钮共用。
 * 陶土同族色（对齐应用内 --accent-primary #D97757），取代早期青→紫→玫红
 * 三色霓虹——邻近色相保证"彩而不乱"，与登录后的工作台观感统一。
 */
/**
 * 品牌渐变的三档色标（SSOT 的 SSOT）。
 *
 * CSS 渐变、SVG `<stop>` 都从这里取——这条渐变已经被手抄过三份（页脚徽标、
 * 产品预览发送键、导航 Logo），每一份都各自漂移、各自配错前景色。
 * 想用它就 import，不要再抄一遍色值。
 */
/**
 * 墨滴的两支色：鼓起来的地方走品牌赭红，凹下去的地方走钢青。
 * 和 HERO_GRADIENT_STOPS 同源不同用途 —— 那三支是按钮/文字的实心渐变，这两支是 3D 的光。
 */
export const HERO_ORB_COLORS: [string, string] = ['#D97757', '#6AB6D2'];

export const HERO_GRADIENT_STOPS = ['#CE6B41', '#D97757', '#E0A06B'] as const;
export const HERO_GRADIENT = `linear-gradient(135deg, ${HERO_GRADIENT_STOPS[0]} 0%, ${HERO_GRADIENT_STOPS[1]} 48%, ${HERO_GRADIENT_STOPS[2]} 100%)`;
/**
 * 铺在 HERO_GRADIENT 上的文字色。
 *
 * 这条渐变对白字只有 2.23~3.62:1（越往右越亮越糟），13-15px 的主 CTA 标签一律不达标。
 * 陶土底配深墨字才是这套配色的正解，三档分别 4.74 / 5.49 / 7.68:1；起点 #C8623A
 * 抬到 #CE6B41 就是为了让最暗那档也过 4.5。
 *
 * 直接复用 --button-primary-fg（暗浅两主题同为深墨），而不是再写一个深色 hex：
 * 主操作面的文字色只该有一个来源，多一个就多一处会各自漂移的判据。
 * 守卫：themeSystem 逐档算「渐变色标 x 两主题的 button-primary-fg」是否过 4.5，
 * inkPalette 拦「HERO_GRADIENT 当底再配浅色字」。
 */
export const HERO_GRADIENT_FG = 'var(--button-primary-fg)';
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

      {/* Synthwave 地平线光带（Hero 底部 · 品牌同族色：紫罗兰 → 冷白 → 长春花蓝）*/}
      <div
        className="absolute inset-x-0 pointer-events-none"
        style={{
          top: '72vh',
          height: '2px',
          background:
            'linear-gradient(90deg, transparent 0%, rgba(200, 98, 58, 0.5) 30%, rgba(226, 232, 240, 0.9) 50%, rgba(224, 160, 107, 0.55) 70%, transparent 100%)',
          boxShadow:
            '0 0 28px rgba(226, 232, 240, 0.5), 0 -1px 40px rgba(200, 98, 58, 0.3)',
        }}
      />

      {/* 合成太阳半圆 · 品牌同族色 */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: '72vh',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'clamp(360px, 34vw, 560px)',
          height: 'clamp(360px, 34vw, 560px)',
          background:
            'radial-gradient(circle at center, rgba(200, 98, 58, 0.30) 0%, rgba(203, 213, 225, 0.15) 35%, rgba(224, 160, 107, 0.06) 60%, transparent 75%)',
          filter: 'blur(6px)',
        }}
      />

      {/* Tron 透视地板（冷白 + 长春花蓝双向 grid）*/}
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
                rgba(217, 119, 87, 0.30) 43px,
                rgba(217, 119, 87, 0.30) 44px
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
      {/*
        * 版式：左文右物的不对称两栏，不再是居中堆叠。
        *
        * 原来 badge / 大标题 / 副标题 / 两个按钮 / logo 墙全部居中竖着摞 —— 那是 2015 年的
        * SaaS 模板骨架，配什么字体、什么颜色都救不回来，用户的评价是"单调、丑陋"。
        * 换成两栏之后右边空出一块，正好给那颗会呼吸的墨滴 —— 整页第一个能转的实体。
        */}
      <div
        className="relative z-10 min-h-[82vh] flex flex-col justify-center px-6 pt-32 pb-16"
      >
        <div className="w-full max-w-[1280px] mx-auto grid lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] gap-8 lg:gap-14 items-center">
        <div className="flex flex-col items-start">
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
            className="inline-flex items-center gap-3 px-4 py-2 mb-9 rounded-md"
            style={{
              background: 'rgba(10, 14, 22, 0.72)',
              border: '1px solid rgba(203, 213, 225, 0.22)',
              boxShadow:
                '0 0 28px rgba(148, 163, 184, 0.18), inset 0 0 14px rgba(148, 163, 184, 0.05)',
              fontFamily: 'var(--font-terminal)',
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
            <span className="w-px h-3.5 bg-token-nested" />
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
            className="font-medium"
            style={{
              fontFamily: 'var(--font-display)',
              // 从 7.5vw / 6.5rem 收下来：现在只占左半栏，原尺寸会把两栏挤散
              fontSize: 'clamp(2.6rem, 5.2vw, 4.7rem)',
              lineHeight: 1.08,
              letterSpacing: '-0.035em',
              maxWidth: '16ch',
              // 白 → 暖砂的纵向渐隐（Linear 式标题处理）：比纯白平涂多一层精致感。
              // 原来收在一支色相 233 的长春花蓝（靛色区）——那是换笔前留下的尾巴，
              // 门头最大的一块字反倒还是冷的，与整页暖石墨打架。
              // 色值不写进注释：守卫连注释一起扫，把禁色写在这儿等于给下一个人留种子。
              background: 'linear-gradient(180deg, #FFFFFF 0%, #FBF0E7 55%, #E7C3A8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              // 静态辉光：渐变裁切文字下 text-shadow 会透过透明字形发浑，
              // 改用 drop-shadow（按实际像素投影）。保持静态常量，禁止无限循环
              // 动画（绘制属性逐帧重绘是整页滚动卡顿的头号来源）。
              filter:
                'drop-shadow(0 0 34px rgba(232, 221, 213, 0.28)) drop-shadow(0 0 90px rgba(224, 160, 107, 0.22))',
            }}
          >
            {t.hero.title}
          </h1>
        </Reveal>

        {/* 副标题 — 标题已可读时加入（标题还在散雾），2s duration */}
        {/* 容器放宽到 max-w-3xl、字号收到 clamp(13.6,0.95vw,16px)，承载 100 字中文定义 */}
        <Reveal delay={500} duration={2000} offset={20}>
          <p
            className="mt-7 text-white/62 max-w-xl"
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 'clamp(0.85rem, 0.95vw, 1rem)',
              letterSpacing: '0.01em',
              lineHeight: 1.9,
            }}
          >
            {t.hero.subtitle}
          </p>
        </Reveal>

        {/* CTA — 和副标题同时出发，2s duration */}
        <Reveal delay={500} duration={2000} offset={20}>
          <div className="mt-10 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            {/* 主 CTA */}
            <button
              onClick={onGetStarted}
              className="group relative inline-flex items-center gap-2.5 h-12 px-8 rounded-full font-medium text-[14.5px] transition-all duration-200 hover:scale-[1.03] active:scale-[0.98]"
              style={{
                background: HERO_GRADIENT,
                color: HERO_GRADIENT_FG,
                boxShadow:
                  '0 0 48px rgba(217, 119, 87, 0.35), 0 0 100px rgba(224, 160, 107, 0.18), 0 10px 32px rgba(0, 0, 0, 0.5)',
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

        </div>

        {/*
          * 右栏：那颗墨滴。lg 以下整块不渲染 —— 它是全页最贵的一个 WebGL 上下文，
          * 而手机正是最不该付这笔钱的地方；墨场背景在手机上仍然在。
          */}
        <div className="relative hidden lg:block" style={{ aspectRatio: '1 / 1' }}>
          <InkOrb className="absolute inset-0" colors={HERO_ORB_COLORS} amplitude={0.22} />
        </div>
        </div>

        {/* ── Phase 2 · Powered by — 装饰性，独占一行压在两栏底下 ── */}
        <Reveal delay={1400} duration={2000} offset={6}>
          <div className="mt-16 md:mt-20 w-full max-w-[1280px] mx-auto">
            <TechLogoBar />
          </div>
        </Reveal>
      </div>

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
