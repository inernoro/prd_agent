import { useEffect, useMemo, useState } from 'react';
import { Bell, Database, ExternalLink, Settings, TerminalSquare, Trash2, X } from 'lucide-react';

type NoticeTone = 'info' | 'warning' | 'danger';

export interface SiteNoticePayload {
  id: string;
  title: string;
  body: string;
  tone?: NoticeTone;
  href?: string;
  actionLabel?: string;
  source?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
}

interface SiteNotice extends SiteNoticePayload {
  createdAt: string;
  readAt?: string;
  dismissedAt?: string;
}

const STORAGE_KEY = 'cds:site-notices:v1';
const MAX_NOTICES = 30;

function loadNotices(): SiteNotice[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as SiteNotice[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTICES) : [];
  } catch {
    return [];
  }
}

function storeNotices(notices: SiteNotice[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notices.slice(0, MAX_NOTICES)));
  } catch {
    /* ignore storage failures */
  }
}

function toneClass(tone: NoticeTone = 'info'): string {
  if (tone === 'danger') return 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300';
  if (tone === 'warning') return 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300';
}

function NoticeIcon({ source }: { source?: string }): JSX.Element {
  if (source === 'schema') return <Database className="h-4 w-4" />;
  if (source === 'env') return <TerminalSquare className="h-4 w-4" />;
  return <Settings className="h-4 w-4" />;
}

function noticeProjectLabel(notice: SiteNotice): string {
  return notice.projectName || notice.projectSlug || notice.projectId || '';
}

export function SiteNoticeInbox(): JSX.Element {
  const [notices, setNotices] = useState<SiteNotice[]>(() => loadNotices());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onUpsert = (event: Event): void => {
      const detail = (event as CustomEvent<SiteNoticePayload>).detail;
      if (!detail?.id || !detail.title) return;
      setNotices((current) => {
        const existing = current.find((item) => item.id === detail.id);
        if (existing?.dismissedAt) return current;
        const nextNotice: SiteNotice = {
          ...existing,
          ...detail,
          tone: detail.tone || existing?.tone || 'info',
          createdAt: existing?.createdAt || new Date().toISOString(),
        };
        const next = [nextNotice, ...current.filter((item) => item.id !== detail.id)].slice(0, MAX_NOTICES);
        storeNotices(next);
        return next;
      });
    };
    window.addEventListener('cds:notice:upsert', onUpsert);
    return () => window.removeEventListener('cds:notice:upsert', onUpsert);
  }, []);

  const activeNotices = useMemo(() => notices.filter((item) => !item.dismissedAt), [notices]);
  const unreadCount = activeNotices.filter((item) => !item.readAt).length;

  const markAllRead = (): void => {
    const now = new Date().toISOString();
    const next = notices.map((item) => (item.dismissedAt || item.readAt ? item : { ...item, readAt: now }));
    setNotices(next);
    storeNotices(next);
  };

  const dismissNotice = (id: string): void => {
    const now = new Date().toISOString();
    const next = notices.map((item) => (item.id === id ? { ...item, readAt: item.readAt || now, dismissedAt: now } : item));
    setNotices(next);
    storeNotices(next);
  };

  return (
    <div className="relative">
      <button
        type="button"
        className={`cds-site-notice-trigger inline-flex h-9 w-9 items-center justify-center rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground transition-colors hover:text-foreground ${unreadCount > 0 ? 'cds-site-notice-trigger--active' : ''}`}
        aria-label={`站内信${unreadCount ? `，${unreadCount} 条未读` : ''}`}
        title={`站内信${unreadCount ? ` · ${unreadCount} 条未读` : ''}`}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) markAllRead();
        }}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[10px] leading-4 text-primary-foreground">
            {unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-[220] mt-2 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-2.5">
            <div>
              <div className="text-sm font-semibold">站内信</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">持久化提醒，不再占用页面横幅</div>
            </div>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted/30 hover:text-foreground" onClick={() => setOpen(false)} aria-label="关闭站内信">
              <X className="h-4 w-4" />
            </button>
          </div>

          {activeNotices.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无提醒</div>
          ) : (
            <div className="max-h-[420px] overflow-auto">
              {activeNotices.map((notice) => (
                <div key={notice.id} className="border-b border-[hsl(var(--hairline))] px-3 py-3 last:border-b-0">
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${toneClass(notice.tone)}`}>
                      <NoticeIcon source={notice.source} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold leading-5">{notice.title}</div>
                      {noticeProjectLabel(notice) ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                          <span className="inline-flex max-w-full items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5">
                            <span className="shrink-0">项目</span>
                            <span className="truncate font-medium text-foreground">{noticeProjectLabel(notice)}</span>
                          </span>
                          {notice.projectSlug && notice.projectSlug !== noticeProjectLabel(notice) ? (
                            <span className="truncate font-mono text-[10px]">{notice.projectSlug}</span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="mt-1 text-xs leading-5 text-muted-foreground">{notice.body}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {notice.href ? (
                          <a
                            href={notice.href}
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/15"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {notice.actionLabel || '打开'}
                          </a>
                        ) : null}
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                          onClick={() => dismissNotice(notice.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                          不再提醒
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
