import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { ciImageNotice, type CiImageNoticeInput } from '@/lib/ci-image-notice';

export function CiImageNotice({ branch, expanded = false, className = '' }: {
  branch: CiImageNoticeInput;
  expanded?: boolean;
  className?: string;
}) {
  const notice = ciImageNotice(branch);
  const Icon = branch.ciImageStatus === 'waiting' ? Loader2 : AlertTriangle;
  return (
    <div role="status" className={className} title={`${notice.title}\n${notice.message}${notice.checkedAt ? `\n最近核对：${new Date(notice.checkedAt).toLocaleString()}` : ''}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0${branch.ciImageStatus === 'waiting' ? ' animate-spin' : ''}`} aria-hidden />
        <span className="shrink-0 font-medium">{notice.title}</span>
        {!expanded ? <span className="min-w-0 flex-1 truncate">{notice.message}</span> : null}
        {notice.actionUrl ? (
          <a href={notice.actionUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 underline" onClick={event => event.stopPropagation()}>
            {notice.actionLabel}<ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </div>
      {expanded ? <p className="mt-1 text-muted-foreground">{notice.message}</p> : null}
    </div>
  );
}
