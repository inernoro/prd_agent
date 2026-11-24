import type { ComponentType, ReactNode } from 'react';
import * as LucideIcons from 'lucide-react';
import { GripVertical } from 'lucide-react';
import { isPaSecretaryIcon, renderPaSecretaryIconNode } from '@/lib/paSecretaryIconRegistry';

/**
 * 导航条目的「视觉零件」：编辑器（NavLayoutEditor）与全员总览（UserNavOverview）共用，
 * 保证两处画出来的同一个菜单长得一模一样——用户要求「和设置菜单的方式一样」。
 */

export interface NavChipMeta {
  navKey: string;
  label: string;
  shortLabel: string;
  icon: string;
}

export function getNavIcon(name: string, size = 16): ReactNode {
  if (isPaSecretaryIcon(name)) return renderPaSecretaryIconNode(size);
  const IconComponent = (LucideIcons as unknown as Record<string, ComponentType<{ size?: number }>>)[name];
  if (IconComponent) return <IconComponent size={size} />;
  return <LucideIcons.Circle size={size} />;
}

export const NAV_END_CAP_CLASS =
  'shrink-0 select-none rounded bg-token-nested px-2 py-1 font-mono text-[10px] text-token-muted';
export const NAV_CHIP_BASE_CLASS =
  'surface-inset group relative flex w-14 shrink-0 flex-col items-center justify-center gap-0 rounded-[10px] pb-1 pt-1.5 text-token-secondary';
export const NAV_CHIP_LABEL_CLASS = 'mt-0.5 px-1 text-center text-[10px] leading-tight text-token-muted';
export const NAV_CHIP_ACTION_CLASS =
  'absolute flex h-4 w-4 items-center justify-center rounded bg-black/25 transition-opacity';

/** 纯展示的菜单 chip（图标 + 短名），不带任何交互 */
export function NavChipBody({ meta, dimmed }: { meta: NavChipMeta; dimmed?: boolean }) {
  return (
    <>
      <span className={`inline-flex h-7 w-7 items-center justify-center ${dimmed ? 'opacity-50' : ''}`}>
        {getNavIcon(meta.icon, 18)}
      </span>
      <span className={`${NAV_CHIP_LABEL_CLASS} ${dimmed ? 'line-through opacity-60' : ''}`}>
        {meta.shortLabel}
      </span>
    </>
  );
}

/**
 * 分隔横杆的视觉：一根竖线 + 悬停才露出的抓手。
 * 原版只有 34px 宽的一条细线，指针几乎按不到——这里把可按区域放大到整块。
 */
export function NavDividerBody({ active }: { active?: boolean }) {
  return (
    <div
      className={`flex h-12 w-8 shrink-0 items-center justify-center rounded-[8px] transition-colors ${
        active ? 'bg-[hsl(var(--primary)/0.18)]' : 'group-hover:bg-token-nested'
      }`}
    >
      <div className="relative flex h-9 w-4 items-center justify-center">
        {/* 竖线要在两个主题下都一眼可见：宽 3px、走次要文字色，不再用 muted 的半透明细线 */}
        <div className="h-9 w-[3px] rounded-full" style={{ background: 'var(--text-secondary)', opacity: 0.75 }} />
        <GripVertical
          size={12}
          className="absolute rounded bg-token-nested text-token-primary opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
    </div>
  );
}

/** 目录里已经找不到的 token（比如已下线的菜单）在总览里要能被一眼认出来 */
export function StaleNavChip({ token }: { token: string }) {
  return (
    <div
      className={`${NAV_CHIP_BASE_CLASS} border border-dashed`}
      style={{ borderColor: 'var(--accent-fg-danger)', color: 'var(--accent-fg-danger)' }}
      title={`${token}：菜单目录里已不存在（可能已下线），侧栏渲染时会被自动跳过`}
    >
      <span className="inline-flex h-7 w-7 items-center justify-center">
        <LucideIcons.Ghost size={18} />
      </span>
      <span className="mt-0.5 max-w-full truncate px-1 text-center font-mono text-[9px] leading-tight">
        {token}
      </span>
    </div>
  );
}
