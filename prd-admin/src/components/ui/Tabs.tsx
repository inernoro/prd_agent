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
            className={cn(
              'flex h-[28px] items-center gap-2 rounded-[9px] px-3 text-[12px] font-semibold transition-colors',
              isActive
                ? 'surface-action text-token-primary'
                : 'text-token-muted hover:text-token-secondary'
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
