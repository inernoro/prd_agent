import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { HeroSection, HERO_GRADIENT } from './sections/HeroSection';
import { AgentShowcase, agents, parseGlowColor } from './sections/AgentShowcase';
import { FeatureBento } from './sections/FeatureBento';
import { SocialProof } from './sections/SocialProof';
import { CtaFooter } from './sections/CtaFooter';
import { DownloadSection } from './sections/DownloadSection';
import { StarfieldBackground } from './components/StarfieldBackground';

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
  const [isInShowcase, setIsInShowcase] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Track scroll position to determine if we're in the showcase section
  useEffect(() => {
    const handleScroll = () => {
      const showcase = document.getElementById('agent-showcase');
      if (showcase) {
        const rect = showcase.getBoundingClientRect();
        const windowHeight = window.innerHeight;
        // Consider "in showcase" when the section is more than 30% visible
        const isVisible = rect.top < windowHeight * 0.7 && rect.bottom > windowHeight * 0.3;
        setIsInShowcase(isVisible);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // Initial check
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Get current theme color based on scroll position
  const themeColor = isInShowcase
    ? parseGlowColor(agents[activeAgentIndex].glowColor)
    : undefined; // undefined = use default indigo color

  const handleGetStarted = () => {
    navigate('/login');
  };

  const handleWatchDemo = () => {
    // Scroll to agent showcase
    const showcase = document.getElementById('agent-showcase');
    showcase?.scrollIntoView({ behavior: 'smooth' });
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
      {/* Global animated background */}
      <div className="fixed inset-0 z-0">
        <StarfieldBackground themeColor={themeColor} />
      </div>

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
              <a href="#agent-showcase" className="text-sm text-white/65 hover:text-white transition-colors">
                产品
              </a>
              <a href="#features" className="text-sm text-white/65 hover:text-white transition-colors">
                功能
              </a>
              <a href="#testimonials" className="text-sm text-white/65 hover:text-white transition-colors">
                案例
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
                { label: '产品', href: '#agent-showcase' },
                { label: '功能', href: '#features' },
                { label: '案例', href: '#testimonials' },
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

      {/* Hero section */}
      <HeroSection onGetStarted={handleGetStarted} onWatchDemo={handleWatchDemo} />

      {/* Agent showcase */}
      <div id="agent-showcase">
        <AgentShowcase
          activeIndex={activeAgentIndex}
          onIndexChange={setActiveAgentIndex}
        />
      </div>

      {/* Feature bento grid */}
      <div id="features">
        <FeatureBento />
      </div>

      {/* Social proof & testimonials */}
      <div id="testimonials">
        <SocialProof />
      </div>

      {/* Download section */}
      <DownloadSection />

      {/* CTA footer */}
      <CtaFooter onGetStarted={handleGetStarted} onContact={handleContact} />
    </div>
  );
}
