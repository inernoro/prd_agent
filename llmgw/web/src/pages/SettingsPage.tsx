import { Monitor, Moon, Sun } from 'lucide-react';
import { PageBody, PageHeader, PageShell, Prose } from '@/components/PageShell';
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
    <PageShell className="lg-preferences-page">
      <PageHeader title="控制台设置" subtitle="选择界面外观；主题只影响当前浏览器。" />
      <PageBody>
        <div className="lg-theme-options" role="radiogroup" aria-label="界面主题">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button key={option.value} type="button" role="radio" aria-checked={preference === option.value} className={preference === option.value ? 'is-active' : undefined} onClick={() => setPreference(option.value)}>
                <Icon size={18} />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </button>
            );
          })}
        </div>
        <Prose>当前实际显示为{resolved === 'light' ? '浅色' : '深色'}。顶部用户菜单可一键切换；认证信息仍只保存在当前会话。</Prose>
      </PageBody>
    </PageShell>
  );
}
