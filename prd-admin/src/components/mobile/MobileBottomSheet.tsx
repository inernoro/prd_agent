import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AS_COLOR, AS_FONT_FAMILY } from '@/lib/appStoreTokens';

/**
 * 移动端底部 Sheet —— iOS Action Sheet 风。
 *
 * 用途：把桌面端堆在工具栏的次要操作 / 筛选项收纳进底部弹层，
 * 保证移动端「进内容前 ≤1 条控制条」（mobile-first-density 规则）。
 *
 * 遵循 frontend-modal 三硬约束：
 *  - createPortal 到 document.body（脱离任何祖先 overflow/transform）
 *  - 高度走 inline style，滚动区 min-height:0 + overscroll contain
 *  - ESC + 点遮罩关闭
 */
export interface MobileBottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** 标题下方的弱提示说明 */
  note?: string;
  children: React.ReactNode;
}

export function MobileBottomSheet({ open, onClose, title, note, children }: MobileBottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const node = (
    <div
      aria-hidden={!open}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        pointerEvents: open ? 'auto' : 'none',
        fontFamily: AS_FONT_FAMILY,
      }}
    >
      {/* 遮罩 */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          opacity: open ? 1 : 0,
          transition: 'opacity 0.3s ease',
        }}
      />
      {/* Sheet 本体 */}
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          background: '#1c1c1e',
          borderRadius: '22px 22px 0 0',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.4s cubic-bezier(0.32,0.72,0,1)',
          maxHeight: '82%',
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          borderTop: `0.5px solid ${AS_COLOR.hairline}`,
        }}
      >
        <div
          style={{
            width: 38,
            height: 5,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.22)',
            margin: '8px auto 6px',
          }}
        />
        {title && (
          <h3
            style={{
              fontSize: 20,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: AS_COLOR.label,
              padding: '6px 20px 4px',
            }}
          >
            {title}
          </h3>
        )}
        {note && (
          <p style={{ fontSize: 12, color: AS_COLOR.labelTertiary, padding: '0 20px 10px', lineHeight: 1.4 }}>
            {note}
          </p>
        )}
        <div style={{ paddingTop: title ? 4 : 8 }}>{children}</div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

/** Sheet 内的标准操作行 */
export function MobileSheetRow({
  icon,
  label,
  accent,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  accent?: string;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3.5 text-left active:opacity-60 transition-opacity"
      style={{ padding: '14px 20px' }}
    >
      <span
        className="shrink-0 flex items-center justify-center"
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: accent ?? 'rgba(255,255,255,0.10)',
        }}
      >
        {icon}
      </span>
      <span
        style={{
          fontSize: 17,
          fontWeight: 500,
          color: danger ? AS_COLOR.red : AS_COLOR.label,
        }}
      >
        {label}
      </span>
    </button>
  );
}
