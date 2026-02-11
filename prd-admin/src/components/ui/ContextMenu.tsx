import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { glassPanel } from '@/lib/glassStyles';

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
};

function ContextMenuPortal({ items, x, y, onClose }: ContextMenuProps) {
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
  }, [x, y]);

  useEffect(() => {
    const handleClick = () => onClose();
    const handleContextMenu = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[140px] py-1 rounded-[14px] shadow-lg"
      style={{
        ...glassPanel,
        left: pos.x,
        top: pos.y,
      }}
    >
      {items.map((item) =>
        item.divider ? (
          <div
            key={item.key}
            className="mx-2 my-1 h-px"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          />
        ) : (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            className={[
              'w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2',
              'transition-colors duration-100',
              item.disabled
                ? 'opacity-40 cursor-not-allowed'
                : 'hover:bg-white/8 cursor-pointer',
              item.danger ? 'text-red-400 hover:bg-red-500/15' : '',
            ].join(' ')}
            style={{ color: item.danger ? undefined : 'var(--text-primary)' }}
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
