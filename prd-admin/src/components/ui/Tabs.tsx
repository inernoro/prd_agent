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
    <div
      className={cn('flex items-center gap-2 p-1 rounded-[14px]', className)}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {items.map((item) => {
        const isActive = item.key === currentKey;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => handleChange(item.key)}
            className={cn(
              'flex items-center gap-2 px-4 h-9 rounded-[11px] text-[13px] font-semibold transition-all',
              isActive ? 'text-[color:var(--text-primary)]' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]'
            )}
            style={
              isActive
                ? {
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: '0 2px 8px -2px rgba(0,0,0,0.2)',
                  }
                : undefined
            }
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
