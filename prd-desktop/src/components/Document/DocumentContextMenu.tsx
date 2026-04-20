import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface DocumentContextMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface Props {
  /** 菜单锚点坐标（视口坐标系） */
  x: number;
  y: number;
  items: DocumentContextMenuItem[];
  onClose: () => void;
}

/**
 * 通用右键菜单：锚定到 document.body，点击外部/ESC 关闭。
 * 遵循 frontend-modal.md：createPortal + inline style + min-h:0（此处不需要滚动）。
 */
export default function DocumentContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 简单边界约束，避免菜单超出视口
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const width = 180;
  const estimatedHeight = Math.max(40, items.length * 36 + 8);
  const left = Math.min(x, Math.max(0, vw - width - 8));
  const top = Math.min(y, Math.max(0, vh - estimatedHeight - 8));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="ui-glass-modal rounded-lg border border-black/10 dark:border-white/10 shadow-lg overflow-hidden"
      style={{ position: 'fixed', left, top, width, zIndex: 2000 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ul className="py-1">
        {items.map((it) => (
          <li key={it.key}>
            <button
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return;
                it.onClick();
                onClose();
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                it.danger
                  ? 'text-red-500 hover:bg-red-500/10'
                  : 'text-text-primary hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {it.icon ? <span className="shrink-0 w-4 h-4 inline-flex items-center justify-center">{it.icon}</span> : null}
              <span className="truncate">{it.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
