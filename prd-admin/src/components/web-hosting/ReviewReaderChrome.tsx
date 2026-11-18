import { useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { History, MessageCircle } from 'lucide-react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import '@/styles/hosted-review-workbench.css';

export function useReviewReaderWidth(container: RefObject<HTMLElement>, active = true) {
  const { width: viewport } = useBreakpoint();
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const element = active ? container.current : null;
    if (!element) return;
    const measure = () => setMeasured(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, container]);
  return measured || viewport;
}

export function reviewReaderTint(tints: [string, string] | null): CSSProperties | undefined {
  return tints ? { '--review-header-tint-start': tints[0], '--review-header-tint-end': tints[1] } as CSSProperties : undefined;
}

export function ReviewReaderTabs({ discussion, count, documentId, discussionId, onChange }: {
  discussion: boolean;
  count: number;
  documentId: string;
  discussionId: string;
  onChange: (discussion: boolean) => void;
}) {
  const select = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'End' || (event.key !== 'Home' && !discussion);
    onChange(next);
    event.currentTarget.querySelectorAll('button')[Number(next)]?.focus();
  };
  return <div className="review-reader-tabs" role="tablist" aria-label="审阅视图" onKeyDown={select}>
    <button id={`${documentId}-tab`} type="button" role="tab" aria-controls={documentId} aria-selected={!discussion}
      tabIndex={discussion ? -1 : 0} onClick={() => onChange(false)}>正文</button>
    <button id={`${discussionId}-tab`} type="button" role="tab" aria-controls={discussionId} aria-selected={discussion}
      tabIndex={discussion ? 0 : -1} onClick={() => onChange(true)}>讨论 <span>{count}</span></button>
  </div>;
}

export function ReviewUnavailableNotice() {
  return <div className="review-annotation-unavailable" role="note">
    <MessageCircle size={15} />
    <span><strong>这个页面不能加载批注脚本</strong>，可以在讨论栏写整页评论。</span>
  </div>;
}

export type ReviewHistoryHintValue = { id: string; label: string; count: number };

export function ReviewHistoryHint({ value, onOpen }: { value: ReviewHistoryHintValue; onOpen: (id: string) => void }) {
  const label = `当前版本暂无意见，${value.label} 有 ${value.count} 条`;
  return <button type="button" className="review-history-hint" aria-label={label} title={label} onClick={() => onOpen(value.id)}>
    <History size={14} /><span>当前版本暂无意见，<strong>{value.label} 有 {value.count} 条</strong></span>
  </button>;
}
