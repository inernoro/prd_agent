import { MessageSquare } from 'lucide-react';
import { ReviewVersionBar } from './ReviewVersionBar';
import type { HostedReview } from './useHostedReview';

export function ReviewToolbarControls({ review, canUpload, onOpen, expanded, count, showVersions = true }: {
  review: HostedReview; canUpload: boolean; onOpen: () => void; expanded: boolean; count?: number | null; showVersions?: boolean;
}) {
  return <div className="review-toolbar-controls">
    <button type="button" className={`review-tool review-annotate-trigger max-sm:min-h-11${expanded ? ' is-selected' : ''}`} onClick={onOpen}
      aria-label="批注与讨论" aria-expanded={expanded} title="打开批注与讨论，选择页面位置留下意见">
      <MessageSquare size={15} /><span>批注</span>{!!count && <span className="review-count">{count}</span>}
    </button>
    {showVersions && <ReviewVersionBar review={review} canUpload={canUpload} />}
  </div>;
}
