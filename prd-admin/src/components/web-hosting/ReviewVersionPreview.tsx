import { useEffect, useRef, useState } from 'react';
import { RotateCcw, MessageSquare, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { HostedReviewSource } from '@/services/real/webPages';
import { useHostedReview, type HostedReview } from './useHostedReview';
import { canUseSrcDocPreview, directPreviewSandbox, SRCDOC_PREVIEW_SANDBOX, withPreviewBase } from './previewHtml';
import { withAnnotationRuntime } from './useHostedAnnotations';
import { AnnotationBubble } from './AnnotationBubble';
import CommentsSection from './CommentsSection';

/** A separate read context keeps the current page, scroll position and drafts intact. */
export function ReviewVersionPreview({ site, source, versionId, commentId, canRestore, restoring, restoreError, onRestore, onClose }: {
  site: NonNullable<HostedReview['liveSite']>; source: HostedReviewSource; versionId: string; canRestore: boolean;
  restoring: boolean; restoreError: string | null; onRestore: (key: string) => Promise<boolean>; onClose: () => void;
  commentId?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [showComments, setShowComments] = useState(false), [confirm, setConfirm] = useState(false);
  const [count, setCount] = useState(0);
  const key = useRef(crypto.randomUUID());
  const review = useHostedReview(frame, site, source, () => setShowComments(true));
  const { versions, selectVersion } = review;
  const selected = useRef(false);
  useEffect(() => {
    if (selected.current || !versions.some(version => version.id === versionId)) return;
    selected.current = true; void selectVersion(versionId, commentId);
  }, [versionId, commentId, versions, selectVersion]);
  const version = review.versions.find(version => version.id === versionId);
  const previewReady = review.selected?.id === versionId && !review.loading && !!review.preview;
  const html = previewReady && review.preview?.html && review.site?.contentShape === 'self-contained-html' && canUseSrcDocPreview(review.preview.html)
    ? withAnnotationRuntime(withPreviewBase(review.preview.html, review.previewBaseUrl!)) : undefined;
  const error = review.error || restoreError;
  const restore = async () => { if (await onRestore(key.current)) onClose(); };
  return <Dialog open onOpenChange={open => { if (!open && !restoring) onClose(); }} title={`${version?.versionLabel ?? '历史版本'} · 版本预览`}
    zIndex={2147483646} maxWidth={920} contentStyle={{ width: 'min(920px, 92vw)', maxHeight: 'calc(100dvh - 32px)' }}
    titleAction={<button type="button" className="review-tool" aria-label="查看此版本批注" disabled={!previewReady} onClick={() => setShowComments(value => !value)}><MessageSquare size={14} />批注 {previewReady && count || ''}</button>}
    content={<div className="review-version-preview" style={{ position: 'relative', height: 'min(460px, 60dvh)', minHeight: 160, overflow: 'hidden' }}>
      {previewReady ? <iframe ref={frame} title={`${version?.versionLabel} 网页预览`} srcDoc={html} src={html ? undefined : review.site?.siteUrl || undefined}
        sandbox={html ? SRCDOC_PREVIEW_SANDBOX : directPreviewSandbox(review.site?.siteUrl ?? '')} referrerPolicy="no-referrer" onLoad={review.annotations.notifyFrame}
        style={{ width: '100%', height: '100%', border: 0, background: 'var(--bg-elevated)' }} />
        : <div className="review-empty" role="status">{review.error ? <><p>{review.error}</p><button type="button" className="review-tool" onClick={() => { if (version) void review.selectVersion(versionId); else void review.refresh(); }}>重试预览</button></> : <><MapSpinner size={20} /><p>正在预览历史版本…</p></>}</div>}
      <AnnotationBubble annotations={review.annotations} hidden={showComments} />
      {previewReady && <aside className="review-sidebar" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 'min(360px, 100%)', background: 'var(--bg-elevated)', display: showComments ? 'flex' : 'none', flexDirection: 'column' }}>
        <div className="review-sidebar-heading"><span>此版本批注</span><button type="button" aria-label="收起此版本批注" onClick={() => setShowComments(false)}><X size={16} /></button></div>
        <div style={{ flex: 1, minHeight: 0 }}><CommentsSection {...(source.mode === 'share' ? { mode: 'share', token: source.token, siteId: source.siteId, password: source.password } : { mode: 'site', siteId: source.siteId })}
          annotations={review.annotations} review={review} versionOnly onThreadCountsChange={counts => setCount(counts.annotations + counts.discussions)} onPickElement={() => setShowComments(false)} /></div>
      </aside>}
    </div>}
    actions={<div className="review-version-preview-actions">
      {error && <p role="alert">{error}</p>}
      {canRestore && previewReady && !version?.isCurrent && (confirm ? <>
        <p>将 {version?.versionLabel} 的内容作为新版本发布。现有版本保留，旧批注仍留在原版本。</p>
        <button type="button" className="review-tool" disabled={restoring} onClick={() => setConfirm(false)}>取消</button>
        <button type="button" className="review-send-action" disabled={restoring} onClick={() => void restore()}>{restoring ? <MapSpinner size={14} /> : <RotateCcw size={14} />}{restoring ? '正在恢复…' : '确认恢复并发布'}</button>
      </> : <button type="button" className="review-tool" onClick={() => setConfirm(true)}><RotateCcw size={14} />恢复为当前版本</button>)}
    </div>} />;
}
