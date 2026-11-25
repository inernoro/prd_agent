import { useEffect, useRef, useState } from 'react';
import { FileText, ImageIcon, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getAttachmentPreview, type UploadedAttachment } from '@/services/real/aiToolbox';
import {
  attachmentBadge,
  DESIGN_ATTACHMENT_ACCEPT,
  formatAttachmentSize,
  type DesignAttachmentItem,
} from '../designAttachments';

const imageExtensions = DESIGN_ATTACHMENT_ACCEPT.image.split(',');
const isImage = (name: string) => imageExtensions.some((extension) => name.toLowerCase().endsWith(extension));
const fileMeta = (name: string, size: number) => [attachmentBadge(name), size > 0 ? formatAttachmentSize(size) : ''].filter(Boolean).join(' · ');
const documentTints: Record<string, string> = {
  PDF: 'var(--semantic-success-soft)',
  DOC: 'var(--semantic-info-soft)',
  DOCX: 'var(--semantic-info-soft)',
  MD: 'var(--semantic-warning-soft)',
};

function AttachmentPreview({ item, onClose, returnFocus }: {
  item: DesignAttachmentItem;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const image = isImage(item.fileName);
  const localUrl = image ? item.thumbnailUrl || item.url : undefined;
  const hasLocalPreview = Boolean(localUrl) || (!image && item.textPreview != null);
  const [remote, setRemote] = useState<UploadedAttachment | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (hasLocalPreview || !item.attachmentId) return;
    let current = true;
    void getAttachmentPreview(item.attachmentId).then((result) => {
      if (!current) return;
      if (result.success) setRemote(result.data);
      else setFailed(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [attempt, hasLocalPreview, item.attachmentId]);

  const loading = !hasLocalPreview && !remote && !failed && Boolean(item.attachmentId);
  const url = localUrl || (image ? remote?.url : undefined);
  const text = remote?.textPreview ?? item.textPreview;
  const truncated = remote?.previewTruncated ?? item.previewTruncated;
  const Icon = image ? ImageIcon : FileText;

  return (
    <Dialog
      open
      title={
        <span className="flex min-w-0 items-center gap-2 break-all">
          <Icon size={16} className="shrink-0" aria-hidden />
          <span>{item.fileName}</span>
        </span>
      }
      maxWidth={600}
      zIndex={110}
      onOpenChange={(open) => { if (!open) onClose(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}
      content={(
        <div className="flex flex-col gap-3">
          <p className="text-[11px] text-token-muted">{fileMeta(item.fileName, remote?.size ?? item.size)}</p>
          {loading ? (
            <p role="status" className="flex items-center gap-2 py-6 text-sm text-token-secondary"><MapSpinner size={14} />正在读取附件预览</p>
          ) : url && !imageFailed ? (
            <img src={url} referrerPolicy="no-referrer" alt={item.fileName} onError={() => setImageFailed(true)} className="max-h-[65dvh] w-full rounded-lg object-contain" />
          ) : text ? (
            <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-4">
              {truncated && <p className="mb-3 text-[11px] text-token-muted">显示正文开头</p>}
              <p className="max-h-[55dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-token-primary">{text}</p>
            </div>
          ) : (
            <div role="status" className="flex flex-wrap items-center gap-2 py-5 text-sm text-token-secondary">
              {failed || imageFailed ? '暂时打不开附件预览。' : '这份附件没有可预览的正文。'}
              {failed && (
                <button type="button" className="rounded-md px-2 py-1 font-semibold hover-bg-soft" onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>
                  重试打开
                </button>
              )}
            </div>
          )}
        </div>
      )}
    />
  );
}

export function WorkbenchAttachments({ items, disabled, onRemove, onRetry, onReplace }: {
  items: readonly DesignAttachmentItem[];
  disabled?: boolean;
  onRemove?: (key: string) => void;
  onRetry?: (key: string) => void;
  onReplace?: (key: string) => void;
}) {
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const preview = items.find((item) => item.key === previewKey);
  const ready = items.filter((item) => item.status === 'ready');
  const pending = items.filter((item) => item.status !== 'ready');
  if (items.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5" aria-label={onRemove ? '待发送的附件' : '已发送的附件'}>
      {ready.length > 0 && (
        <ul className="grid grid-cols-3 gap-1.5">
          {ready.map((item) => {
            const image = isImage(item.fileName);
            const badge = attachmentBadge(item.fileName);
            const src = image ? item.thumbnailUrl || item.url : undefined;
            const Icon = image ? ImageIcon : FileText;
            return (
              <li key={item.key} className="relative min-w-0">
                <button
                  type="button"
                  aria-label={`预览 ${item.fileName}`}
                  title={item.fileName}
                  onClick={(event) => { triggerRef.current = event.currentTarget; setPreviewKey(item.key); }}
                  className="block w-full overflow-hidden rounded-[9px] border border-[color:var(--border-subtle)] bg-[var(--bg-card)] text-left transition-colors hover:border-[color:var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2"
                >
                  <span
                    aria-hidden
                    className="flex h-[64px] items-end justify-center overflow-hidden px-3"
                    style={{ background: documentTints[badge] ?? 'var(--bg-tertiary)' }}
                  >
                    {src ? (
                      <img src={src} alt="" referrerPolicy="no-referrer" className="my-1 h-[56px] w-full rounded-sm object-contain" />
                    ) : (
                      <span className="flex h-12 w-full max-w-[75px] flex-col gap-1 overflow-hidden rounded-t border border-b-0 border-[color:var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-sm">
                        <span className="flex items-center gap-1 text-[8px] font-semibold leading-tight text-token-secondary"><Icon size={9} />{badge}</span>
                        {item.textPreview && <span className="line-clamp-3 break-words text-[6px] leading-[8px] text-token-muted">{item.textPreview}</span>}
                      </span>
                    )}
                  </span>
                  <span className="block min-w-0 px-2 py-1.5">
                    <span className="block truncate text-[11px] font-semibold text-token-primary">{item.fileName}</span>
                    <span className="block truncate text-[10px] text-token-muted">{fileMeta(item.fileName, item.size)}</span>
                  </span>
                </button>
                {onRemove && (
                  <button aria-label={`移除 ${item.fileName}`} type="button" disabled={disabled} onClick={() => onRemove(item.key)} className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[var(--bg-elevated)] text-token-secondary hover-bg-soft disabled:opacity-45">
                    <X size={13} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pending.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {pending.map((item) => {
            const failure = item.status === 'failed';
            const uploading = item.status === 'uploading';
            const fix = item.canRetry ? onRetry : onReplace;
            return (
              <li key={item.key} className="rounded-lg border px-2.5 py-1.5 text-[11px]" style={{
                background: failure ? 'var(--semantic-danger-soft)' : 'var(--bg-secondary)',
                borderColor: failure ? 'var(--semantic-danger-border)' : 'var(--border-subtle)',
              }}>
                <div className="flex items-center gap-2">
                  {failure ? <FileText size={14} className="shrink-0 text-token-secondary" aria-hidden /> : <MapSpinner size={13} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-token-primary" title={item.fileName}>{item.fileName}</p>
                    <p style={{ color: failure ? 'var(--semantic-danger-text)' : 'var(--text-secondary)' }}>
                      {failure ? item.error : uploading ? '正在上传' : isImage(item.fileName) ? '正在保存截图' : '正在读取正文'}
                    </p>
                  </div>
                  {failure && fix && <button type="button" onClick={() => fix(item.key)} disabled={disabled} className="shrink-0 rounded-md px-2 py-1.5 font-semibold text-token-primary hover-bg-soft">{item.canRetry ? '重试上传' : '重新选择'}</button>}
                  {onRemove && <button type="button" aria-label={`移除 ${item.fileName}`} onClick={() => onRemove(item.key)} disabled={disabled} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-token-secondary hover-bg-soft"><X size={13} aria-hidden /></button>}
                </div>
                {uploading && (
                  <div className="mt-1 flex items-center gap-2">
                    <progress className="h-1 min-w-0 flex-1 accent-[var(--accent-primary)]" value={item.progress} max={100} aria-label={`${item.fileName} 上传进度`} />
                    <span className="tabular-nums text-token-secondary">{item.progress}%</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {preview && <AttachmentPreview key={preview.key} item={preview} onClose={() => setPreviewKey(null)} returnFocus={() => triggerRef.current?.focus()} />}
    </div>
  );
}
