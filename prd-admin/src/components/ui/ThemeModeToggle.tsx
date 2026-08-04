import { Moon, Sun } from 'lucide-react';
import type { MouseEventHandler } from 'react';
import type { MobileThemeMode } from '@/stores/mobileThemeStore';

type ThemeModeToggleProps = {
  mode: MobileThemeMode;
  onToggle: MouseEventHandler<HTMLButtonElement>;
  /**
   * 形态：
   * - 'stacked'（默认）：图标在上、文字在下的方块，用于侧栏底部控件区（收起时也认得出）。
   * - 'inline'：36px 高的横向药丸，用于和其他 36px 按钮同处一行的顶栏。
   *   2026-07-31 用户反馈：分享阅读页顶栏里方块主题钮和「返回知识库」药丸一高一矮，
   *   看着大小不一 —— 同一行里的控件必须同高。
   */
  variant?: 'stacked' | 'inline';
};

/**
 * 全局明暗切换入口。
 *
 * 当前模式用图标与文字双重表达，aria-label / title 则说明点击后的动作，
 * 避免只靠颜色传达状态，也让收起的窄侧栏仍能保持可发现性。
 */
export function ThemeModeToggle({ mode, onToggle, variant = 'stacked' }: ThemeModeToggleProps) {
  const isLight = mode === 'light';
  const label = isLight ? '浅色' : '深色';
  const actionLabel = isLight ? '切换到深色外观' : '切换到浅色外观';
  const Icon = isLight ? Sun : Moon;

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={actionLabel}
        title={actionLabel}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[9px] px-3 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
        style={{
          minHeight: 36,
          fontSize: 13,
          color: 'var(--text-primary)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <Icon size={14} aria-hidden style={{ color: 'var(--launcher-theme-icon)' }} />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={actionLabel}
      title={actionLabel}
      className="group/theme relative flex w-14 cursor-pointer flex-col items-center justify-center gap-0 rounded-[14px] py-1.5 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
      style={{
        color: 'var(--text-secondary)',
        background: 'var(--launcher-control-bg)',
        border: '1px solid var(--launcher-control-border)',
      }}
    >
      <span
        className="relative inline-flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-200 group-hover/theme:scale-105"
        style={{
          color: 'var(--launcher-theme-icon)',
          background: 'var(--launcher-theme-icon-bg)',
        }}
      >
        <Icon size={15} aria-hidden />
      </span>
      <span className="mt-0.5 text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </button>
  );
}
