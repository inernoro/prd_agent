import { useEffect, useRef, useState } from 'react';
import { History, RotateCcw, MessageSquare, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { HostedReviewSource, HostedReviewVersion } from '@/services/real/webPages';
import { useHostedReview, type HostedReview } from './useHostedReview';
import { canUseSrcDocPreview, directPreviewSandbox, SRCDOC_PREVIEW_SANDBOX, withPreviewBase } from './previewHtml';
import { withAnnotationRuntime } from './useHostedAnnotations';
import { AnnotationBubble } from './AnnotationBubble';
import CommentsSection from './CommentsSection';

/** A separate read context keeps the current page, scroll position and drafts intact. */
export function ReviewVersionPreview({ site, source, versionId, commentId, versions: history, onVersionChange, canRestore, restoring, restoreError, onRestore, onClose, onReturnFocus }: {
  site: NonNullable<HostedReview['liveSite']>; source: HostedReviewSource; versionId: string; canRestore: boolean;
  restoring: boolean; restoreError: string | null; onRestore: (key: string) => Promise<boolean>; onClose: () => void;
  commentId?: string;
  versions?: HostedReviewVersion[];
  onVersionChange?: (id: string) => void;
  onReturnFocus?: (event: Event) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [commentsOverride, setCommentsOverride] = useState<boolean | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const showComments = commentsOverride ?? count > 0;
  const restoreKeys = useRef(new Map<string, string>());
  const review = useHostedReview(frame, site, source, () => setCommentsOverride(true));
  const { versions, selectVersion } = review;
  const selected = useRef<{ id: string; commentId?: string } | null>(null);
  useEffect(() => {
    if (!versions.some(version => version.id === versionId)) return;
    if (selected.current?.id === versionId && selected.current.commentId === commentId) return;
    selected.current = { id: versionId, commentId }; void selectVersion(versionId, commentId);
  }, [versionId, commentId, versions, selectVersion]);
  const version = versions.find(version => version.id === versionId) ?? history?.find(version => version.id === versionId);
  const previewReady = review.selected?.id === versionId && !review.loading && !!review.preview;
  const html = previewReady && review.preview?.html && review.site?.contentShape === 'self-contained-html' && canUseSrcDocPreview(review.preview.html)
    ? withAnnotationRuntime(withPreviewBase(review.preview.html, review.previewBaseUrl!)) : undefined;
  const error = review.error || restoreError;
  const restore = async () => {
    const key = restoreKeys.current.get(versionId) ?? crypto.randomUUID();
    restoreKeys.current.set(versionId, key);
    if (await onRestore(key)) onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open && !restoring) onClose(); }} title={<><History size={16} />{version?.versionLabel ?? '历史版本'} · 版本预览</>}
    onCloseAutoFocus={onReturnFocus}
    zIndex={2147483646} maxWidth={920} contentClassName="review-history-dialog" contentStyle={{ maxHeight: 'calc(100dvh - 30px)' }}
    titleAction={<button type="button" className="review-tool" aria-label="查看此版本批注" aria-expanded={previewReady && showComments} disabled={!previewReady} onClick={() => setCommentsOverride(!showComments)}><MessageSquare size={14} />批注 {previewReady && count || ''}</button>}
    content={<div className="review-history-layout">
      {history && history.length > 0 && <nav className="review-history-versions" aria-label="历史版本列表">
        {history.map(item => <button type="button" key={item.id} aria-current={item.id === versionId ? 'true' : undefined}
          disabled={restoring || (!item.isCurrent && !item.canPreview)} onClick={() => {
            if (item.isCurrent) { onClose(); return; }
            if (item.id === versionId) return;
            setConfirmVersion(null); setCommentsOverride(null); setCount(0); onVersionChange?.(item.id);
          }}>
          <span><strong>{item.versionLabel}</strong><small className={item.isCurrent ? 'is-current' : ''}>{item.isCurrent ? '当前发布' : item.canPreview ? '历史版本' : '原文不可预览'}</small></span>
          {item.publishedAt && <time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>}
        </button>)}
      </nav>}
      <div className="review-history-reader">
      {version && <div className="review-history-context"><strong>{version.versionLabel}</strong><span>历史预览</span></div>}
      <div className="review-version-preview">
      <div className="review-document-stage review-history-document">
      {previewReady ? <iframe ref={frame} title={`${version?.versionLabel} 网页预览`} srcDoc={html} src={html ? undefined : review.site?.siteUrl || undefined}
        sandbox={html ? SRCDOC_PREVIEW_SANDBOX : directPreviewSandbox(review.site?.siteUrl ?? '')} referrerPolicy="no-referrer" onLoad={review.annotations.notifyFrame}
        className="w-full" style={{ height: '100%', border: 0, background: 'var(--bg-elevated)' }} />
        : <div className="review-empty" role="status">{review.error ? <><p>{review.error}</p><button type="button" className="review-tool" onClick={() => { if (version) void review.selectVersion(versionId, commentId); else void review.refresh(); }}>重试预览</button></> : <><MapSpinner size={20} /><p>正在预览历史版本…</p></>}</div>}
      <AnnotationBubble annotations={review.annotations} hidden={showComments} />
      </div>
      {previewReady && <aside className="review-sidebar review-history-comments review-b-surface" hidden={!showComments}>
        <div className="review-sidebar-heading"><span>此版本批注</span><button type="button" aria-label="收起此版本批注" onClick={() => setCommentsOverride(false)}><X size={16} /></button></div>
        <div style={{ flex: 1, minHeight: 0 }}><CommentsSection visible={showComments} {...(source.mode === 'share' ? { mode: 'share', token: source.token, siteId: source.siteId, password: source.password } : { mode: 'site', siteId: source.siteId })}
          annotations={review.annotations} review={review} splitLayout versionOnly onThreadCountsChange={counts => setCount(counts.annotations + counts.discussions)} onPickElement={() => setCommentsOverride(false)} /></div>
      </aside>}
      </div>
      </div>
    </div>}
    actions={<div className="review-version-preview-actions">
      {error && <p role="alert">{error}</p>}
      {canRestore && previewReady && !version?.isCurrent && (confirmVersion === versionId ? <>
        <p>将 {version?.versionLabel} 的内容作为新版本发布。现有版本保留，旧批注仍留在原版本。</p>
        <button type="button" className="review-tool" disabled={restoring} onClick={() => setConfirmVersion(null)}>取消</button>
        <button type="button" className="review-send-action" disabled={restoring} onClick={() => void restore()}>{restoring ? <MapSpinner size={14} /> : <RotateCcw size={14} />}{restoring ? '正在恢复…' : '确认恢复并发布'}</button>
      </> : <button type="button" className="review-tool" onClick={() => setConfirmVersion(versionId)}><RotateCcw size={14} />恢复为当前版本</button>)}
      <button type="button" className="review-tool review-history-return" disabled={restoring} onClick={onClose}>返回当前页</button>
    </div>} />;
}
