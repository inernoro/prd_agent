import { useState } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { MobileBottomSheet, MobileSheetRow } from './MobileBottomSheet';

/**
 * 移动端「更多」溢出菜单 —— 治「控制条过载」的通用机制。
 *
 * 桌面端工具栏常有一排排次要按钮，手机上 flex-wrap 挤成三四行。
 * 用法：桌面端照常平铺这些按钮；手机端把次要按钮喂给本组件的 items，
 * 渲染成一个「⋯ 更多」按钮，点开走底部 Sheet（复用 MobileBottomSheet）。
 * 主操作（新建/创建）走 MobileFab，从而保证「进内容前控制条 ≤1 条」
 * （见 .claude/rules/mobile-first-density.md）。
 *
 * 复用而非重写：动作的 onClick 与桌面端同一份，只是换了承载容器。
 */
export interface OverflowAction {
  key: string;
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  /** 危险操作（红色） */
  danger?: boolean;
  /** 图标底色（不传走中性灰） */
  accent?: string;
}

export interface MobileOverflowMenuProps {
  items: OverflowAction[];
  /** Sheet 标题 */
  title?: string;
  /** 触发按钮的文字，默认「更多」 */
  triggerLabel?: string;
  /** 触发按钮自定义类名（不传走默认 pill 样式） */
  className?: string;
}

export function MobileOverflowMenu({
  items,
  title = '更多操作',
  triggerLabel = '更多',
  className,
}: MobileOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1.5 transition-colors active:opacity-70'
        }
        style={
          className
            ? undefined
            : { background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }
        }
        title={title}
        aria-label={title}
      >
        <MoreHorizontal size={14} />
        {triggerLabel ? <span>{triggerLabel}</span> : null}
      </button>

      <MobileBottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        {visible.map((it) => {
          const Icon = it.icon;
          return (
            <MobileSheetRow
              key={it.key}
              icon={Icon ? <Icon size={18} style={{ color: it.danger ? '#FF453A' : '#fff' }} /> : null}
              label={it.label}
              accent={it.accent}
              danger={it.danger}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            />
          );
        })}
      </MobileBottomSheet>
    </>
  );
}
