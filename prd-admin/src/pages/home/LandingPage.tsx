import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { HeroSection, HERO_GRADIENT, HERO_GRADIENT_FG, HERO_GRADIENT_STOPS } from './sections/HeroSection';
import { StatsStrip } from './sections/StatsStrip';
import { MinimalFooter } from './sections/MinimalFooter';
import { LiteraryScene } from './scenes/LiteraryScene';
import { KnowledgeScene } from './scenes/KnowledgeScene';
import { LayersScene } from './scenes/LayersScene';
import { RosterScene } from './scenes/RosterScene';
import { ModelLayerScene } from './scenes/ModelLayerScene';
import { StartScene } from './scenes/StartScene';
import { StaticBackdrop } from './components/StaticBackdrop';
import { LanguageToggle } from './components/LanguageToggle';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';

/**
 * LandingPage — 米多 Agent 平台 /home
 *
 * 结构（八幕）：
 *   1 · Hero（第一屏就是视觉创作工作台——本系统的核心，不是通用对话壳）
 *   2 · StatsStrip
 *   3 · LiteraryScene    ← 文学创作：左文右图，可切风格
 *   4 · KnowledgeScene   ← 知识库：三栏阅读器 + 划词浮层 + 知识星系
 *   5 · LayersScene      ← 三层一体：MAP / LLMGW / CDS 各一块真实界面切片
 *   6 · RosterScene      ← Agent 全家福：百宝箱真实注册表，搜一下就筛
 *   7 · ModelLayerScene  ← 模型这一层：LLMGW 模型池，成员坏了自动换人
 *   8 · StartScene       ← 三步开始 + 三端 + 收口
 *   9 · MinimalFooter
 *
 * 3~8 幕都在 `scenes/`，共用同一套语言：照真实产品面板复刻 + 节拍驱动 + 旁白。
 *
 * 尾部原有九幕（六段 Agent 深潜 / 工作流 / 片花 / 三步 / Agent 网格 / 兼容栈 /
 * 社区脉搏 / 桌面下载 / FinalCta）已由 6~8 幕取代。那九幕是另一套语言：抽象色块、
 * logo 墙、Coming soon 占位、硬编码假数据，和前面接不上；其中六段深潜的头两段
 * 讲的还是 1、3 两幕已经用真实面板讲过的视觉与文学。
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
  const handleWatchDemo = () => {
    document.getElementById('cinema')?.scrollIntoView({ behavior: 'smooth' });
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
      {/* 静态背景 */}
      <StaticBackdrop />

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
        <KnowledgeScene />
      </div>

      <div id="pillars" style={BELOW_FOLD_SECTION}>
        <LayersScene />
      </div>

      <div id="agents" style={BELOW_FOLD_SECTION}>
        <RosterScene />
      </div>

      <div id="compat" style={BELOW_FOLD_SECTION}>
        <ModelLayerScene />
      </div>

      <div id="download" style={BELOW_FOLD_SECTION}>
        <StartScene onGetStarted={handleGetStarted} />
      </div>

      <MinimalFooter />
    </div>
  );
}
