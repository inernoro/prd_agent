import { Monitor, Moon, Sun } from 'lucide-react';
import { Card } from '@/components/ui';
import './SettingsPage.css';
import { useThemePreference, type ThemePreference } from '@/lib/theme';

const THEME_OPTIONS: { value: ThemePreference; label: string; description: string; icon: typeof Monitor }[] = [
  { value: 'system', label: '跟随系统', description: '操作系统切换外观时，控制台同步变化。', icon: Monitor },
  { value: 'light', label: '浅色', description: '使用浅色背景和深色文字。', icon: Sun },
  { value: 'dark', label: '深色', description: '使用深色背景和浅色文字。', icon: Moon },
];

export function SettingsPage() {
  const { preference, resolved, setPreference } = useThemePreference();
  return (
    <div className="lg-simple-page lg-theme-settings">
      <div className="lg-page-heading"><div><h1>控制台设置</h1><p>选择清晰可见的界面外观；主题只影响当前浏览器。</p></div></div>
      <Card className="lg-settings-card">
        <div className="lg-card-kicker"><Monitor size={15} /> 外观</div>
        <div className="lg-theme-options" role="radiogroup" aria-label="界面主题">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <label key={option.value} className={preference === option.value ? 'is-active' : undefined}><input type="radio" name="console-theme" value={option.value} checked={preference === option.value} onChange={() => setPreference(option.value)} />
                <Icon size={18} />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            );
          })}
        </div>
        <p>当前显示为{resolved === 'light' ? '浅色' : '深色'}，设置立即生效。</p>
      </Card>
    </div>
  );
}
