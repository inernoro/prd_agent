import { useMemo } from 'react';
import { Eye, EyeOff, MessageCircle } from 'lucide-react';
import { ReviewVersionBar } from './ReviewVersionBar';
import type { HostedReview } from './useHostedReview';

export function ReviewToolbarControls({ review, canUpload, onOpen, expanded, count, showVersions = true, renderVersionPreview = true, showBubbleToggle = false, readerLayout = false }: {
  review: HostedReview; canUpload: boolean; onOpen: () => void; expanded: boolean; count?: number | null; showVersions?: boolean; renderVersionPreview?: boolean; showBubbleToggle?: boolean; readerLayout?: boolean;
}) {
  const { annotations } = review;
  const annotationCount = useMemo(() => showBubbleToggle ? annotations.threads.filter(thread => thread.anchor && !thread.parentId).length : 0, [showBubbleToggle, annotations.threads]);
  const showAll = annotations.hasHiddenPreviews;
  const bubbleAction = showAll ? '显示全部气泡' : '隐藏全部气泡';
  return <div className="review-toolbar-controls">
    {(annotationCount > 0 || (readerLayout && showBubbleToggle)) && <button type="button" className="review-tool review-bubble-toggle" aria-label={bubbleAction}
      title={bubbleAction} disabled={annotationCount === 0} onClick={showAll ? annotations.showAllPreviews : annotations.hideAllPreviews}>
      {showAll ? <EyeOff size={15} /> : <Eye size={15} />}<span className="review-bubble-toggle-label">{readerLayout && annotations.allPreviewsHidden ? '批注已隐藏' : '批注'}</span>
      {(!readerLayout || !annotations.allPreviewsHidden) && <span className="review-count">{annotationCount}</span>}
    </button>}
    <button type="button" className={`review-tool review-annotate-trigger max-sm:min-h-11${expanded ? ' is-selected' : ''}`} onClick={onOpen}
      aria-label="批注与讨论" aria-expanded={expanded} title={expanded ? '收起讨论' : '打开讨论'}>
      <MessageCircle size={15} /><span>{showBubbleToggle || readerLayout ? '讨论' : '批注'}</span>{!readerLayout && !!count && <span className="review-count">{count}</span>}
    </button>
    {showVersions && <ReviewVersionBar review={review} canUpload={canUpload} renderPreview={renderVersionPreview} />}
  </div>;
}
