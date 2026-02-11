import { useLocation, useNavigate } from 'react-router-dom';
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
 *
 * 设计哲学："黑暗中透着光明"
 * - 深色磨砂玻璃底座
 * - 中间第 3 项悬浮上抬，高对比度发光按钮
 * - 常规项使用圆点指示器 + 高对比度激活态
 * - 整体对比度高，不显呆板
 */
export function MobileTabBar({ items, className }: MobileTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const centerIndex = Math.floor(items.length / 2); // 第 3 项 (index 2)

  return (
    <nav
      className={cn('fixed left-0 right-0 bottom-0 z-100', className)}
      style={{
        height: 'calc(var(--mobile-tab-height, 60px) + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {/* 玻璃底座 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(0deg, rgba(10, 10, 14, 0.97) 0%, rgba(16, 16, 22, 0.92) 100%)',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          backdropFilter: 'blur(48px) saturate(200%)',
          WebkitBackdropFilter: 'blur(48px) saturate(200%)',
        }}
      />
      {/* 顶部高光线 — 细微的光带 */}
      <div
        className="absolute top-0 left-[10%] right-[10%] h-px"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.12) 30%, rgba(255, 255, 255, 0.18) 50%, rgba(255, 255, 255, 0.12) 70%, transparent 100%)',
        }}
      />

      {/* 按钮区域 */}
      <div className="relative h-[var(--mobile-tab-height,60px)] flex items-end">
        {items.map((item, index) => {
          const prefix = item.matchPrefix ?? item.path;
          const active = location.pathname === prefix || location.pathname.startsWith(prefix + '/');
          const Icon = item.icon;
          const isCenter = index === centerIndex;

          if (isCenter) {
            // ── 中间悬浮按钮 ──
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.path)}
                className="flex-1 flex flex-col items-center justify-end pb-1 relative"
                style={{ minHeight: 'var(--mobile-min-touch, 44px)' }}
              >
                {/* 悬浮圆形按钮 — 上抬 */}
                <div
                  className="absolute flex items-center justify-center transition-transform active:scale-95"
                  style={{
                    width: 50,
                    height: 50,
                    borderRadius: '50%',
                    bottom: 22,
                    // 高对比度渐变：从亮金到暖橙
                    background: active
                      ? 'linear-gradient(145deg, rgba(255, 200, 60, 0.95) 0%, rgba(245, 158, 11, 0.90) 50%, rgba(220, 120, 20, 0.85) 100%)'
                      : 'linear-gradient(145deg, rgba(255, 200, 60, 0.80) 0%, rgba(245, 158, 11, 0.72) 50%, rgba(220, 120, 20, 0.65) 100%)',
                    // 多层发光 — 黑暗中透着光明
                    boxShadow: active
                      ? `0 0 20px 4px rgba(245, 178, 40, 0.45),
                         0 4px 14px -2px rgba(245, 158, 11, 0.60),
                         0 0 40px 8px rgba(245, 158, 11, 0.15),
                         inset 0 1px 0 rgba(255, 255, 255, 0.35)`
                      : `0 0 16px 3px rgba(245, 178, 40, 0.30),
                         0 4px 12px -2px rgba(245, 158, 11, 0.40),
                         0 0 30px 6px rgba(245, 158, 11, 0.10),
                         inset 0 1px 0 rgba(255, 255, 255, 0.25)`,
                    // 外圈描边
                    border: '2px solid rgba(255, 220, 100, 0.30)',
                  }}
                >
                  <Icon
                    size={22}
                    strokeWidth={2.4}
                    style={{
                      color: 'rgba(20, 10, 0, 0.88)',
                      filter: 'drop-shadow(0 1px 1px rgba(255, 255, 255, 0.2))',
                    }}
                  />
                </div>
                {/* 标签 */}
                <span
                  className="text-[9px] leading-tight font-semibold"
                  style={{
                    color: active ? 'rgba(255, 200, 80, 0.95)' : 'rgba(255, 200, 80, 0.65)',
                  }}
                >
                  {item.label}
                </span>
              </button>
            );
          }

          // ── 常规项 ──
          return (
            <button
              key={item.key}
              onClick={() => navigate(item.path)}
              className="flex-1 flex flex-col items-center justify-center gap-1 transition-all duration-200 active:scale-95"
              style={{
                minHeight: 'var(--mobile-min-touch, 44px)',
                paddingBottom: 2,
              }}
            >
              <div className="relative">
                <Icon
                  size={21}
                  strokeWidth={active ? 2.2 : 1.6}
                  style={{
                    color: active
                      ? 'rgba(255, 255, 255, 0.95)'
                      : 'rgba(255, 255, 255, 0.35)',
                    transition: 'color 0.2s ease, filter 0.2s ease',
                    filter: active ? 'drop-shadow(0 0 6px rgba(255, 255, 255, 0.2))' : 'none',
                  }}
                />
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <span
                  className={cn('text-[10px] leading-tight', active ? 'font-semibold' : 'font-normal')}
                  style={{
                    color: active
                      ? 'rgba(255, 255, 255, 0.90)'
                      : 'rgba(255, 255, 255, 0.32)',
                    transition: 'color 0.2s ease',
                  }}
                >
                  {item.label}
                </span>
                {/* 激活圆点指示器 */}
                <div
                  className="h-[3px] rounded-full transition-all duration-300"
                  style={{
                    width: active ? 16 : 0,
                    background: active
                      ? 'linear-gradient(90deg, rgba(245, 178, 40, 0.8) 0%, rgba(255, 220, 100, 0.95) 50%, rgba(245, 178, 40, 0.8) 100%)'
                      : 'transparent',
                    boxShadow: active ? '0 0 8px 1px rgba(245, 178, 40, 0.4)' : 'none',
                    opacity: active ? 1 : 0,
                  }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
