import type { ReactNode } from 'react';

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  subtitle?: ReactNode;
  tabs?: Array<{ key: string; label: string; icon?: ReactNode }>;
  activeTab?: string;
  onTabChange?: (key: string) => void;
  actions?: ReactNode;
  variant?: 'default' | 'gold';
};

export function PageHeader(props: PageHeaderProps) {
  const { title, description, subtitle, tabs, activeTab, onTabChange, actions, variant = 'default' } = props;

  return (
    <div
      className="rounded-[20px] p-5 transition-all duration-200"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        backgroundImage:
          variant === 'gold'
            ? 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 94%, black) 0%, color-mix(in srgb, var(--bg-elevated) 88%, black) 100%), radial-gradient(circle at 20% 50%, color-mix(in srgb, var(--accent-gold) 3%, transparent) 0%, transparent 50%)'
            : 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 96%, white) 0%, color-mix(in srgb, var(--bg-elevated) 92%, black) 100%)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--border-default)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.03) inset',
      }}
    >
      <div className="flex items-start gap-6">
        {/* 左侧：标题、副标题和描述 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[16px] font-extrabold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </div>
            {subtitle && (
              <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)', opacity: 0.8 }}>
                {subtitle}
              </div>
            )}
          </div>
          {description && (
            <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              {description}
            </div>
          )}
        </div>

        {/* 右侧：切换按钮 + 操作按钮（统一放右上角） */}
        {(tabs && tabs.length > 0) || actions ? (
          <div className="flex items-center justify-end gap-2 shrink-0 flex-wrap">
            {tabs && tabs.length > 0 && (
              <div
                className="inline-flex items-center p-1 rounded-[12px] shrink-0"
                style={{
                  background: 'rgba(0, 0, 0, 0.32)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  boxShadow: '0 8px 20px rgba(0, 0, 0, 0.28), 0 1px 4px rgba(0, 0, 0, 0.20) inset',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}
              >
                {tabs.map((tab) => {
                  const active = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => onTabChange?.(tab.key)}
                      className="h-[28px] px-3 rounded-[9px] text-[12px] font-semibold transition-all duration-150 inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                      style={{
                        color: active ? '#1a1206' : 'rgba(255, 255, 255, 0.75)',
                        background: active ? 'var(--gold-gradient)' : 'transparent',
                        boxShadow: active
                          ? '0 2px 8px -1px rgba(214, 178, 106, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.12) inset'
                          : 'none',
                        opacity: active ? 1 : 0.85,
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                          e.currentTarget.style.opacity = '1';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.opacity = '0.85';
                        }
                      }}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            )}

            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
