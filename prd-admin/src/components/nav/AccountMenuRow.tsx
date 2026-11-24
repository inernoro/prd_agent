import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * 账号菜单（桌面侧栏头像菜单 + 手机抽屉底部）的行，两边共用这一份外观。
 *
 * 2026-09-24 用户反馈「教程很突兀、有些字看不清、列表过长」后按 Apple 菜单的写法收敛：
 * - 每行同一个形状：16px 图标 + 13px 正文色标签 + 右侧只放真正有信息的东西
 *   （数字角标 / 快捷键 / 外链图标 / 教程等级），不再放「连接 / 记录」这类补充说明；
 * - 右侧小字不低于 12px、颜色走 --text-muted（10px 灰字在浅色纸面上读不清）；
 * - 数字角标统一走主按钮那对 token，不写死琥珀色（浅色下是黄字压淡黄底）。
 * 桌面行 32px 高；手机行保留 44px 触控高度，外观相同。
 */

/** 桌面菜单行（Radix DropdownMenu.Item 的 className）：高亮态随键盘导航，不只靠鼠标悬停 */
export const ACCOUNT_MENU_ROW_CLASS =
  'flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 cursor-pointer outline-none transition-colors hover-bg-soft data-[highlighted]:bg-[var(--bg-input-hover)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

/** 手机抽屉行：同一外观，保留 44px 触控高度 */
export const ACCOUNT_MENU_ROW_TOUCH_CLASS =
  'flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50';

export function AccountMenuRowBody({
  icon: Icon,
  label,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <Icon size={16} className="shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden />
      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{label}</span>
      {trailing != null && <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
    </>
  );
}

/** 数字角标（未读数等）：主按钮配色，两个主题的对比度由 themeSystem 守卫钉住 */
export function AccountMenuCount({ value, max = 99 }: { value: number; max?: number }) {
  if (value <= 0) return null;
  return (
    <span
      className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
      style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
    >
      {value > max ? `${max}+` : value}
    </span>
  );
}

/** 右侧短提示（快捷键 / 教程等级）：12px 次要灰，不再用 10px */
export function AccountMenuHint({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
      {children}
    </span>
  );
}

/** 分组小标题 */
export function AccountMenuSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

/** 分隔线样式：用正式细线 token，原来 4% 透明的渐变几乎看不见，菜单没有分组感 */
export const ACCOUNT_MENU_SEPARATOR_STYLE = { height: 1, background: 'var(--border-subtle)' } as const;
