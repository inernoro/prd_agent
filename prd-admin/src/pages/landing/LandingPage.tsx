import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { HeroSection } from './sections/HeroSection';
import { AgentShowcase } from './sections/AgentShowcase';
import { FeatureBento } from './sections/FeatureBento';
import { SocialProof } from './sections/SocialProof';
import { CtaFooter } from './sections/CtaFooter';

export default function LandingPage() {
  const navigate = useNavigate();
  const mainRef = useRef<HTMLDivElement>(null);

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
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                }}
              >
                <svg className="w-5 h-5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <span className="text-lg font-semibold text-white/90">PRD Agent</span>
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
                background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
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
        <AgentShowcase />
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
