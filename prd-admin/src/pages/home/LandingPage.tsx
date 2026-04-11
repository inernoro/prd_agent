import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { HeroSection, HERO_GRADIENT } from './sections/HeroSection';
import { AgentShowcase, agents, parseGlowColor } from './sections/AgentShowcase';
import { FeatureBento } from './sections/FeatureBento';
import { SocialProof } from './sections/SocialProof';
import { CtaFooter } from './sections/CtaFooter';
import { DownloadSection } from './sections/DownloadSection';
import { LibrarySection } from './sections/LibrarySection';
import { SignatureCinema } from './sections/SignatureCinema';
import { StarfieldBackground } from './components/StarfieldBackground';

/**
 * 七幕场景色编排：每一个 section 进入视口时，Starfield 的 themeColor 会切换，
 * 粒子宇宙的色温随叙事流动。这是"动态 ≠ 各自循环，动态 = 滚动驱动"的实现。
 */
type SceneColor = [number, number, number] | undefined;

const SCENE_COLORS: Record<string, SceneColor> = {
  hero: [110, 228, 255],            // 冷蓝：宇宙远景
  showcase: undefined,               // 交给 showcase 内部的 agent hover 色决定
  cinema: [14, 30, 50],              // 深蓝黑：电影时刻，背景退场
  library: [167, 139, 250],          // 紫：智识殿堂
  features: [110, 228, 255],         // 冷蓝回归
  testimonials: [241, 245, 249],     // 冷白：证据
  download: [167, 139, 250],         // 紫
  cta: [244, 63, 94],                // 玫瑰：最终收束（唯一暖色出现）
};

