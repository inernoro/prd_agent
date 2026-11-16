import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export type ContextMenuItem = {
  key: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  onClick?: () => void;
};

type ContextMenuProps = {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  label?: string;
  minWidth?: number;
};

function ContextMenuPortal({ items, x, y, onClose, anchorRef, label = '操作菜单', minWidth = 140 }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    // 调整位置避免超出视口
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + rect.width > window.innerWidth - 8) {
      nx = window.innerWidth - rect.width - 8;
    }
    if (y + rect.height > window.innerHeight - 8) {
      ny = window.innerHeight - rect.height - 8;
    }
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchorRef?.current?.contains(target)) onClose();
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, anchorRef]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); anchorRef?.current?.focus(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
      className="surface-popover fixed z-[9999] min-w-[140px] py-1 rounded-[14px]"
      style={{
        left: pos.x,
        top: pos.y,
        minWidth,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100dvh - 16px)',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      {items.map((item) =>
        item.divider ? (
          <div
            key={item.key}
            className="mx-2 my-1 h-px border-t border-token-subtle"
          />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={[
              'w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 max-sm:min-h-11',
              'transition-colors duration-100',
              item.disabled
                ? 'opacity-40 cursor-not-allowed'
                : 'hover-bg-soft cursor-pointer',
              item.danger ? 'text-token-error hover:bg-red-500/15' : 'text-token-primary',
            ].join(' ')}
            onClick={(e) => {
              e.stopPropagation();
              if (!item.disabled && item.onClick) {
                item.onClick();
                onClose();
              }
            }}
          >
            {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  );
}

export type ContextMenuState = {
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
};

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    items: [],
  });

  const show = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ visible: true, x: e.clientX, y: e.clientY, items });
  }, []);

  const hide = useCallback(() => {
    setState((s) => ({ ...s, visible: false }));
  }, []);

  const Menu = state.visible ? (
    <ContextMenuPortal items={state.items} x={state.x} y={state.y} onClose={hide} />
  ) : null;

  return { show, hide, Menu };
}

export default ContextMenuPortal;
