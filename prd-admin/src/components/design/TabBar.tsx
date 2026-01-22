import { useEffect, useRef, useState } from 'react';

export interface TabBarItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabBarProps {
  /** 标题模式：显示 icon + title */
  title?: string;
  /** 标题图标 */
  icon?: React.ReactNode;
  /** 切换模式：显示 tabs */
  items?: TabBarItem[];
  activeKey?: string;
  onChange?: (key: string) => void;
  /** 右侧操作按钮 */
  actions?: React.ReactNode;
  variant?: 'default' | 'gold';
}

export function TabBar({ title, icon, items, activeKey, onChange, actions, variant = 'default' }: TabBarProps) {
  const [internalKey, setInternalKey] = useState(items?.[0]?.key ?? '');
  const currentKey = activeKey ?? internalKey;
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0, opacity: 0 });
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [isReady, setIsReady] = useState(false);

  const handleChange = (key: string) => {
    setInternalKey(key);
    onChange?.(key);
  };

  // 是否为切换模式
  const hasTabs = items && items.length > 0;

  // 更新滑块位置
  const updateIndicator = () => {
    if (!hasTabs) return;
    const activeButton = buttonsRef.current.get(currentKey);
    if (activeButton) {
      const container = activeButton.parentElement;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const buttonRect = activeButton.getBoundingClientRect();
        setIndicatorStyle({
          left: buttonRect.left - containerRect.left,
          width: buttonRect.width,
          opacity: 1,
        });
        if (!isReady) setIsReady(true);
      }
    }
  };

  // 初始化和 currentKey 变化时更新
  useEffect(() => {
    // 使用 requestAnimationFrame 确保 DOM 已完成布局
    const raf = requestAnimationFrame(() => {
      updateIndicator();
    });
    return () => cancelAnimationFrame(raf);
  }, [currentKey, items, hasTabs]);

  // 监听字体加载完成后重新计算
  useEffect(() => {
    if (!hasTabs) return;
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        requestAnimationFrame(updateIndicator);
      });
    }
  }, [hasTabs]);

  return (
    <div
      className="h-[46px] rounded-[14px] px-4 transition-all duration-200 relative overflow-hidden shrink-0"
      style={{
        // macOS 风格的多层背景
        background: variant === 'gold'
          ? 'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.04) 100%)'
          : 'linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        // 增强的模糊效果
        backdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
        WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
        // 更精致的阴影层次
        boxShadow: variant === 'gold'
          ? '0 8px 32px -4px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1) inset, 0 1px 0 0 rgba(255, 255, 255, 0.15) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.1) inset'
          : '0 8px 32px -4px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08) inset, 0 1px 0 0 rgba(255, 255, 255, 0.1) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.08) inset',
      }}
    >
      <div className="h-full flex items-center justify-between gap-4">
        {/* 左侧：标题或切换栏 */}
        {hasTabs ? (
          <div className="relative flex items-center gap-2">
            {/* 滑动指示器 - macOS 风格 */}
            <div
              className="absolute rounded-[9px] h-[28px] pointer-events-none"
              style={{
                left: indicatorStyle.left,
                width: indicatorStyle.width,
                opacity: indicatorStyle.opacity,
                // 平滑的弹性动画，初始化时不使用动画
                transition: isReady ? 'left 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease-out' : 'opacity 0.2s ease-out',
                // 多层背景效果
                background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.08) 100%)',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                // 精致的阴影和高光
                boxShadow: `
                  0 2px 8px -1px rgba(0, 0, 0, 0.3),
                  0 1px 2px 0 rgba(0, 0, 0, 0.2),
                  0 0 0 1px rgba(255, 255, 255, 0.1) inset,
                  0 1px 0 0 rgba(255, 255, 255, 0.2) inset
                `,
                // 额外的模糊效果
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              }}
            />
            
            {/* Tab 按钮 */}
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
        ) : (
          // 标题模式
          <div className="flex items-center gap-2">
            {icon && (
              <div className="flex items-center justify-center w-[20px] h-[20px]" style={{ color: 'var(--text-muted)' }}>
                {icon}
              </div>
            )}
            {title && (
              <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {title}
              </span>
            )}
          </div>
        )}

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
