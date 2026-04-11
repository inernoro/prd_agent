import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { HeroSection, HERO_GRADIENT } from './sections/HeroSection';
import { StatsStrip } from './sections/StatsStrip';
import { ThreePillars } from './sections/ThreePillars';
import { FeatureDeepDive } from './sections/FeatureDeepDive';
import { SignatureCinema } from './sections/SignatureCinema';
import { HowItWorks } from './sections/HowItWorks';
import { AgentGrid } from './sections/AgentGrid';
import { CompatibilityStack } from './sections/CompatibilityStack';
import { CommunityPulse } from './sections/CommunityPulse';
import { DesktopDownload } from './sections/DesktopDownload';
import { FinalCta } from './sections/FinalCta';
import { MinimalFooter } from './sections/MinimalFooter';
import { StaticBackdrop } from './components/StaticBackdrop';
import { LanguageToggle } from './components/LanguageToggle';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';

/**
 * LandingPage — 米多 Agent 平台 /home
 *
 * 十一幕结构（Linear.app × Retro-Futurism 融合）：
 *   1 · Hero
 *   2 · StatsStrip
 *   3 · FeatureDeepDive（六段左右交替，每段内部分步 reveal）
 *   4 · SignatureCinema
 *   5 · HowItWorks
 *   6 · AgentGrid
 *   7 · CompatibilityStack
 *   8 · CommunityPulse
 *   9 · DesktopDownload
 *  10 · FinalCta
 *  11 · MinimalFooter
 *
 * 背景：StaticBackdrop 纯 CSS 静态层。
 * 国际化：LanguageProvider 仅作用于本页（中 / EN 切换器在顶栏右上角）。
 */

function MapLogo({ className = 'w-10 h-10' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="indigoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#00f0ff', stopOpacity: 1 }} />
          <stop offset="50%" style={{ stopColor: '#7c3aed', stopOpacity: 1 }} />
          <stop offset="100%" style={{ stopColor: '#f43f5e', stopOpacity: 1 }} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="512" height="512" rx="102" ry="102" fill="url(#indigoGradient)" />
      <text
        x="256"
        y="268"
        fontFamily="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
        fontSize="190"
        fontWeight="900"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#ffffff"
        letterSpacing="-6"
      >
        MAP
      </text>
    </svg>
  );
}

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
  const handleContact = () => {
    window.open('mailto:contact@miduo.org', '_blank');
  };

  const navLinks = [
    { label: t.nav.products, href: '#features' },
    { label: t.nav.agents, href: '#agents' },
    { label: t.nav.cinema, href: '#cinema' },
    { label: t.nav.community, href: '#pulse' },
    { label: t.nav.download, href: '#download' },
    { label: t.nav.docs, href: 'https://github.com/inernoro/prd_agent', external: true },
  ];

  return (
    <div
      className="min-h-screen bg-[#030306] text-white overflow-x-hidden"
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
            background:
              'linear-gradient(180deg, rgba(3,3,6,0.88) 0%, rgba(3,3,6,0) 100%)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-4">
            {/* Logo —— 品牌文字只在 xl+ 显示（英文品牌长，避免溢出）*/}
            <div className="flex items-center gap-3 shrink-0">
              <MapLogo className="w-9 h-9 rounded-[10px]" />
              <span
                className="text-[15px] font-medium text-white/90 hidden xl:inline"
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
                  className="text-[13px] text-white/55 hover:text-white transition-colors whitespace-nowrap"
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
                className="px-4 py-2 rounded-full text-[13px] font-medium text-white transition-all duration-200 hover:scale-[1.02]"
                style={{
                  background: HERO_GRADIENT,
                  boxShadow: '0 0 20px rgba(124, 58, 237, 0.3)',
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '0.01em',
                }}
              >
                {t.nav.login}
              </button>

              <button
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg text-white/70 hover:text-white hover:bg-white/5 transition-colors"
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
          <div className="absolute inset-x-0 top-0 bg-[#0a0a12]/96 backdrop-blur-xl border-b border-white/10 animate-[landingMenuIn_0.2s_ease-out]">
            <style>{`@keyframes landingMenuIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`}</style>
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-3">
                <MapLogo className="w-9 h-9 rounded-[10px]" />
                <span className="text-[15px] font-medium text-white/90" style={{ fontFamily: 'var(--font-display)' }}>
                  {t.footer.brand}
                </span>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-white/70 hover:text-white hover:bg-white/5 transition-colors"
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
                  className="block px-4 py-3 rounded-xl text-[15px] text-white/70 hover:text-white hover:bg-white/5 transition-colors"
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
                  className="w-full py-3 rounded-full text-[15px] font-medium text-white transition-all hover:opacity-90"
                  style={{
                    background: HERO_GRADIENT,
                    boxShadow: '0 0 20px rgba(124, 58, 237, 0.3)',
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

      {/* 十一幕内容 */}
      <div id="hero">
        <HeroSection onGetStarted={handleGetStarted} onWatchDemo={handleWatchDemo} />
      </div>

      <div id="stats">
        <StatsStrip />
      </div>

      <div id="pillars">
        <ThreePillars />
      </div>

      <div id="features">
        <FeatureDeepDive />
      </div>

      <div id="cinema">
        <SignatureCinema />
      </div>

      <div id="how">
        <HowItWorks />
      </div>

      <div id="agents">
        <AgentGrid />
      </div>

      <div id="compat">
        <CompatibilityStack />
      </div>

      <div id="pulse">
        <CommunityPulse />
      </div>

      <div id="download">
        <DesktopDownload />
      </div>

      <div id="cta">
        <FinalCta onGetStarted={handleGetStarted} onContact={handleContact} />
      </div>

      <MinimalFooter />
    </div>
  );
}
