import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { HeroSection, HERO_GRADIENT, HERO_GRADIENT_FG, HERO_GRADIENT_STOPS } from './sections/HeroSection';
import { StatsStrip } from './sections/StatsStrip';
import { MinimalFooter } from './sections/MinimalFooter';
import { LiteraryScene } from './scenes/LiteraryScene';
import { KnowledgeScene } from './scenes/KnowledgeScene';
import { LayersScene } from './scenes/LayersScene';
import { ToolboxScene } from './scenes/ToolboxScene';
import { WorkflowScene } from './scenes/WorkflowScene';
import { VocScene } from './scenes/VocScene';
import { ModelLayerScene } from './scenes/ModelLayerScene';
import { CdsScene } from './scenes/CdsScene';
import { Interlude } from './components/Interlude';
import { SCENE_HUE } from './scenes/sceneTokens';
import { StartScene } from './scenes/StartScene';
import { StaticBackdrop } from './components/StaticBackdrop';
import { InkFieldBackdrop } from '@/components/backgrounds/InkFieldBackdrop';
import { LanguageToggle } from './components/LanguageToggle';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';

/**
 * LandingPage — 米多 Agent 平台 /home
 *
 * 结构（十幕）：
 *   1 · Hero（第一屏就是视觉创作工作台——本系统的核心，不是通用对话壳）
 *   2 · StatsStrip
 *   3 · LiteraryScene    ← 文学创作 `/literary-agent`：左文右图，可切风格
 *   4 · KnowledgeScene   ← 知识库 `/document-store`：三栏阅读器 + 划词浮层 + 知识星系
 *   5 · LayersScene      ← 三层一体：MAP / LLMGW / CDS 各一块真实界面切片
 *   6 · ToolboxScene     ← 百宝箱 `/ai-toolbox`：真实控制条 + 注册表，搜一下就筛
 *   7 · WorkflowScene    ← 工作流 `/workflow-agent`：舱库 + 真实模板链，跑给你看
 *   8 · VocScene         ← 体验地图 `/team-activity`：treemap，痛点自己跳出来
 *   9 · ModelLayerScene  ← 模型池 LLMGW `/pools`：成员顺位，坏了自动顶上
 *  10 · CdsScene         ← CDS 分支页 + 部署记录：分支即环境，push 是唯一那一步
 *  11 · StartScene       ← 三步开始 + 三端 + 收口
 *  12 · MinimalFooter
 *
 * 3~9 幕共用同一条纪律：**每一幕都照一张真实存在的页面画缩微版**，页面路径写在
 * 各自组件的头注释里。用户对上一版尾部的原话是「样式不错，但是不够真实，首先得
 * 需要我们的真实页面」——所以 6~9 幕逐个换成了百宝箱、工作流、体验地图、模型池
 * 这四张真页面，而不是自造的卡片墙与四列表。
 *
 * ## 节奏表（每一幕的 variant）
 *
 *   文学 default → 知识库 flip → 三层一体 wide → 【换气 1】
 *   百宝箱 default → 工作流 flip → 体验地图 wide → 【换气 2】
 *   模型池 default → CDS stage（高潮）→ 从这里开始 default
 *
 * 三拍一循环（基准 / 反拍 / 全景），两次换气，一次居中放大的高潮。
 * 这张表就是这一页的律动 —— 改任何一幕的 variant 之前先看整列，别只看它自己：
 * 九幕全是 default 正是用户说「太单调」的那一版。
 *
 * 层次与阻尼由 `components/scrollRhythm.ts` 统一驱动：一个 rAF 循环，
 * 引言往上飘、面板往下沉、换气页最深，面板另带滞后回弹。
 *
 * 背景：StaticBackdrop 纯 CSS 静态层。
 * 国际化：LanguageProvider 仅作用于本页（中 / EN 切换器在顶栏右上角）。
 */

function MapLogo({ className = 'w-10 h-10' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="brandGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          {/* 色标从 HERO_GRADIENT_STOPS 取：这里原是第三份手抄副本，起点漂成旧值 */}
          {HERO_GRADIENT_STOPS.map((stopColor, index) => (
            <stop key={stopColor} offset={`${index * 50}%`} style={{ stopColor, stopOpacity: 1 }} />
          ))}
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="512" height="512" rx="102" ry="102" fill="url(#brandGradient)" />
      <text
        x="256"
        y="268"
        fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
        fontSize="190"
        fontWeight="900"
        textAnchor="middle"
        dominantBaseline="middle"
        style={{ fill: HERO_GRADIENT_FG }}
        letterSpacing="-6"
      >
        MAP
      </text>
    </svg>
  );
}

