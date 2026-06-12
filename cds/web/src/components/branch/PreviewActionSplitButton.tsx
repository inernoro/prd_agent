import type { ReactNode } from 'react';
import { ChevronDown, Eye, ExternalLink, Loader2, Rocket } from 'lucide-react';
import { DropdownDivider, DropdownItem, DropdownLabel, DropdownMenu } from '@/components/ui/dropdown-menu';
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
  releaseLabel = '发布到目标',
  className = '',
  icon,
  fill = false,
}: PreviewActionSplitButtonProps): JSX.Element {
  const mainClassName = [
    'inline-flex h-9 items-center justify-center rounded-l-md border border-emerald-500/35 bg-emerald-500/10 text-emerald-500 transition-colors',
    fill ? 'min-w-0 flex-1 gap-2 px-3 text-sm font-medium' : 'w-10',
    'hover:border-emerald-500/50 hover:bg-emerald-500/15 hover:text-emerald-400',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/35',
    disabled ? 'pointer-events-none opacity-50' : '',
  ].join(' ');
  const menuTrigger = (
    <button
      type="button"
      className={[
        'inline-flex h-9 items-center justify-center rounded-r-md border border-l-0 border-emerald-500/35 bg-emerald-500/10 text-emerald-500 transition-colors',
        fill ? 'w-10' : 'w-7',
        'hover:border-emerald-500/50 hover:bg-emerald-500/15 hover:text-emerald-400',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/35',
        disabled ? 'pointer-events-none opacity-50' : '',
      ].join(' ')}
      disabled={disabled}
      title="更多预览操作"
      aria-label="更多预览操作"
    >
      <ChevronDown className="h-3.5 w-3.5" />
    </button>
  );

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
      <DropdownMenu trigger={menuTrigger} width={210}>
        <DropdownLabel>预览操作</DropdownLabel>
        {previewHref ? (
          <DropdownItem onSelect={() => window.open(previewHref, '_blank', 'noopener,noreferrer')}>
            <ExternalLink className="h-4 w-4" />
            打开预览
          </DropdownItem>
        ) : (
          <DropdownItem onSelect={onPreview} disabled={disabled || !onPreview}>
            <Eye className="h-4 w-4" />
            打开预览
          </DropdownItem>
        )}
        <DropdownDivider />
        <DropdownItem onSelect={onRelease} disabled={disabled || releaseDisabled || !onRelease}>
          <Rocket className="h-4 w-4" />
          {releaseLabel}
        </DropdownItem>
      </DropdownMenu>
    </span>
  );
}
