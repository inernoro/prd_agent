import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useRef, useCallback, useState } from 'react';
import { glassBottomSheet } from '@/lib/glassStyles';

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children: ReactNode;
  /** auto = 内容自适应, half = 50vh, full = 全屏 */
  height?: 'auto' | 'half' | 'full';
  /** 是否显示拖拽指示条 (默认 true) */
  showDragHandle?: boolean;
  /** 是否可手势下滑关闭 (默认 true) */
  dismissible?: boolean;
  /** 追加 className */
  className?: string;
}

const HEIGHT_MAP: Record<string, string> = {
  auto: 'auto',
  half: '50vh',
  full: 'calc(100vh - 32px)',
};

/**
 * 底部弹出面板 — 移动端弹窗的标准形态。
 * 支持拖拽指示条 + 手势下滑关闭。
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
  height = 'auto',
  showDragHandle = true,
  dismissible = true,
  className,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const isDraggingRef = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!dismissible) return;
    startYRef.current = e.touches[0].clientY;
    isDraggingRef.current = false;
  }, [dismissible]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dismissible) return;
    const dy = e.touches[0].clientY - startYRef.current;
    if (dy < 10) return;

    // 仅在内容滚动到顶部时才可拖拽关闭
    const sheet = sheetRef.current;
    if (sheet) {
      const scrollable = sheet.querySelector('[data-bottom-sheet-body]');
      if (scrollable && scrollable.scrollTop > 0) return;
    }

    isDraggingRef.current = true;
    setDragOffset(Math.max(0, dy));
  }, [dismissible]);

  const handleTouchEnd = useCallback(() => {
    if (!isDraggingRef.current) {
      setDragOffset(0);
      return;
    }
    if (dragOffset > 100) {
      onOpenChange(false);
    }
    setDragOffset(0);
    isDraggingRef.current = false;
  }, [dragOffset, onOpenChange]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-200 prd-bottom-sheet-overlay"
          style={{
            background: 'rgba(0,0,0,0.6)',
            animation: open ? 'fadeIn 200ms ease-out' : undefined,
          }}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          ref={sheetRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className={[
            'fixed left-0 right-0 bottom-0 z-210 flex flex-col outline-none rounded-t-[20px] prd-bottom-sheet-content',
            className ?? '',
          ].join(' ')}
          style={{
            ...glassBottomSheet,
            maxHeight: HEIGHT_MAP[height],
            height: height === 'auto' ? 'auto' : HEIGHT_MAP[height],
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
            transition: isDraggingRef.current ? 'none' : 'transform 200ms ease-out',
            animation: open ? 'slideUp 250ms cubic-bezier(0.32, 0.72, 0, 1)' : undefined,
          }}
        >
          {/* 无标题时提供隐藏的 DialogTitle 满足 Radix 无障碍要求 */}
          {!title && <DialogPrimitive.Title className="sr-only">面板</DialogPrimitive.Title>}

          {/* 拖拽指示条 */}
          {showDragHandle && (
            <div className="flex justify-center pt-3 pb-1">
              <div
                className="rounded-full"
                style={{
                  width: 36,
                  height: 4,
                  background: 'rgba(255,255,255,0.2)',
                }}
              />
            </div>
          )}

          {/* 标题栏 */}
          {title && (
            <div className="flex items-center justify-between px-5 pt-2 pb-3">
              <DialogPrimitive.Title className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                className="h-9 w-9 inline-flex items-center justify-center rounded-xl hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
                aria-label="关闭"
              >
                <X size={18} />
              </DialogPrimitive.Close>
            </div>
          )}

          {/* 内容区 */}
          <div data-bottom-sheet-body="" className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
