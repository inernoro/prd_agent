import { Moon, Sun } from 'lucide-react';
import type { MouseEventHandler } from 'react';
import type { MobileThemeMode } from '@/stores/mobileThemeStore';

type ThemeModeToggleProps = {
  mode: MobileThemeMode;
  onToggle: MouseEventHandler<HTMLButtonElement>;
};

/**
 * 桌面壳层的全局明暗切换入口。
 *
 * 当前模式用图标与文字双重表达，aria-label / title 则说明点击后的动作，
 * 避免只靠颜色传达状态，也让收起的窄侧栏仍能保持可发现性。
 */
export function ThemeModeToggle({ mode, onToggle }: ThemeModeToggleProps) {
  const isLight = mode === 'light';
  const label = isLight ? '浅色' : '深色';
  const actionLabel = isLight ? '切换到深色外观' : '切换到浅色外观';
  const Icon = isLight ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={actionLabel}
      title={actionLabel}
      className="group/theme relative flex w-14 cursor-pointer flex-col items-center justify-center gap-0 rounded-[14px] py-1.5 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70"
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
