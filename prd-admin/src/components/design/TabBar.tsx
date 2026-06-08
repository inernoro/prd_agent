import { useEffect, useRef, useState } from 'react';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';

export interface TabBarItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** 可选：转发到 tab 按钮的 data-tour-id，供新手引导锚点（TabBar 默认不转发 data-*，见 onboarding-tips 规则） */
  dataTourId?: string;
}

interface TabBarProps {
  /** 标题模式：显示 icon + title */
  title?: React.ReactNode;
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
      className="surface-nav-bar shrink-0"
      data-variant={variant}
    >
      <div className="surface-nav-content">
        {/* 左侧：标题或切换栏 */}
        {hasTabs ? (
          <div className="surface-nav-tabs">
            <div
              className="surface-nav-indicator"
              data-ready={isReady}
              style={{
                left: indicatorStyle.left,
                width: indicatorStyle.width,
                opacity: indicatorStyle.opacity,
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
                  data-active={isActive}
                  data-tour-id={item.dataTourId}
                  className="surface-nav-button"
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </div>
        ) : (
          // 标题模式
          <div className="surface-nav-title">
            {icon && (
              <div className="surface-nav-icon">
                {icon}
              </div>
            )}
            {title && (
              <span className="surface-nav-title-text">
                {title}
              </span>
            )}
          </div>
        )}

        {/* 右侧：本页教程入口(内嵌页头,非悬浮) + 操作按钮。标题模式 / 顶级 tabs 模式都展示入口。 */}
        {(actions || title || (items && items.length > 0)) && (
          <div className="surface-nav-actions">
            {(title || (items && items.length > 0)) && <TipsEntryButton compact />}
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
