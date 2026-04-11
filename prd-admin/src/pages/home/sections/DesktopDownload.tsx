import { Apple, MonitorDown, Terminal, Download } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * DesktopDownload — 幕 · 桌面下载 CTA
 *
 * 借鉴 "App Store Style Landing" 模式 + retro HUD 外壳：
 * - 左：文案 + 主标题
 * - 右：三张平台卡（macOS / Windows / Linux），每张 HUD 风框线
 *
 * 纯占位（版本号/体积写死），后续可接 release API 更新。
 */

export function DesktopDownload() {
  const { t } = useLanguage();
  const titleParts = t.download.title.split('\n');

  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left: copy */}
          <div>
            <Reveal offset={18}>
              <div
                className="inline-flex items-center gap-2 px-3.5 py-1.5 mb-7 rounded-md"
                style={{
                  fontFamily: 'var(--font-mono)',
                  background: 'rgba(0, 240, 255, 0.06)',
                  border: '1px solid rgba(0, 240, 255, 0.3)',
                  boxShadow: '0 0 20px rgba(0, 240, 255, 0.22)',
                }}
              >
                <Download className="w-3.5 h-3.5 text-cyan-300" />
                <span
                  className="text-[12.5px] text-cyan-300 uppercase"
                  style={{
                    letterSpacing: '0.2em',
                    textShadow: '0 0 10px rgba(0, 240, 255, 0.6)',
                  }}
                >
                  {t.download.eyebrow}
                </span>
              </div>
            </Reveal>

            <Reveal delay={120} offset={22}>
              <h2
                className="text-white font-medium mb-7"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(2rem, 4.8vw, 3.5rem)',
                  lineHeight: 1.08,
                  letterSpacing: '-0.03em',
                  textShadow: '0 0 32px rgba(0, 240, 255, 0.22)',
                }}
              >
                {titleParts[0]}
                {titleParts.length > 1 && (
                  <>
                    <br />
                    {titleParts[1]}
                  </>
                )}
              </h2>
            </Reveal>

            <Reveal delay={240} offset={16}>
              <p className="text-white/62 text-[15px] leading-[1.75] max-w-md mb-7">
                {t.download.subtitle}
              </p>
            </Reveal>

            <ul className="space-y-3 text-[13.5px] text-white/75">
              {t.download.bullets.map((b, i) => (
                <Reveal key={i} delay={360 + i * 80} offset={12}>
                  <BulletLine text={b} />
                </Reveal>
              ))}
            </ul>
          </div>

          {/* Right: 3 platform cards */}
          <div className="grid grid-cols-1 gap-4">
            {t.download.platforms.map((p, i) => {
              const visual = PLATFORM_VISUALS[p.id];
              if (!visual) return null;
              return (
                <Reveal key={p.id} delay={180 + i * 120} offset={22}>
                  <PlatformCard
                    name={p.name}
                    arch={p.arch}
                    Icon={visual.Icon}
                    version={visual.version}
                    size={visual.size}
                    accent={visual.accent}
                    href={visual.href}
                  />
                </Reveal>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

interface PlatformVisual {
  Icon: LucideIcon;
  version: string;
  size: string;
  accent: string;
  href: string;
}

const PLATFORM_VISUALS: Record<string, PlatformVisual> = {
  macos: {
    Icon: Apple,
    version: 'v2.6.0',
    size: '42 MB',
    accent: '#a855f7',
    href: 'https://github.com/inernoro/prd_agent/releases',
  },
  windows: {
    Icon: MonitorDown,
    version: 'v2.6.0',
    size: '48 MB',
    accent: '#00f0ff',
    href: 'https://github.com/inernoro/prd_agent/releases',
  },
  linux: {
    Icon: Terminal,
    version: 'v2.6.0',
    size: '44 MB',
    accent: '#f43f5e',
    href: 'https://github.com/inernoro/prd_agent/releases',
  },
};

function BulletLine({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className="mt-[9px] w-1 h-1 rounded-full shrink-0"
        style={{
          background: '#00f0ff',
          boxShadow: '0 0 6px #00f0ff',
        }}
      />
      <span>{text}</span>
    </li>
  );
}

function PlatformCard({
  name,
  arch,
  Icon,
  version,
  size,
  accent,
  href,
}: {
  name: string;
  arch: string;
  Icon: LucideIcon;
  version: string;
  size: string;
  accent: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex items-center gap-5 p-5 rounded-lg border transition-all duration-300"
      style={{
        background: 'rgba(10, 10, 25, 0.55)',
        borderColor: `${accent}22`,
        boxShadow: `inset 0 0 24px ${accent}08`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${accent}66`;
        e.currentTarget.style.boxShadow = `inset 0 0 32px ${accent}15, 0 0 40px -8px ${accent}88`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = `${accent}22`;
        e.currentTarget.style.boxShadow = `inset 0 0 24px ${accent}08`;
      }}
    >
      {/* 顶边 HUD scanline */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${accent}99 50%, transparent 100%)`,
        }}
      />

      {/* Icon */}
      <div
        className="w-14 h-14 rounded-xl flex items-center justify-center shrink-0"
        style={{
          background: `linear-gradient(135deg, ${accent}20 0%, ${accent}05 100%)`,
          border: `1px solid ${accent}44`,
          boxShadow: `0 0 24px -6px ${accent}`,
        }}
      >
        <Icon className="w-6 h-6" style={{ color: accent }} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span
            className="text-[17px] font-medium text-white"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
          >
            {name}
          </span>
          <span
            className="text-[11px]"
            style={{
              color: accent,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.08em',
              textShadow: `0 0 6px ${accent}99`,
            }}
          >
            {version}
          </span>
        </div>
        <div
          className="text-[11px] text-white/45"
          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}
        >
          {arch} · {size}
        </div>
      </div>

      {/* Download arrow */}
      <div
        className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 transition-transform group-hover:-translate-y-0.5"
        style={{
          background: `${accent}15`,
          border: `1px solid ${accent}44`,
        }}
      >
        <Download className="w-4 h-4" style={{ color: accent }} />
      </div>
    </a>
  );
}
