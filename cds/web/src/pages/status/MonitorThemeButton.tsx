import { Contrast } from 'lucide-react';
import { useTheme } from '@/lib/theme';

/** Keep the console theme control available in the dedicated monitoring frame. */
export function MonitorThemeButton({ className = 'navb' }: { className?: string }): JSX.Element {
  const { theme, toggleWithRipple } = useTheme();
  const label = theme === 'dark' ? '切换到白天主题' : '切换到黑天主题';
  return <button type="button" className={className} aria-label={label} title={label} data-shell-action="theme-toggle"
    onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      toggleWithRipple({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }}><Contrast className="ic h-5 w-5" aria-hidden="true" /></button>;
}
