import type { ReactNode } from 'react';

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  tabs?: Array<{ key: string; label: string; icon?: ReactNode }>;
  activeTab?: string;
  onTabChange?: (key: string) => void;
  actions?: ReactNode;
  variant?: 'default' | 'gold';
};

export function PageHeader(props: PageHeaderProps) {
  const { title, description, tabs, activeTab, onTabChange, actions, variant = 'default' } = props;

  return (
    <div
      className="rounded-[20px] p-6 transition-all duration-200"
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
      <div className="flex items-start justify-between gap-6">
        {/* 左侧：标题和描述 */}
        <div className="min-w-0">
          <div className="text-[16px] font-extrabold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </div>
          {description && (
            <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              {description}
            </div>
          )}
        </div>

        {/* 中间：切换按钮（如果有） */}
        {tabs && tabs.length > 0 && (
          <div className="flex-1 flex justify-center items-center">
            <div
              className="inline-flex items-center p-1.5 rounded-[14px] w-fit"
              style={{
                background: 'rgba(0, 0, 0, 0.46)',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                boxShadow: '0 14px 36px rgba(0, 0, 0, 0.35), 0 2px 10px rgba(0, 0, 0, 0.30) inset',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              {tabs.map((tab) => {
                const active = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => onTabChange?.(tab.key)}
                    className="h-[34px] px-4 rounded-[11px] text-[13px] font-semibold transition-all duration-200 inline-flex items-center gap-2 shrink-0 whitespace-nowrap hover:bg-white/6"
                    style={{
                      color: active ? '#1a1206' : 'rgba(255, 255, 255, 0.82)',
                      background: active ? 'var(--gold-gradient)' : 'transparent',
                      boxShadow: active
                        ? '0 2px 12px -2px rgba(214, 178, 106, 0.52), 0 0 0 1px rgba(255, 255, 255, 0.16) inset'
                        : 'none',
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 右侧：操作按钮 */}
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
