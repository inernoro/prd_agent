import { useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Bot, History, MessageCircle } from 'lucide-react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { LOCAL_NOHEAD_AVATAR, resolveAvatarUrl } from '@/lib/avatar';
import type { HostedSiteCommentDto } from '@/services/real/webPages';
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

export function ReviewDiscussionIcon({ count }: { count: number }) {
  return <span className="review-discussion-icon" aria-hidden="true">
    <MessageCircle size={17} />
    {count > 0 && <span className="review-discussion-badge">{count}</span>}
  </span>;
}

export function ReviewCommentAvatar({ author, className = 'review-talk-avatar' }: {
  author: Pick<HostedSiteCommentDto, 'isAi' | 'authorAvatarFileName' | 'authorAvatarUrl'>;
  className?: string;
}) {
  if (author.isAi) return <span className={`${className} review-ai-avatar`} aria-hidden="true"><Bot size={14} /></span>;
  const src = author.authorAvatarUrl || author.authorAvatarFileName
    ? resolveAvatarUrl({ avatarUrl: author.authorAvatarUrl, avatarFileName: author.authorAvatarFileName })
    : LOCAL_NOHEAD_AVATAR;
  return <UserAvatar className={className} src={src} loading="lazy" />;
}

export function ReviewReaderTabs({ discussion, count, documentId, discussionId, onChange, trailing }: {
  discussion: boolean;
  count: number;
  documentId: string;
  discussionId: string;
  onChange: (discussion: boolean) => void;
  trailing?: ReactNode;
}) {
  const select = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'End' || (event.key !== 'Home' && !discussion);
    onChange(next);
    event.currentTarget.querySelectorAll('button')[Number(next)]?.focus();
  };
  return <div className="review-reader-mobile-nav"><div className="review-reader-tabs" role="tablist" aria-label="审阅视图" onKeyDown={select}>
    <button id={`${documentId}-tab`} type="button" role="tab" aria-controls={documentId} aria-selected={!discussion}
      tabIndex={discussion ? -1 : 0} onClick={() => onChange(false)}>正文</button>
    <button id={`${discussionId}-tab`} type="button" role="tab" aria-controls={discussionId} aria-selected={discussion}
      aria-describedby={count > 0 ? `${discussionId}-count` : undefined}
      tabIndex={discussion ? 0 : -1} onClick={() => onChange(true)}><ReviewDiscussionIcon count={count} />讨论</button>
  </div>{trailing}{count > 0 && <span id={`${discussionId}-count`} className="sr-only">{count} 条评论</span>}</div>;
}

export function ReviewUnavailableNotice() {
  return <div className="review-annotation-unavailable" role="note">
    <MessageCircle size={15} />
    <span><strong>这个页面不能加载批注脚本</strong>，可以在讨论栏写整页评论。</span>
  </div>;
}

export type ReviewHistoryHintValue = { id: string; label: string; count: number };

export function ReviewHistoryHint({ value, onOpen, menu = false }: { value: ReviewHistoryHintValue; onOpen: (id: string) => void; menu?: boolean }) {
  const label = `当前版本暂无意见，${value.label} 有 ${value.count} 条`;
  return <button type="button" className={menu ? 'share-topbar-btn' : 'review-history-hint'} role={menu ? 'menuitem' : undefined}
    aria-label={label} title={label} onClick={() => onOpen(value.id)}>
    <History size={14} /><span>{menu ? `查看 ${value.label} 的 ${value.count} 条意见` : <>当前版本暂无意见，<strong>{value.label} 有 {value.count} 条</strong></>}</span>
  </button>;
}
