import { useEffect, useRef, useState } from 'react';

export interface TabBarItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabBarProps {
  items: TabBarItem[];
  activeKey?: string;
  onChange?: (key: string) => void;
  actions?: React.ReactNode;
  variant?: 'default' | 'gold';
}

export function TabBar({ items, activeKey, onChange, actions, variant = 'default' }: TabBarProps) {
  const [internalKey, setInternalKey] = useState(items[0]?.key ?? '');
  const currentKey = activeKey ?? internalKey;
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleChange = (key: string) => {
    setInternalKey(key);
    onChange?.(key);
  };

  // 更新滑块位置
  useEffect(() => {
    const activeButton = buttonsRef.current.get(currentKey);
    if (activeButton) {
      const container = activeButton.parentElement;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const buttonRect = activeButton.getBoundingClientRect();
        setIndicatorStyle({
          left: buttonRect.left - containerRect.left,
          width: buttonRect.width,
        });
      }
    }
  }, [currentKey, items]);

  return (
    <div
      className="h-[46px] rounded-[14px] px-4 transition-all duration-200"
      style={{
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
        {/* 左侧：tabs */}
        <div className="relative flex items-center gap-2">
          {/* 滑动指示器 */}
          <div
            className="absolute rounded-[9px] h-[28px] transition-all duration-300 ease-out pointer-events-none"
            style={{
              left: indicatorStyle.left,
              width: indicatorStyle.width,
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.2)',
            }}
          />
          
          {/* 按钮 */}
          {items.map((item) => {
            const isActive = item.key === currentKey;
            return (
              <button
                key={item.key}
                ref={(el) => {
                  if (el) {
                    buttonsRef.current.set(item.key, el);
                  } else {
                    buttonsRef.current.delete(item.key);
                  }
                }}
                type="button"
                onClick={() => handleChange(item.key)}
                className="relative flex items-center gap-2 px-3 h-[28px] text-[12px] font-semibold transition-colors duration-200"
                style={{
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  zIndex: 1,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }
                }}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>

        {/* 右侧：操作按钮 */}
        {actions && (
          <div className="flex items-center gap-2 shrink-0">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
