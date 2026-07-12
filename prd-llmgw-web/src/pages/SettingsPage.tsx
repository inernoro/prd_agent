import { Monitor, Moon, Sun } from 'lucide-react';
import { Card } from '@/components/ui';

export function SettingsPage() {
  const theme = document.documentElement.dataset.theme === 'light' ? '浅色' : '深色';
  return (
    <div className="lg-simple-page">
      <div className="lg-page-heading"><div><div className="lg-eyebrow">Settings</div><h1>控制台设置</h1><p>管理只影响当前浏览器的显示偏好。</p></div></div>
      <Card className="lg-settings-card">
        <div className="lg-card-kicker"><Monitor size={15} /> 外观</div>
        <div className="lg-setting-row"><span>{theme === '深色' ? <Moon size={17} /> : <Sun size={17} />}主题</span><strong>{theme}</strong></div>
        <p>可从顶部用户菜单切换主题。认证信息仍只保存在当前会话。</p>
      </Card>
    </div>
  );
}
