import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, ChevronDown, History, Upload, RefreshCw } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { HostedReview } from './useHostedReview';
import { ReviewVersionPreview, type ReviewHistoryPlacement } from './ReviewVersionPreview';

const versionDate = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function openReviewHistory(review: HostedReview) {
  const next = review.versions.find(version => !version.isCurrent)
    ?? review.selected ?? review.versions.find(version => version.isCurrent);
  if (next) review.setVersionPreview({ id: next.id });
}

export function ReviewVersionBar({ review, canUpload, renderPreview = true, readerToolbar = false, readerStage }: {
  review: HostedReview; canUpload: boolean; renderPreview?: boolean; readerToolbar?: boolean; readerStage?: RefObject<HTMLElement>;
}) {
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const historyPosition = useRef<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [historyUpload, setHistoryUpload] = useState(false);
  const { width } = useBreakpoint();
  const mobileReaderToolbar = readerToolbar && width < 768;
  const busy = review.loading || review.uploading;
  const directHistory = readerToolbar && !!review.selected;
  const expanded = directHistory ? !!review.versionPreview : open;
  const restoredFrom = readerToolbar && review.selected?.restoredFromRevisionId
    ? review.versions.find(version => version.id === review.selected?.restoredFromRevisionId)
    : undefined;
  const selectedLabel = review.selected?.versionLabel;
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [open]);
  useEffect(() => { if (!review.versionPreview) setHistoryUpload(false); }, [review.versionPreview]);
  return <div className="review-version-control" onKeyDownCapture={event => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="review-tool review-version-trigger max-sm:min-h-11" aria-label={`网页版本：${selectedLabel ?? '加载中'}`}
      aria-haspopup={directHistory ? 'dialog' : 'listbox'} aria-expanded={expanded}
      onClick={() => {
        if (!directHistory) setOpen(value => !value);
        else if (!review.uploading) {
          if (review.versionPreview) review.setVersionPreview(null);
          else openReviewHistory(review);
        }
      }} title="查看历史版本">
      {busy ? <MapSpinner size={14} /> : <History size={14} />}
      {review.selected && <span className="review-version-reading">正在阅读</span>}
      <strong>{selectedLabel ?? '版本'}</strong>
      {review.selected && <span className={`review-version-state${review.historical ? '' : ' is-current'}`}>{review.historical
        ? '历史版' : restoredFrom ? `由 ${restoredFrom.versionLabel} 恢复` : readerToolbar ? '当前版本' : '当前版'}</span>}
      {review.selected?.publishedAt && <time className="review-version-date" dateTime={review.selected.publishedAt}>{versionDate(review.selected.publishedAt)}</time>}
      <ChevronDown size={12} className={expanded ? 'review-chevron-open' : ''} />
    </button>
    <AnchoredMenu open={open && !directHistory} onClose={() => setOpen(false)} anchorRef={trigger} gap={mobileReaderToolbar ? 54 : 6} minWidth={260} className={`review-popover review-version-popover${trigger.current?.closest('.surface-tone-dark') ? ' surface-tone-dark' : ''}`} style={{ width: 280, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(420px, calc(100dvh - 88px))', overflow: 'hidden', display: 'flex', flexDirection: 'column', zIndex: 2147483647 }}>
      <div className="review-popover-heading"><strong>网页版本</strong>{review.versions.some(version => version.historyRestricted) && <p>当前权限仅开放当前版本</p>}</div>
      <div ref={list} role="listbox" aria-label="网页版本" className="review-version-list" onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }}>
        {!review.versions.length && <p className="review-menu-empty">{review.error ? '暂时无法读取版本记录' : '正在读取版本记录…'}</p>}
        {review.versions.map(version => <button key={version.id} type="button" role="option" aria-selected={review.selected?.id === version.id}
          disabled={busy || (!version.canPreview && !version.isCurrent)} className="review-version-option" onClick={() => {
            if (version.isCurrent) void review.selectVersion(version.id); else review.setVersionPreview({ id: version.id });
            setOpen(false); trigger.current?.focus();
          }}>
          <span className="review-timeline-dot" />
          <span className="review-version-copy"><span><strong>{version.versionLabel}</strong><span>{version.isCurrent ? '当前发布' : '历史版本'}</span></span>
            <time dateTime={version.publishedAt ?? undefined}>{version.publishedAt ? versionDate(version.publishedAt) : ''}</time>
            {!version.canPreview && !version.isCurrent && <small>原文不可预览</small>}</span>
          {review.selected?.id === version.id && <Check size={15} />}
        </button>)}
      </div>
      {canUpload && <div className="review-menu-footer"><button type="button" className="review-upload-action" onClick={() => input.current?.click()} disabled={busy}>
        {review.uploading ? <MapSpinner size={15} /> : <Upload size={15} />}{review.uploading ? '正在保存新版本…' : '上传新版本'}
        <span>HTML / ZIP</span>
      </button></div>}
      {review.error && <div role="alert" className="review-version-error"><span>{review.error}</span><button type="button" aria-label="重试加载版本" onClick={() => void review.refresh()}><RefreshCw size={14} /></button></div>}
    </AnchoredMenu>
    {readerToolbar && directHistory && !review.versionPreview && review.error && <span className="review-version-error" role="alert">{review.error}</span>}
    {canUpload && <input ref={input} type="file" accept=".html,.htm,.zip" className="hidden" aria-label="上传新版本文件" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      const fromHistory = readerToolbar && !!review.versionPreview;
      setHistoryUpload(fromHistory);
      void review.upload(file).then(success => { if (success && fromHistory) review.setVersionPreview(null); });
    }} />}
    {renderPreview && <ReviewVersionPreviewHost review={review} canRestore={canUpload}
      placement={readerToolbar ? { trigger, stage: readerStage, lastPosition: historyPosition } : undefined}
      uploadError={historyUpload ? review.error : null} uploading={historyUpload && review.uploading}
      onUpload={canUpload ? () => input.current?.click() : undefined} onReturnFocus={event => {
      const button = trigger.current;
      if (button?.isConnected) { event.preventDefault(); button.focus({ preventScroll: true }); }
    }} />}
  </div>;
}

/** A reader with responsive copies of its toolbar owns this host only once. */
export function ReviewVersionPreviewHost({ review, canRestore, placement, onUpload, uploadError, uploading, onClose, onReturnFocus }: {
  review: HostedReview; canRestore: boolean; placement?: ReviewHistoryPlacement; onUpload?: () => void; uploadError?: string | null; uploading?: boolean;
  onClose?: () => void; onReturnFocus?: (event: Event) => void;
}) {
  const target = review.versionPreview;
  return target && review.source && review.liveSite ? <ReviewVersionPreview key={review.liveSite.id} versionId={target.id} commentId={target.commentId} site={review.liveSite} source={review.source}
    placement={placement} onUpload={onUpload} uploadError={uploadError} uploading={uploading}
    versions={review.versions} onVersionChange={id => review.setVersionPreview({ id })} canRestore={canRestore} restoring={review.uploading}
    restoreError={review.restoreError} onRestore={key => review.restoreVersion(target.id, key)} onClose={onClose ?? (() => review.setVersionPreview(null))} onReturnFocus={onReturnFocus} /> : null;
}
