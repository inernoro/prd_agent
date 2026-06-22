import { AS_COLOR } from '@/lib/appStoreTokens';

/**
 * 移动端段控（iOS Segmented Control）—— 滑动 pill。
 *
 * 替代手机端「一排排独立 tab 按钮」：一条段控承载主维度切换，
 * 配合 chip 行 + 「⋯」Sheet + FAB，保证进内容前控制条 ≤1 条。
 */
export interface MobileSegmentedItem {
  key: string;
  label: string;
}

export interface MobileSegmentedProps {
  items: MobileSegmentedItem[];
  activeKey: string;
  onChange: (key: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function MobileSegmented({ items, activeKey, onChange, className, style }: MobileSegmentedProps) {
  const idx = Math.max(0, items.findIndex((i) => i.key === activeKey));
  const pct = 100 / items.length;

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        position: 'relative',
        background: 'rgba(118,118,128,0.22)',
        borderRadius: 11,
        padding: 2,
        ...style,
      }}
    >
      {/* 滑动 pill */}
      <div
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: 2,
          width: `calc(${pct}% - 2px)`,
          borderRadius: 9,
          background: 'rgba(99,99,102,0.9)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          transform: `translateX(calc(${idx * 100}% + ${idx * 2}px))`,
          transition: 'transform 0.32s cubic-bezier(0.32,0.72,0,1)',
          zIndex: 1,
        }}
      />
      {items.map((it) => {
        const on = it.key === activeKey;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            style={{
              flex: 1,
              position: 'relative',
              zIndex: 2,
              border: 'none',
              background: 'none',
              padding: '8px 0',
              borderRadius: 9,
              fontSize: 14,
              fontWeight: 600,
              color: on ? AS_COLOR.label : AS_COLOR.labelSecondary,
              transition: 'color 0.25s ease',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