/**
 * 墨场的三支色：陶土 / 钢青 / 松绿（前两支是主体，第三支只做稀有点缀），取自八色墨带（`lib/tileAccent.ts` 的 INK_HUES
 * 在 54%/62% 档的实心值）。写在这里而不是组件里，是为了让色值留在受 no-purple
 * 守卫扫描的 `pages/home` 这一侧 —— 哪天有人改成靛蓝，CI 当场就红。
 */
const INK_FIELD_COLORS: [string, string, string] = ['#D38669', '#6AB6D2', '#6AD2A2'];

/** 首屏之下区块的渲染跳过策略：离视口远时不渲染（含内部动画），滚近时自动补渲染 */
const BELOW_FOLD_SECTION: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 720px',
};

export default function LandingPage() {
  return (
    <LanguageProvider>
      <LandingInner />
    </LanguageProvider>
  );
}

function LandingInner() {
  const navigate = useNavigate();
  const { t, lang } = useLanguage();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleGetStarted = () => navigate('/login');
  /*
   * 次 CTA 原来滚到 #cinema —— 那一幕（片花，Coming soon 占位）早就撤了，
   * 于是这颗按钮点下去什么都不发生，一直是个死链。改成滚到第一幕真面板。
   */
  const handleWatchDemo = () => {
    document.getElementById('literary')?.scrollIntoView({ behavior: 'smooth' });
  };

  /*
   * 导航锚点必须落在真实存在的幕上。
   * 「产品」原来指 #features，点下去落在 y≈4834px，把前面四幕整段跳过（验收 D2）；
   * 「片花」「社区」指向的两幕已撤下（一个是 Coming soon 占位，一个是硬编码假数据），
   * 留着就是死锚点。
   */
  const navLinks = [
    { label: t.nav.products, href: '#literary' },
    { label: t.nav.agents, href: '#agents' },
    { label: t.nav.workflow, href: '#workflow' },
    { label: t.nav.models, href: '#compat' },
    { label: t.nav.download, href: '#download' },
    { label: t.nav.docs, href: 'https://github.com/inernoro/prd_agent', external: true },
  ];

  return (
    <div
      className="min-h-screen bg-[#0E0C0A] text-token-primary overflow-x-hidden"
      style={{ scrollBehavior: 'smooth', fontFamily: 'var(--font-body)' }}
      data-lang={lang}
    >
      {/*
        * 背景两层：
        *   1 StaticBackdrop —— 纯 CSS 底色 + 点阵 + 噪点，零 JS。它同时是降级形态：
        *     拿不到 WebGL 时上面那层什么都不画，页面回到改版前的样子，不会开天窗。
        *   2 InkFieldBackdrop —— 墨在水里散开的 WebGL 流场，跟指针有极轻的互动。
        * 只有一层静态 CSS 是这页「平」的根因：十幕内容压在一块死黑板上。
        */}
      <StaticBackdrop />
      <InkFieldBackdrop
        className="fixed inset-0 z-0 pointer-events-none"
        colors={INK_FIELD_COLORS}
        intensity={0.30}
      />

      {/* 顶栏 */}
      <nav className="fixed top-0 left-0 right-0 z-50">
        <div
          className="mx-auto px-6 py-4"
          style={{
            // 素色材质下 blur 被全局清除：渐变主体加深，导航文字不再靠 blur 才能压住滚动内容
            background:
              'linear-gradient(180deg, rgba(14,12,10,0.94) 0%, rgba(14,12,10,0.72) 70%, rgba(14,12,10,0) 100%)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-4">
            {/* Logo —— 品牌文字只在 xl+ 显示（英文品牌长，避免溢出）*/}
            <div className="flex items-center gap-3 shrink-0">
              <MapLogo className="w-9 h-9 rounded-[10px]" />
              <span
                className="text-[15px] font-medium text-token-primary hidden xl:inline"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em' }}
              >
                {t.footer.brand}
              </span>
            </div>

            {/* Desktop nav —— gap 紧一点 + 允许 flex-wrap ban */}
            <div className="hidden md:flex items-center gap-5 lg:gap-7 shrink-0">
              {navLinks.map((item, i) => (
                <a
                  key={i}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  className="text-[13px] text-token-secondary hover:text-token-primary transition-colors whitespace-nowrap"
                  style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
                >
                  {item.label}
                </a>
              ))}
            </div>

            {/* 右上角：语言切换 + 登录 + 移动 hamburger */}
            <div className="flex items-center gap-3">
              <LanguageToggle />

              <button
                onClick={handleGetStarted}
                className="px-4 py-2 rounded-full text-[13px] font-medium transition-all duration-200 hover:scale-[1.02]"
                style={{
                  background: HERO_GRADIENT,
                  color: HERO_GRADIENT_FG,
                  boxShadow: '0 0 20px rgba(217, 119, 87, 0.32)',
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '0.01em',
                }}
              >
                {t.nav.login}
              </button>

              <button
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg text-token-secondary hover:text-token-primary hover-bg-soft transition-colors"
                aria-label="Open menu"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* 移动导航 overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[100] md:hidden">
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md" onClick={() => setMobileMenuOpen(false)} />
          <div className="absolute inset-x-0 top-0 bg-[#141210]/96 backdrop-blur-xl border-b border-token-subtle animate-[landingMenuIn_0.2s_ease-out]">
            <style>{`@keyframes landingMenuIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`}</style>
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-3">
                <MapLogo className="w-9 h-9 rounded-[10px]" />
                <span className="text-[15px] font-medium text-token-primary" style={{ fontFamily: 'var(--font-display)' }}>
                  {t.footer.brand}
                </span>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-token-secondary hover:text-token-primary hover-bg-soft transition-colors"
                aria-label="Close menu"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="px-6 pb-6 space-y-1">
              {navLinks.map((item, i) => (
                <a
                  key={i}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-4 py-3 rounded-xl text-[15px] text-token-secondary hover:text-token-primary hover-bg-soft transition-colors"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {item.label}
                </a>
              ))}

              <div className="pt-4 flex items-center justify-between gap-3">
                <LanguageToggle />
              </div>

              <div className="pt-4">
                <button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    handleGetStarted();
                  }}
                  className="w-full py-3 rounded-full text-[15px] font-medium transition-all hover:opacity-90"
                  style={{
                    background: HERO_GRADIENT,
                    color: HERO_GRADIENT_FG,
                    boxShadow: '0 0 20px rgba(217, 119, 87, 0.32)',
                    fontFamily: 'var(--font-display)',
                  }}
                >
                  {t.nav.login}
                </button>
              </div>
            </nav>
          </div>
        </div>
      )}

      {/* 十一幕内容 —— 首屏之下的每一幕都挂 content-visibility:auto：
          屏外区块跳过渲染与内部无限动画的绘制（13 幕全常驻渲染是滚动卡顿主因之一）。
          containIntrinsicSize 提供占位高度估值，避免滚动条跳动。 */}
      <div id="hero">
        <HeroSection onGetStarted={handleGetStarted} onWatchDemo={handleWatchDemo} />
      </div>

      <div id="stats" style={BELOW_FOLD_SECTION}>
        <StatsStrip />
      </div>

      <div id="literary" style={BELOW_FOLD_SECTION}>
        <LiteraryScene />
      </div>

      <div id="knowledge" style={BELOW_FOLD_SECTION}>
        <KnowledgeScene variant="flip" />
      </div>

      <div id="pillars" style={BELOW_FOLD_SECTION}>
        <LayersScene variant="wide" />
      </div>

      <div style={BELOW_FOLD_SECTION}>
        <Interlude hue={SCENE_HUE.amber} {...t.interludes[0]} />
      </div>

      <div id="agents" style={BELOW_FOLD_SECTION}>
        <ToolboxScene />
      </div>

      <div id="workflow" style={BELOW_FOLD_SECTION}>
        <WorkflowScene variant="flip" />
      </div>

      <div id="voc" style={BELOW_FOLD_SECTION}>
        <VocScene variant="wide" />
      </div>

      <div style={BELOW_FOLD_SECTION}>
        <Interlude hue={SCENE_HUE.steel} {...t.interludes[1]} />
      </div>

      <div id="compat" style={BELOW_FOLD_SECTION}>
        <ModelLayerScene />
      </div>

      <div id="cds" style={BELOW_FOLD_SECTION}>
        <CdsScene variant="stage" />
      </div>

      <div id="download" style={BELOW_FOLD_SECTION}>
        <StartScene onGetStarted={handleGetStarted} />
      </div>

      <MinimalFooter />
    </div>
  );
}
