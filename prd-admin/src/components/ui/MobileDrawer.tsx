import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useRef, useCallback } from 'react';
import { glassSidebar } from '@/lib/glassStyles';

interface MobileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** 抽屉宽度, 默认 280px */
  width?: number;
  /** 从哪侧滑出, 默认 left */
  side?: 'left' | 'right';
}

/**
 * 移动端侧滑抽屉导航。
 * 基于 Radix Dialog (modal)，带手势滑动关闭。
 */
export function MobileDrawer({ open, onOpenChange, children, width = 280, side = 'left' }: MobileDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const currentXRef = useRef(0);
  const isDraggingRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    currentXRef.current = 0;
    isDraggingRef.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - startXRef.current;
    const shouldClose = side === 'left' ? dx < -20 : dx > 20;
    if (!shouldClose) return;

    isDraggingRef.current = true;
    currentXRef.current = dx;
    const panel = panelRef.current;
    if (!panel) return;

    const offset = side === 'left' ? Math.min(0, dx) : Math.max(0, dx);
    panel.style.transform = `translateX(${offset}px)`;
    panel.style.transition = 'none';
  }, [side]);

  const handleTouchEnd = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;

    panel.style.transition = '';
    panel.style.transform = '';

    if (!isDraggingRef.current) return;

    const threshold = width * 0.35;
    const shouldClose = side === 'left'
      ? currentXRef.current < -threshold
      : currentXRef.current > threshold;

    if (shouldClose) {
      onOpenChange(false);
    }
    isDraggingRef.current = false;
  }, [width, side, onOpenChange]);

  const isLeft = side === 'left';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-200 prd-mobile-drawer-overlay"
          style={{
            background: 'rgba(0,0,0,0.6)',
            animation: open ? 'fadeIn 200ms ease-out' : undefined,
          }}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          ref={panelRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="fixed top-0 bottom-0 z-210 flex flex-col outline-none prd-mobile-drawer-content"
          style={{
            ...glassSidebar,
            width,
            [isLeft ? 'left' : 'right']: 0,
            animation: open
              ? `slideIn${isLeft ? 'Left' : 'Right'} 250ms cubic-bezier(0.32, 0.72, 0, 1)`
              : undefined,
            paddingTop: 'env(safe-area-inset-top, 0px)',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          <DialogPrimitive.Title className="sr-only">导航菜单</DialogPrimitive.Title>
          <div className="flex items-center justify-end px-3 pt-2 pb-1">
            <DialogPrimitive.Close
              className="h-9 w-9 inline-flex items-center justify-center rounded-xl hover:bg-white/5"
              style={{ color: 'var(--text-secondary)' }}
              aria-label="关闭"
            >
              <X size={18} />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
