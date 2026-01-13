import type { ReactNode } from 'react';

/**
 * PageHeader 组件
 * 
 * 注意：完全避免使用 color-mix() 函数（兼容性问题，详见 Card.tsx 注释）
 */
type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  subtitle?: ReactNode;
  tabs?: Array<{ key: string; label: string; icon?: ReactNode }>;
  activeTab?: string;
  onTabChange?: (key: string) => void;
  actions?: ReactNode;
  variant?: 'default' | 'gold';
  /** 将tabs放在标题旁边（左侧）而不是右侧 */
  tabsInline?: boolean;
};

export function PageHeader(props: PageHeaderProps) {
  const { tabs, activeTab, onTabChange, actions, variant = 'default' } = props;

  const tabsElement = tabs && tabs.length > 0 && (
    <div
      className="flex items-center gap-2 p-1 rounded-[14px] shrink-0"
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
            onClick={() => handleChange(tab.key)}
            className={`flex items-center gap-2 px-3 h-[28px] text-[12px] font-semibold transition-all duration-150 shrink-0 whitespace-nowrap ${active ? 'rounded-[9px]' : ''}`}
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
  );

  const handleChange = (key: string) => {
    onTabChange?.(key);
  };

  // 如果没有tabs和actions，不渲染任何内容
  if (!tabs?.length && !actions) {
    return null;
  }

  return (
    <div
      className="h-[46px] rounded-[14px] px-4 transition-all duration-200"
      style={{
        // macOS 26 液态玻璃效果
        background: variant === 'gold'
          ? 'rgba(255, 255, 255, 0.06)'
          : 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        boxShadow: variant === 'gold'
          ? '0 8px 32px -8px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(255, 255, 255, 0.1) inset'
          : '0 4px 24px -4px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(255, 255, 255, 0.05) inset',
      }}
    >
      <div className="h-full flex items-center justify-between gap-4">
        {/* 左侧：tabs（如果有的话） */}
        {tabsElement}

        {/* 右侧：操作按钮（如果没有tabs，则占据整行右对齐） */}
        {actions && (
          <div className={`flex items-center gap-2 shrink-0 ${!tabsElement ? 'ml-auto' : ''}`}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
