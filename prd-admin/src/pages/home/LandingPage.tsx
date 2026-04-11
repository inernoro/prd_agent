import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { HeroSection, HERO_GRADIENT } from './sections/HeroSection';
import { StatsStrip } from './sections/StatsStrip';
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

/**
 * LandingPage — 米多 Agent 平台 /home
 *
 * 九幕 Linear.app 风结构：
 *   1 · Hero                — 大标题 + CTA + 产品壳 mockup
 *   2 · StatsStrip          — 15+ / 14 / 98 / 99.9% 极简大数字
 *   3 · FeatureDeepDive     — 六大核心 Agent 左右交替深度展示
 *   4 · SignatureCinema     — 16:9 产品片花位
 *   5 · HowItWorks          — 三步流程
 *   6 · AgentGrid           — 15 个 Agent 总览（真实数据源）
 *   7 · CompatibilityStack  — 模型兼容矩阵
 *   8 · FinalCta            — 最终收束 CTA
 *   9 · MinimalFooter       — 极简页脚
 *
 * 背景：StaticBackdrop 纯 CSS 静态层（零动画零粒子）。
 */

// MAP Logo（顶栏用，保留原渐变 logo）
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
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleGetStarted = () => navigate('/login');
  const handleWatchDemo = () => {
    document.getElementById('cinema')?.scrollIntoView({ behavior: 'smooth' });
  };
  const handleContact = () => {
    window.open('mailto:contact@miduo.org', '_blank');
  };

  const navLinks = [
    { label: '产品', href: '#features' },
    { label: 'Agent', href: '#agents' },
    { label: '片花', href: '#cinema' },
    { label: '社区', href: '#pulse' },
    { label: '下载', href: '#download' },
    { label: '文档', href: 'https://github.com/inernoro/prd_agent', external: true },
  ];

  return (
    <div
      className="min-h-screen bg-[#030306] text-white overflow-x-hidden"
      style={{ scrollBehavior: 'smooth', fontFamily: 'var(--font-body)' }}
    >
      {/* 静态背景（纯 CSS，零动画零粒子） */}
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
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <MapLogo className="w-9 h-9 rounded-[10px]" />
              <span
                className="text-[15px] font-medium text-white/90 hidden sm:inline"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em' }}
              >
                米多 Agent 平台
              </span>
            </div>

            {/* Desktop nav */}
            <div className="hidden md:flex items-center gap-8">
              {navLinks.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  className="text-[13px] text-white/55 hover:text-white transition-colors"
                  style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
                >
                  {item.label}
                </a>
              ))}
            </div>

            {/* CTA + mobile hamburger */}
            <div className="flex items-center gap-3">
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
                登录 / 注册
              </button>

              <button
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg text-white/70 hover:text-white hover:bg-white/5 transition-colors"
                aria-label="打开导航菜单"
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
                  米多 Agent 平台
                </span>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-white/70 hover:text-white hover:bg-white/5 transition-colors"
                aria-label="关闭导航菜单"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="px-6 pb-6 space-y-1">
              {navLinks.map((item) => (
                <a
                  key={item.label}
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
                  登录 / 注册
                </button>
              </div>
            </nav>
          </div>
        </div>
      )}

      {/* 九幕内容 */}
      <div id="hero">
        <HeroSection onGetStarted={handleGetStarted} onWatchDemo={handleWatchDemo} />
      </div>

      <div id="stats">
        <StatsStrip />
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
