import type { ReactNode } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { Dialog } from './Dialog';
import { BottomSheet } from './BottomSheet';
import type { BottomSheetProps } from './BottomSheet';

interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: string;
  content: React.ReactNode;
  /** 桌面端弹窗最大宽度, 默认 520px */
  maxWidth?: number | string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  titleAction?: React.ReactNode;
  titleCenter?: React.ReactNode;
  /** 移动端 BottomSheet 高度, 默认 auto */
  mobileHeight?: BottomSheetProps['height'];
}

/**
 * 响应式弹窗 — 桌面端 = 居中 Dialog, 移动端 = BottomSheet 自动切换。
 * API 与 Dialog 完全兼容, 可直接替换。
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  content,
  maxWidth,
  contentClassName,
  contentStyle,
  titleAction,
  titleCenter,
  mobileHeight = 'auto',
}: ResponsiveDialogProps) {
  const { isMobile } = useBreakpoint();

  if (isMobile) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        height={mobileHeight}
      >
        {description && (
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>{description}</p>
        )}
        {content}
      </BottomSheet>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      content={content}
      maxWidth={maxWidth}
      contentClassName={contentClassName}
      contentStyle={contentStyle}
      titleAction={titleAction}
      titleCenter={titleCenter}
    />
  );
}
