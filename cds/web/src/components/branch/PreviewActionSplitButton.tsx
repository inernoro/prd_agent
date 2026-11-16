import type { ReactNode } from 'react';
import { ChevronDown, Eye, Loader2, Rocket } from 'lucide-react';
import { ConfirmAction } from '@/components/ui/confirm-action';

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
    <span className={`${fill ? 'flex min-w-0' : 'inline-flex'} flex-wrap items-center gap-2 ${className}`}>
      {mainAction}
      {onRelease ? (
        <button type="button" disabled={disabled || releaseDisabled}
          className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:opacity-50"
          onClick={(event) => { event.stopPropagation(); onRelease(); }}>
          <Rocket className="h-4 w-4" />{releaseLabel}<ChevronDown className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </span>
  );
}
