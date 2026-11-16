import type { ReactNode } from 'react';
import { ChevronDown, Eye, Loader2, Rocket } from 'lucide-react';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DropdownItem, DropdownMenu } from '@/components/ui/dropdown-menu';

type PreviewActionSplitButtonProps = {
  disabled?: boolean;
  loading?: boolean;
  previewHref?: string;
  previewLabel?: string;
  previewTitle?: string;
  previewAriaLabel?: string;
  previewConfirmTitle?: ReactNode;
  previewConfirmDescription?: ReactNode;
  previewConfirmLabel?: string;
  onPreview?: () => void;
  onRelease?: () => void;
  releaseDisabled?: boolean;
  releaseLabel?: string;
  className?: string;
  icon?: ReactNode;
  fill?: boolean;
};

export function PreviewActionSplitButton({
  disabled = false,
  loading = false,
  previewHref,
  previewLabel,
  previewTitle = '预览',
  previewAriaLabel = '预览',
  previewConfirmTitle,
  previewConfirmDescription,
  previewConfirmLabel = '继续',
  onPreview,
  onRelease,
  releaseDisabled = false,
  releaseLabel = '发布到',
  className = '',
  icon,
  fill = false,
}: PreviewActionSplitButtonProps): JSX.Element {
  const mainClassName = [
    'inline-flex h-9 items-center justify-center rounded-md border border-ok/35 bg-ok-soft text-ok transition-colors',
    onRelease ? 'rounded-r-none border-r-0' : '',
    fill ? 'min-w-0 flex-1 gap-2 px-3 text-sm font-medium' : 'w-10',
    'hover:border-ok/50 hover:bg-ok-soft hover:text-ok',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ok/35',
    disabled ? 'pointer-events-none opacity-50' : '',
  ].join(' ');
  const mainIcon = loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon || <Eye className="h-4 w-4" />;

  const mainButton = previewHref && !disabled ? (
    <a
      href={previewHref}
      target="_blank"
      rel="noreferrer"
      className={mainClassName}
      title={previewTitle}
      aria-label={previewAriaLabel}
      onClick={(event) => event.stopPropagation()}
    >
      {mainIcon}
      {previewLabel ? <span className="truncate">{previewLabel}</span> : null}
    </a>
  ) : (
    <button
      type="button"
      className={mainClassName}
      disabled={disabled}
      title={previewTitle}
      aria-label={previewAriaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onPreview?.();
      }}
    >
      {mainIcon}
      {previewLabel ? <span className="truncate">{previewLabel}</span> : null}
    </button>
  );

  const mainAction = previewConfirmTitle && !previewHref ? (
    <ConfirmAction
      title={previewConfirmTitle}
      description={previewConfirmDescription}
      confirmLabel={previewConfirmLabel}
      disabled={disabled || !onPreview}
      onConfirm={() => onPreview?.()}
      trigger={mainButton}
    />
  ) : mainButton;

  return (
    <span className={`${fill ? 'flex min-w-0' : 'inline-flex'} items-center ${className}`}>
      {mainAction}
      {onRelease ? (
        <DropdownMenu trigger={
          <button type="button" disabled={disabled} aria-label="预览更多操作" title="预览更多操作" aria-haspopup="menu"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-r-md border border-ok/35 bg-ok-soft text-ok transition-colors hover:border-ok/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ok/35 disabled:opacity-50">
            <ChevronDown className="h-5 w-5" />
          </button>
        }>
          <DropdownItem disabled={disabled || releaseDisabled} onSelect={onRelease}>
            <Rocket className="h-4 w-4" /><span>{releaseLabel}<span className="mt-0.5 block text-xs text-muted-foreground">当前分支 · 逐目标发布</span></span>
          </DropdownItem>
        </DropdownMenu>
      ) : null}
    </span>
  );
}
