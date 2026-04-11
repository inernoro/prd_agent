import { Apple, MonitorDown, Terminal, Download } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * DesktopDownload — 幕 · 桌面下载 CTA
 *
 * 借鉴 "App Store Style Landing" 模式 + retro HUD 外壳：
 * - 左：文案 + 主标题
 * - 右：三张平台卡（macOS / Windows / Linux），每张 HUD 风框线
 *
 * 纯占位（版本号/体积写死），后续可接 release API 更新。
 */

interface Platform {
  id: string;
  name: string;
  Icon: LucideIcon;
  version: string;
  size: string;
  arch: string;
  accent: string;
  href?: string;
}

const PLATFORMS: Platform[] = [
  {
    id: 'macos',
    name: 'macOS',
    Icon: Apple,
    version: 'v2.6.0',
    size: '42 MB',
    arch: 'Apple Silicon · Intel',
    accent: '#a855f7',
    href: 'https://github.com/inernoro/prd_agent/releases',
  },
  {
    id: 'windows',
    name: 'Windows',
    Icon: MonitorDown,
    version: 'v2.6.0',
    size: '48 MB',
    arch: 'x64 · ARM64',
    accent: '#00f0ff',
    href: 'https://github.com/inernoro/prd_agent/releases',
  },
  {
    id: 'linux',
    name: 'Linux',
    Icon: Terminal,
    version: 'v2.6.0',
    size: '44 MB',
    arch: 'AppImage · .deb',
    accent: '#f43f5e',
    href: 'https://github.com/inernoro/prd_agent/releases',
  },
];

export function DesktopDownload() {
  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left: copy */}
          <div>
            <div
              className="inline-flex items-center gap-2.5 px-3 py-1 mb-6 rounded border border-cyan-400/30 bg-cyan-400/5"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              <Download className="w-3 h-3 text-cyan-300" />
              <span
                className="text-[12px] text-cyan-300"
                style={{
                  letterSpacing: '0.16em',
                  textShadow: '0 0 8px rgba(0, 240, 255, 0.45)',
                }}
              >
                DESKTOP CLIENT
              </span>
            </div>

            <h2
              className="text-white font-medium mb-6"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(2rem, 4.8vw, 3.5rem)',
                lineHeight: 1.05,
                letterSpacing: '-0.03em',
                textShadow: '0 0 28px rgba(0, 240, 255, 0.2)',
              }}
            >
              把整个 Agent 平台
              <br />
              带到你的桌面
            </h2>

            <p className="text-white/55 text-[15px] leading-relaxed max-w-md mb-6">
              基于 Tauri 2.0 的原生桌面客户端，系统托盘常驻、快捷键唤醒、离线缓存、
              全局剪贴板注入。和 Web 端共享同一套账号体系。
            </p>

            <ul className="space-y-2.5 text-[13px] text-white/70">
              <BulletLine text="系统托盘常驻 · 快捷键 Cmd+Shift+M 唤醒" />
              <BulletLine text="自动更新 · Tauri updater 签名校验" />
              <BulletLine text="所有平台共 134 MB · 零 Node runtime" />
            </ul>
          </div>

          {/* Right: 3 platform cards */}
          <div className="grid grid-cols-1 gap-4">
            {PLATFORMS.map((p) => (
              <PlatformCard key={p.id} platform={p} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

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

function PlatformCard({ platform }: { platform: Platform }) {
  const { name, Icon, version, size, arch, accent, href } = platform;
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