// MAP Logo component using official favicon
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
  const mainRef = useRef<HTMLDivElement>(null);
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
  const [activeScene, setActiveScene] = useState<string>('hero');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // 滚动场景编排：用 IntersectionObserver 追踪哪一幕占据视口中心
  useEffect(() => {
    const ids = ['hero', 'showcase', 'cinema', 'library', 'features', 'testimonials', 'download', 'cta'];
    const elements = ids
      .map((id) => ({ id, el: document.getElementById(id) }))
      .filter((item): item is { id: string; el: HTMLElement } => item.el !== null);

    if (elements.length === 0) return;

    // rootMargin 设为上下 -40%，只有当 section 占据视口中段 20% 时才算"激活"
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          // 选择最靠近视口中心的那个
          const best = visible.reduce((prev, curr) =>
            Math.abs(curr.boundingClientRect.top) < Math.abs(prev.boundingClientRect.top) ? curr : prev,
          );
          const id = (best.target as HTMLElement).id;
          if (id) setActiveScene(id);
        }
      },
      { rootMargin: '-40% 0px -40% 0px', threshold: 0 },
    );

    elements.forEach(({ el }) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // 场景色：showcase 幕用 agent hover 色，其他幕用 SCENE_COLORS 里的预设
  const themeColor: SceneColor =
    activeScene === 'showcase'
      ? parseGlowColor(agents[activeAgentIndex].glowColor)
      : SCENE_COLORS[activeScene];

  const handleGetStarted = () => {
    navigate('/login');
  };

  const handleWatchDemo = () => {
    // "观看片花" CTA 滚到 Signature Cinema（幕 4）— 与按钮标签保持语义一致
    const cinema = document.getElementById('cinema');
    cinema?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleContact = () => {
    // Could open a contact modal or navigate to contact page
    window.open('mailto:contact@example.com', '_blank');
  };

  return (
    <div
      ref={mainRef}
      className="min-h-screen bg-[#030306] text-white overflow-x-hidden"
      style={{
        scrollBehavior: 'smooth',
      }}
    >
      {/* 背景：Starfield 粒子（降到 22% 不透明度，作材质而非主角；Linear 风不允许粒子抢戏） */}
      <div
        className="fixed inset-0 z-0 pointer-events-none"
        style={{ opacity: 0.22 }}
      >
        <StarfieldBackground themeColor={themeColor} />
      </div>

      {/* 顶部覆盖暗色 gradient —— 保证 Hero 区 Linear 径向光晕能看清 */}
      <div
        className="fixed inset-x-0 top-0 h-[700px] z-[1] pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(3, 3, 6, 0.85) 0%, rgba(3, 3, 6, 0.5) 40%, rgba(3, 3, 6, 0) 100%)',
        }}
      />

      {/* Fixed navigation header */}
      <nav className="fixed top-0 left-0 right-0 z-50">
        <div
          className="mx-auto px-6 py-4"
          style={{
            background: 'linear-gradient(180deg, rgba(3,3,6,0.92) 0%, rgba(3,3,6,0) 100%)',
          }}
        >
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <MapLogo className="w-10 h-10 rounded-xl" />
              <span className="text-lg font-bold text-white/90">米多Agent平台</span>
            </div>

            {/* Nav links - desktop */}
            <div className="hidden md:flex items-center gap-8">
              <a href="#showcase" className="text-sm text-white/65 hover:text-white transition-colors">
                产品
              </a>
              <a href="#cinema" className="text-sm text-white/65 hover:text-white transition-colors">
                片花
              </a>
              <a href="#library" className="text-sm text-white/65 hover:text-white transition-colors">
                智识殿堂
              </a>
              <a href="#features" className="text-sm text-white/65 hover:text-white transition-colors">
                功能
              </a>
              <a href="#download" className="text-sm text-white/65 hover:text-white transition-colors">
                下载
              </a>
              <a href="https://github.com/inernoro/prd_agent" target="_blank" rel="noopener noreferrer" className="text-sm text-white/65 hover:text-white transition-colors">
                文档
              </a>
            </div>

            {/* CTA button + mobile hamburger */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleGetStarted}
                className="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-300 hover:scale-105"
                style={{
                  background: HERO_GRADIENT,
                  color: '#ffffff',
                  boxShadow: '0 0 20px rgba(0, 240, 255, 0.25)',
                }}
              >
                登录 / 注册
              </button>

              {/* Hamburger button - mobile only */}
              <button
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden flex items-center justify-center w-10 h-10 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
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

      {/* Mobile navigation overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[100] md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
            onClick={() => setMobileMenuOpen(false)}
          />

          {/* Menu panel */}
          <div className="absolute inset-x-0 top-0 bg-[#0a0a12]/95 backdrop-blur-xl border-b border-white/10 animate-[landingMenuIn_0.2s_ease-out]">
            <style>{`@keyframes landingMenuIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`}</style>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-3">
                <MapLogo className="w-10 h-10 rounded-xl" />
                <span className="text-lg font-bold text-white/90">米多Agent平台</span>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center w-10 h-10 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="关闭导航菜单"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Nav links */}
            <nav className="px-6 pb-6 space-y-1">
              {[
                { label: '产品', href: '#showcase' },
                { label: '片花', href: '#cinema' },
                { label: '智识殿堂', href: '#library' },
                { label: '功能', href: '#features' },
                { label: '下载', href: '#download' },
                { label: '文档', href: 'https://github.com/inernoro/prd_agent' },
              ].map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-4 py-3 rounded-xl text-base text-white/70 hover:text-white hover:bg-white/8 transition-colors"
                >
                  {item.label}
                </a>
              ))}

              {/* Mobile CTA */}
              <div className="pt-4">
                <button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    handleGetStarted();
                  }}
                  className="w-full py-3 rounded-xl text-base font-semibold text-white transition-all hover:opacity-90"
                  style={{
                    background: HERO_GRADIENT,
                    boxShadow: '0 0 20px rgba(0, 240, 255, 0.25)',
                  }}
                >
                  登录 / 注册
                </button>
              </div>
            </nav>
          </div>
        </div>
      )}

      {/* 幕 1 · Hero — Cosmic Overture */}
      <div id="hero">
        <HeroSection onGetStarted={handleGetStarted} onWatchDemo={handleWatchDemo} />
      </div>

      {/* 幕 3 · Agent Constellation（P1 将升级为非对称 Bento） */}
      <div id="showcase">
        <AgentShowcase
          activeIndex={activeAgentIndex}
          onIndexChange={setActiveAgentIndex}
        />
      </div>

      {/* 幕 4 · Signature Cinema — 电影时刻（视频位预留，当前降级为海报 + 即将上线） */}
      <div id="cinema">
        <SignatureCinema />
      </div>

      {/* 幕 6 · Ecosystem — 智识殿堂 */}
      <div id="library">
        <LibrarySection />
      </div>

      {/* Feature bento grid */}
      <div id="features">
        <FeatureBento />
      </div>

      {/* 幕 5 · Evidence — Social proof */}
      <div id="testimonials">
        <SocialProof />
      </div>

      {/* Download section */}
      <div id="download">
        <DownloadSection />
      </div>

      {/* 幕 7 · Final Call */}
      <div id="cta">
        <CtaFooter onGetStarted={handleGetStarted} onContact={handleContact} />
      </div>
    </div>
  );
}
