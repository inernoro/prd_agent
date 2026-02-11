import { useLocation, useNavigate } from 'react-router-dom';
import { glassMobileTabBar } from '@/lib/glassStyles';
import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';

export interface MobileTabItem {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 路由路径 (点击时跳转) */
  path: string;
  /** 匹配路由前缀 (判断是否 active)，默认使用 path */
  matchPrefix?: string;
}

interface MobileTabBarProps {
  items: MobileTabItem[];
  className?: string;
}

/**
 * 移动端底部 Tab 导航栏。
 * 固定底部，高度 56px + safe-area。
 */
export function MobileTabBar({ items, className }: MobileTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav
      className={cn('fixed left-0 right-0 bottom-0 z-100 flex items-stretch', className)}
      style={{
        ...glassMobileTabBar,
        height: 'calc(var(--mobile-tab-height, 56px) + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {items.map((item) => {
        const prefix = item.matchPrefix ?? item.path;
        const active = location.pathname === prefix || location.pathname.startsWith(prefix + '/');
        const Icon = item.icon;

        return (
          <button
            key={item.key}
            onClick={() => navigate(item.path)}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors',
              'min-h-[var(--mobile-min-touch,44px)]',
              active ? 'text-[var(--accent-gold)]' : 'text-[var(--text-muted)]',
            )}
          >
            <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
            <span className={cn('text-[10px] leading-tight', active && 'font-medium')}>
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
