import { cn } from '@/lib/cn';
import { useEffect, useRef, useState } from 'react';
import { glassSwitchTrack } from '@/lib/glassStyles';

export interface GlassSwitchOption {
  key: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface GlassSwitchProps {
  /** 选项列表 */
  options: GlassSwitchOption[];
  /** 当前选中的 key */
  value?: string;
  /** 值变化回调 */
  onChange?: (key: string) => void;
  /** 尺寸 */
  size?: 'sm' | 'md' | 'lg';
  /** 是否全宽 */
  fullWidth?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义强调色（HSL 色相值） */
  accentHue?: number;
}

/**
 * GlassSwitch - 液态玻璃切换组
 * 
 * 具有滑动指示器动效的切换按钮组，支持：
 * - 多种尺寸
 * - 自定义强调色
 * - 图标支持
 * - 禁用状态
 */
export function GlassSwitch({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  className,
  accentHue,
}: GlassSwitchProps) {
  const [internalValue, setInternalValue] = useState(options[0]?.key ?? '');
  const currentValue = value ?? internalValue;
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const handleChange = (key: string) => {
    if (options.find(o => o.key === key)?.disabled) return;
    setInternalValue(key);
    onChange?.(key);
  };

  // 更新滑块位置
  useEffect(() => {
    const activeButton = buttonsRef.current.get(currentValue);
    if (activeButton && containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      setIndicatorStyle({
        left: buttonRect.left - containerRect.left,
        width: buttonRect.width,
      });
    }
  }, [currentValue, options]);

  // 尺寸映射
  const sizeConfig = {
    sm: { height: 'h-[24px]', text: 'text-[11px]', padding: 'px-2', gap: 'gap-1', icon: 12, containerPadding: 'p-[2px]', radius: 'rounded-[8px]', indicatorRadius: 'rounded-[6px]' },
    md: { height: 'h-[28px]', text: 'text-[12px]', padding: 'px-2.5', gap: 'gap-1.5', icon: 14, containerPadding: 'p-[3px]', radius: 'rounded-[10px]', indicatorRadius: 'rounded-[8px]' },
    lg: { height: 'h-[32px]', text: 'text-[13px]', padding: 'px-3', gap: 'gap-2', icon: 16, containerPadding: 'p-[4px]', radius: 'rounded-[12px]', indicatorRadius: 'rounded-[10px]' },
  };

  const config = sizeConfig[size];

  // 计算指示器颜色
  const getIndicatorStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      left: indicatorStyle.left,
      width: indicatorStyle.width,
      transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
    };

    if (accentHue !== undefined) {
      return {
        ...baseStyle,
        background: `linear-gradient(180deg, hsla(${accentHue}, 70%, 55%, 0.25) 0%, hsla(${accentHue}, 70%, 45%, 0.15) 100%)`,
        border: `1px solid hsla(${accentHue}, 70%, 60%, 0.35)`,
        boxShadow: `
          0 2px 8px -1px hsla(${accentHue}, 70%, 50%, 0.3),
          0 1px 2px 0 rgba(0, 0, 0, 0.15),
          0 0 0 1px hsla(${accentHue}, 70%, 70%, 0.15) inset,
          0 1px 0 0 hsla(${accentHue}, 70%, 80%, 0.2) inset
        `,
      };
    }

    return {
      ...baseStyle,
      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.08) 100%)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      boxShadow: `
        0 2px 8px -1px rgba(0, 0, 0, 0.25),
        0 1px 2px 0 rgba(0, 0, 0, 0.15),
        0 0 0 1px rgba(255, 255, 255, 0.12) inset,
        0 1px 0 0 rgba(255, 255, 255, 0.2) inset
      `,
    };
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'inline-flex relative overflow-hidden',
        config.containerPadding,
        config.radius,
        fullWidth && 'w-full',
        className
      )}
      style={glassSwitchTrack}
    >
      {/* 滑动指示器 */}
      <div
        className={cn('absolute pointer-events-none', config.height, config.indicatorRadius)}
        style={getIndicatorStyle()}
      />

      {/* 选项按钮 */}
      {options.map((option) => {
        const isActive = option.key === currentValue;
        return (
          <button
            key={option.key}
            ref={(el) => {
              if (el) {
                buttonsRef.current.set(option.key, el);
              } else {
                buttonsRef.current.delete(option.key);
              }
            }}
            type="button"
            onClick={() => handleChange(option.key)}
            disabled={option.disabled}
            className={cn(
              'relative flex items-center justify-center font-medium transition-colors duration-200 whitespace-nowrap',
              config.height,
              config.text,
              config.padding,
              config.gap,
              fullWidth && 'flex-1',
              option.disabled && 'opacity-40 cursor-not-allowed'
            )}
            style={{
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              zIndex: 1,
            }}
            onMouseEnter={(e) => {
              if (!isActive && !option.disabled) {
                e.currentTarget.style.color = 'var(--text-secondary)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive && !option.disabled) {
                e.currentTarget.style.color = 'var(--text-muted)';
              }
            }}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
