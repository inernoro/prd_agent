import type { LucideIcon } from 'lucide-react';
import { Reveal } from './Reveal';

/**
 * 首页通用 section header —— 所有幕共享这一套版式
 *
 * 结构：
 *   [Icon HUD chip]          ← VT323 mono 字体 + accent 发光边框
 *   大标题 h2                ← Space Grotesk 负字距
 *   可选副标题                ← Inter
 *
 * 内置 Reveal 滚动进场。
 */
interface SectionHeaderProps {
  eyebrow: string;
  Icon: LucideIcon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  accent: string;
  /** 副标题最大宽度 */
  subtitleMaxWidth?: string;
}

export function SectionHeader({
  eyebrow,
  Icon,
  title,
  subtitle,
  accent,
  subtitleMaxWidth = '42rem',
}: SectionHeaderProps) {
  return (
    <div className="text-center">
      <Reveal>
        <div
          className="inline-flex items-center gap-2 mb-7 px-3.5 py-1.5 rounded-md"
          style={{
            fontFamily: 'var(--font-mono)',
            background: `${accent}0a`,
            border: `1px solid ${accent}3d`,
            boxShadow: `0 0 20px ${accent}33, inset 0 0 10px ${accent}0a`,
          }}
        >
          <Icon className="w-3.5 h-3.5" style={{ color: accent }} />
          <span
            className="text-[12.5px] uppercase"
            style={{
              color: accent,
              letterSpacing: '0.2em',
              textShadow: `0 0 10px ${accent}99`,
            }}
          >
            {eyebrow}
          </span>
        </div>
      </Reveal>

      <Reveal delay={80} blur={12} duration={1300}>
        <h2
          className="text-white font-medium"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2.125rem, 5vw, 3.75rem)',
            lineHeight: 1.08,
            letterSpacing: '-0.03em',
            textShadow: `0 0 32px ${accent}2e`,
          }}
        >
          {title}
        </h2>
      </Reveal>

      {subtitle && (
        <Reveal delay={160}>
          <p
            className="mt-7 text-white/58 mx-auto text-[15px] leading-[1.7]"
            style={{ maxWidth: subtitleMaxWidth }}
          >
            {subtitle}
          </p>
        </Reveal>
      )}
    </div>
  );
}
