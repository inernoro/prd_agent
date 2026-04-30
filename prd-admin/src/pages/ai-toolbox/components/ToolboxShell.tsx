import type { ReactNode } from 'react';
import { Package, Wrench } from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { cn } from '@/lib/cn';
import type { ToolboxPageTab } from '@/stores/toolboxStore';

export type ToolboxSegmentedItem = {
  key: string;
  label: string;
  icon?: ReactNode;
};

const TOOLBOX_PAGE_TABS: ToolboxSegmentedItem[] = [
  { key: 'toolbox', label: 'AI 百宝箱', icon: <Package size={14} /> },
  { key: 'capabilities', label: '基础能力', icon: <Wrench size={14} /> },
];

export function ToolboxSegmentedControl({
  items,
  activeKey,
  onChange,
  compact = false,
  label,
}: {
  items: ToolboxSegmentedItem[];
  activeKey: string;
  onChange: (key: string) => void;
  compact?: boolean;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('toolbox-segmented', compact && 'toolbox-segmented-compact')}
    >
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active}
            className="toolbox-segmented-button"
            onClick={() => onChange(item.key)}
          >
            {item.icon && <span className="toolbox-segmented-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ToolboxPageShell({
  pageTab,
  onPageTabChange,
  primaryAction,
  controls,
  children,
  contentClassName,
}: {
  pageTab: ToolboxPageTab;
  onPageTabChange: (key: ToolboxPageTab) => void;
  primaryAction?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <div className="toolbox-page h-full min-h-0 flex flex-col">
      <TabBar
        items={TOOLBOX_PAGE_TABS}
        activeKey={pageTab}
        onChange={(key) => onPageTabChange(key as ToolboxPageTab)}
        actions={primaryAction}
      />

      {controls && (
        <div className="surface-nav-bar toolbox-filter-bar">
          <div className="surface-nav-content toolbox-filter-content">
            {controls}
          </div>
        </div>
      )}

      <div className={cn('toolbox-content flex-1 min-h-0', contentClassName)}>
        {children}
      </div>
    </div>
  );
}
