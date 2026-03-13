import { cn } from '@/lib/cn';
import { HERO_GRADIENT_TEXT } from './HeroSection';
import { useState, useEffect } from 'react';

const GITHUB_RELEASES_URL = 'https://github.com/inernoro/prd_agent/releases/latest';

type Platform = 'windows' | 'macos' | 'linux' | 'unknown';

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

const platforms = [
  {
    key: 'windows' as Platform,
    label: 'Windows',
    desc: 'Windows 10+',
    icon: (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 12V6.75l6-1.32v6.48L3 12zm6.25.13l8.25-.02V5.1L9.25 6.27v5.86zM3 13l6 .09v6.81l-6-1.32V13zm6.25-.02l8.25.02v7.47l-8.25-1.17v-6.32z" />
      </svg>
    ),
  },
  {
    key: 'macos' as Platform,
    label: 'macOS',
    desc: 'macOS 11+',
    icon: (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    ),
  },
  {
    key: 'linux' as Platform,
    label: 'Linux',
    desc: 'Ubuntu / Debian',
    icon: (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.868.065 1.322-.28 1.335-.664.008-.135-.09-.27-.166-.39-.296-.469-.32-.614-.37-.737a.416.416 0 01-.015-.042c-.017-.04-.026-.072-.034-.118-.009-.053-.014-.116-.014-.192 0-.152.023-.357.068-.591.235-.92.37-1.424.177-1.83-.068-.144-.196-.252-.357-.321a2.33 2.33 0 00-.025-.334c-.104-.878-.794-1.467-1.356-1.8-.233-.133-.473-.237-.661-.333l-.018-.032c-.26-.476-.512-.984-.735-1.426-.192-.393-.368-.736-.496-.98-.348-.672-.605-1.136-.832-1.486-.24-.367-.404-.556-.542-.62a.24.24 0 00-.062-.023c.145-.428.396-1.37.36-2.563.021-.137.054-.27.075-.4.02-.131.033-.261.033-.389 0-.381-.075-.748-.21-1.074-.134-.325-.327-.602-.6-.833-.397-.34-.89-.523-1.407-.596a4.476 4.476 0 00-1.27 0z" />
      </svg>
    ),
  },
];

interface DownloadSectionProps {
  className?: string;
}

export function DownloadSection({ className }: DownloadSectionProps) {
  const [detectedPlatform, setDetectedPlatform] = useState<Platform>('unknown');

  useEffect(() => {
    setDetectedPlatform(detectPlatform());
  }, []);

  const handleDownload = () => {
    window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
  };

  return (
    <section id="download" className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Semi-transparent overlay */}
      <div className="absolute inset-0 bg-[#030306]/40" />

      {/* Decorative glow */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full opacity-20 blur-[120px]"
        style={{ background: 'radial-gradient(circle, rgba(124, 58, 237, 0.6) 0%, transparent 70%)' }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 mb-8 rounded-full border border-violet-400/30 bg-violet-400/10 backdrop-blur-sm">
          <svg className="w-4 h-4 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span className="text-sm text-violet-300">桌面客户端 v1.6.0</span>
        </div>

        {/* Headline */}
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold mb-4">
          <span className="text-white">下载 </span>
          <span style={HERO_GRADIENT_TEXT}>PRD Agent</span>
          <span className="text-white"> 桌面版</span>
        </h2>

        <p className="text-base sm:text-lg text-white/55 max-w-xl mx-auto mb-12">
          原生桌面体验，更快响应速度，支持离线使用与系统级集成
        </p>

        {/* Platform cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
          {platforms.map((p) => {
            const isDetected = p.key === detectedPlatform;
            return (
              <button
                key={p.key}
                onClick={handleDownload}
                className={cn(
                  'group relative flex flex-col items-center gap-3 p-6 rounded-2xl border transition-all duration-300 hover:scale-[1.03] active:scale-[0.98]',
                  isDetected
                    ? 'border-cyan-400/40 bg-cyan-400/10 backdrop-blur-md'
                    : 'border-white/10 bg-white/5 backdrop-blur-md hover:border-white/20 hover:bg-white/8',
                )}
              >
                {isDetected && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[10px] font-medium bg-cyan-400/20 text-cyan-300 border border-cyan-400/30">
                    当前系统
                  </div>
                )}
                <div className={cn(
                  'transition-colors',
                  isDetected ? 'text-cyan-300' : 'text-white/60 group-hover:text-white/80',
                )}>
                  {p.icon}
                </div>
                <div>
                  <div className={cn(
                    'font-semibold text-base',
                    isDetected ? 'text-white' : 'text-white/80',
                  )}>
                    {p.label}
                  </div>
                  <div className="text-xs text-white/45 mt-0.5">{p.desc}</div>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-white/50 group-hover:text-white/70 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  下载安装包
                </div>
              </button>
            );
          })}
        </div>

        {/* All releases link */}
        <a
          href={GITHUB_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-white/50 hover:text-white/80 transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          查看所有版本与更新日志
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    </section>
  );
}
