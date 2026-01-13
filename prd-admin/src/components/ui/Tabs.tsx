import { cn } from '@/lib/cn';
import { useState } from 'react';

export interface TabItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

export function Tabs({
  items,
  activeKey,
  onChange,
  className,
}: {
  items: TabItem[];
  activeKey?: string;
  onChange?: (key: string) => void;
  className?: string;
}) {
  const [internalKey, setInternalKey] = useState(items[0]?.key ?? '');
  const currentKey = activeKey ?? internalKey;

  const handleChange = (key: string) => {
    setInternalKey(key);
    onChange?.(key);
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {items.map((item) => {
        const isActive = item.key === currentKey;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => handleChange(item.key)}
            className="flex items-center gap-2 px-3 h-[28px] text-[12px] font-semibold rounded-[9px]"
            style={{
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: isActive ? '1px solid rgba(255,255,255,0.12)' : '1px solid transparent',
              boxShadow: isActive ? '0 2px 8px -2px rgba(0,0,0,0.2)' : 'none',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
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
  );
}
