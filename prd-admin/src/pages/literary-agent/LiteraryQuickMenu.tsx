import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown } from 'lucide-react';

/**
 * 文学创作编辑器的就地菜单（弹出按钮 + 菜单）。
 *
 * 参照 Apple 人机界面指南的「弹出按钮」：按钮本身显示当前值，右侧上下箭头表示
 * 「点开会就地给出选项」，点开的必须是选项菜单，而不是跳去一整页配置——
 * 长得像下拉就必须表现得像下拉（HIG 熟悉感：外观与行为一致）。
 *
 * 菜单是平铺的行：选中项前面打勾，悬停整行高亮；需要新建 / 编辑时走最底部的「管理…」，
 * 那才打开完整配置页。页面里所有同类菜单（模型、提示词、风格图、水印、配图位置）
 * 共用这一套，不再各自手写一格一框的列表。
 */

const STYLE_ID = 'literary-quick-menu-styles';
const CSS = `
.lqm-trigger {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0; height: 30px; padding: 0 6px 0 8px;
  border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border-subtle);
  color: var(--text-secondary); font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.lqm-trigger:hover { background: var(--bg-input-hover); border-color: var(--border-default); }
.lqm-trigger[data-state="open"] { border-color: var(--accent-primary); background: var(--bg-input-hover); }
.lqm-trigger:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
.lqm-trigger[data-set="true"] { color: var(--text-primary); }
.lqm-trigger-value { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.lqm-trigger--pill { height: 24px; padding: 0 6px 0 8px; border-radius: 999px; font-size: 11px; border-color: transparent; }

/* 浮层走近实心的 --overlay-panel-bg：半透明底会透出下面的正文，菜单读不清 */
.lqm-content {
  z-index: 60; padding: 6px; border-radius: 12px;
  background: var(--overlay-panel-bg); border: 1px solid var(--border-default);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.lqm-title { padding: 6px 8px 4px; font-size: 11px; font-weight: 600; color: var(--text-muted); }
.lqm-note { padding: 0 8px 6px; font-size: 11px; line-height: 1.5; color: var(--text-muted); }
.lqm-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 7px;
  font-size: 13px; color: var(--text-primary); cursor: pointer; outline: none; user-select: none;
}
.lqm-item[data-highlighted] { background: var(--bg-input-hover); }
.lqm-item[data-disabled] { opacity: .45; cursor: default; }
.lqm-check { width: 14px; flex: none; margin-top: 2px; color: var(--accent-primary); }
.lqm-item-desc { display: block; margin-top: 1px; font-size: 11px; line-height: 1.4; color: var(--text-muted); }
.lqm-sep { height: 1px; margin: 4px 6px; background: var(--border-subtle); }
.lqm-action { color: var(--text-secondary); padding-left: 30px; }
.lqm-empty { padding: 6px 8px; font-size: 12px; color: var(--text-muted); }
`;

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

type PopupButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: React.ReactNode;
  value: string;
  /** 已从默认值改过：值用正文主色，否则用次级色 */
  isSet?: boolean;
  /** 头部模型选择那种更小的胶囊形态 */
  pill?: boolean;
};

/** 弹出按钮：图标 + 当前值 + 上下箭头。作为 DropdownMenu.Trigger 的 asChild 目标，必须转发 ref。 */
export const PopupButton = React.forwardRef<HTMLButtonElement, PopupButtonProps>(function PopupButton(
  { icon, value, isSet, pill, className, ...rest },
  ref,
) {
  React.useLayoutEffect(ensureStyles, []);
  return (
    <button
      ref={ref}
      type="button"
      data-set={isSet ? 'true' : 'false'}
      className={`lqm-trigger${pill ? ' lqm-trigger--pill' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {icon}
      <span className="lqm-trigger-value">{value}</span>
      <ChevronsUpDown size={pill ? 11 : 12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
    </button>
  );
});

export function QuickMenu({
  trigger,
  title,
  note,
  width = 240,
  align = 'start',
  open,
  onOpenChange,
  children,
}: {
  trigger: React.ReactElement;
  title?: string;
  note?: React.ReactNode;
  width?: number;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  React.useLayoutEffect(ensureStyles, []);
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align={align}
          sideOffset={6}
          className="lqm-content"
          style={{ width, maxWidth: `min(92vw, ${width}px)` }}
        >
          {title && <div className="lqm-title">{title}</div>}
          {note && <div className="lqm-note">{note}</div>}
          <div style={{ maxHeight: 300, overflowY: 'auto', overscrollBehavior: 'contain' }}>{children}</div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function QuickMenuItem({
  label,
  description,
  selected,
  disabled,
  onSelect,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      className="lqm-item"
      disabled={disabled}
      onSelect={onSelect}
      aria-checked={selected}
      role="menuitemradio"
    >
      <span className="lqm-check">{selected ? <Check size={14} strokeWidth={2.5} /> : null}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description && <span className="lqm-item-desc">{description}</span>}
      </span>
    </DropdownMenu.Item>
  );
}

/** 菜单最底部的「管理…」类动作：打开完整配置页。 */
export function QuickMenuAction({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <>
      <DropdownMenu.Separator className="lqm-sep" />
      <DropdownMenu.Item className="lqm-item lqm-action" onSelect={onSelect}>
        {label}
      </DropdownMenu.Item>
    </>
  );
}

export function QuickMenuEmpty({ children }: { children: React.ReactNode }) {
  return <div className="lqm-empty">{children}</div>;
}
