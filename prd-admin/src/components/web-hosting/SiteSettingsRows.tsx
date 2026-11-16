import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import './site-settings.css';

/** 与快捷分享相同的图标、当前值与展开编辑版式。 */
export function SiteSettingsRow({ icon, label, value, children }: {
  icon: ReactNode;
  label: string;
  value: string;
  children: ReactNode;
}) {
  return <details className="site-settings-row">
    <summary className="site-settings-row-summary hover-bg-soft">
      <span className="site-settings-row-icon">{icon}</span>
      <span className="site-settings-row-label">{label}</span>
      <span className="site-settings-row-value" title={value}>{value}</span>
      <ChevronRight size={12} className="site-settings-row-chevron" />
    </summary>
    <div className="site-settings-row-editor">{children}</div>
  </details>;
}

export function SiteSettingsToggleRow({ icon, label, hint, children }: {
  icon: ReactNode;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return <div className="site-settings-row site-settings-toggle-row" title={hint}>
    <span className="site-settings-row-icon">{icon}</span>
    <span className="site-settings-row-label">{label}</span>
    <div className="ml-auto shrink-0">{children}</div>
  </div>;
}
