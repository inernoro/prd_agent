import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { HeroSection } from './sections/HeroSection';
import { AgentShowcase, agents, parseGlowColor } from './sections/AgentShowcase';
import { FeatureBento } from './sections/FeatureBento';
import { SocialProof } from './sections/SocialProof';
import { CtaFooter } from './sections/CtaFooter';
import { StarfieldBackground } from './components/StarfieldBackground';

// MAP Logo component using official favicon
function MapLogo({ className = 'w-10 h-10' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#c7d2fe', stopOpacity: 1 }} />
          <stop offset="45%" style={{ stopColor: '#6366f1', stopOpacity: 1 }} />
          <stop offset="100%" style={{ stopColor: '#a5b4fc', stopOpacity: 1 }} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="512" height="512" rx="102" ry="102" fill="url(#goldGradient)" />
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
    : undefined; // undefined = use default random/gold color

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
      className="min-h-screen bg-[#050508] text-white overflow-x-hidden"
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
            background: 'linear-gradient(180deg, rgba(5,5,8,0.9) 0%, rgba(5,5,8,0) 100%)',
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
              <a href="#agent-showcase" className="text-sm text-white/60 hover:text-white/90 transition-colors">
                产品
              </a>
              <a href="#features" className="text-sm text-white/60 hover:text-white/90 transition-colors">
                功能
              </a>
              <a href="#testimonials" className="text-sm text-white/60 hover:text-white/90 transition-colors">
                案例
              </a>
              <a href="#" className="text-sm text-white/60 hover:text-white/90 transition-colors">
                文档
              </a>
            </div>

            {/* CTA button */}
            <button
              onClick={handleGetStarted}
              className="px-5 py-2 rounded-lg text-sm font-medium transition-all duration-300 hover:scale-105"
              style={{
                background: 'linear-gradient(135deg, #c7d2fe 0%, #6366f1 45%, #a5b4fc 100%)',
                color: '#0b0b0d',
              }}
            >
              登录 / 注册
            </button>
          </div>
        </div>
      </nav>

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

      {/* CTA footer */}
      <CtaFooter onGetStarted={handleGetStarted} onContact={handleContact} />
    </div>
  );
}
