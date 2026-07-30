import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Database, ExternalLink, Settings, TerminalSquare, Trash2, X } from 'lucide-react';
import { AccessRequestInbox } from '@/components/AccessRequestInbox';
import { CommitInbox } from '@/components/CommitInbox';
import { GlobalUpdateBadge } from '@/components/GlobalUpdateBadge';
import { PendingImportInbox } from '@/components/PendingImportInbox';
import { apiRequest, ApiError } from '@/lib/api';
import { floatingPanelPosition, type FloatingPanelPosition } from '@/lib/floatingPanelPosition';
import { useOverlayDock } from '@/lib/useOverlayDock';

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
  const host = useOverlayDock('#cds-information-center-host');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [notices, setNotices] = useState<SiteNotice[]>(() => loadNotices());
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<FloatingPanelPosition | null>(null);
  const [sourceCounts, setSourceCounts] = useState({
    access: 0,
    commit: 0,
    import: 0,
    update: 0,
  });

  const updateSourceCount = useCallback((source: keyof typeof sourceCounts, count: number): void => {
    setSourceCounts((current) => current[source] === count ? current : { ...current, [source]: count });
  }, []);
  const handleAccessCount = useCallback((count: number) => updateSourceCount('access', count), [updateSourceCount]);
  const handleCommitCount = useCallback((count: number) => updateSourceCount('commit', count), [updateSourceCount]);
  const handleImportCount = useCallback((count: number) => updateSourceCount('import', count), [updateSourceCount]);
  const handleUpdateCount = useCallback((count: number) => updateSourceCount('update', count), [updateSourceCount]);

  const updatePanelPosition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPanelPosition(floatingPanelPosition(
      { left: rect.left, bottom: rect.bottom },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePanelPosition();
    window.addEventListener('resize', updatePanelPosition);
    window.addEventListener('scroll', updatePanelPosition, true);
    return () => {
      window.removeEventListener('resize', updatePanelPosition);
      window.removeEventListener('scroll', updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

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
  const informationCount = unreadCount
    + sourceCounts.access
    + sourceCounts.commit
    + sourceCounts.import
    + sourceCounts.update;

  // 陈旧通知清理(2026-07-21):通知持久化在 localStorage 且携带创建时刻的项目 id,
  // 项目删除/重建后旧通知仍留存,用户点「查看推荐方式」落到 /settings/<旧id> 即 404。
  // 面板打开时对通知引用的项目逐个探活,确认 404(project_not_found)的通知自动移除;
  // 网络错误/5xx 不动(可能是瞬时故障,不能误删)。每个 id 每次会话只探一次。
  const checkedProjectIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    const idsToCheck = [...new Set(
      notices
        .filter((item) => !item.dismissedAt && item.projectId)
        .map((item) => item.projectId as string),
    )].filter((id) => !checkedProjectIdsRef.current.has(id));
    if (idsToCheck.length === 0) return;
    let cancelled = false;
    void Promise.all(idsToCheck.map(async (id) => {
      try {
        await apiRequest(`/api/projects/${encodeURIComponent(id)}`);
        checkedProjectIdsRef.current.add(id);
        return null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          checkedProjectIdsRef.current.add(id);
          return id;
        }
        return null; // 瞬时错误不判死,下次打开重探
      }
    })).then((results) => {
      if (cancelled) return;
      const goneIds = new Set(results.filter((id): id is string => !!id));
      if (goneIds.size === 0) return;
      setNotices((current) => {
        const next = current.filter((item) => !(item.projectId && goneIds.has(item.projectId)));
        if (next.length === current.length) return current;
        storeNotices(next);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [open, notices]);

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

  if (!host) return <></>;

  return createPortal((
    <>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          className={`cds-site-notice-trigger inline-flex h-9 w-9 items-center justify-center rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground transition-colors hover:text-foreground ${informationCount > 0 ? 'cds-site-notice-trigger--active' : ''}`}
          aria-label={`信息中心${informationCount ? `，${informationCount} 条待处理` : ''}`}
          aria-expanded={open}
          title={`信息中心${informationCount ? ` · ${informationCount} 条待处理` : ''}`}
          onClick={() => {
            const nextOpen = !open;
            if (nextOpen) {
              updatePanelPosition();
              markAllRead();
            }
            setOpen(nextOpen);
          }}
        >
          <Bell className="h-5 w-5" />
          {informationCount > 0 ? (
            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[10px] leading-4 text-primary-foreground">
              {informationCount > 99 ? '99+' : informationCount}
            </span>
          ) : null}
        </button>
      </div>

      {open && panelPosition ? createPortal((
        <div
          data-testid="cds-information-center-panel"
          className="fixed z-[220] flex flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl"
          style={panelPosition}
        >
          <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">信息中心</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">系统动态、授权审批与持久化提醒</div>
            </div>
            <button type="button" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/30 hover:text-foreground" onClick={() => setOpen(false)} aria-label="关闭信息中心">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <AccessRequestInbox onCountChange={handleAccessCount} />
            <PendingImportInbox onCountChange={handleImportCount} />
            <GlobalUpdateBadge onCountChange={handleUpdateCount} />
            <CommitInbox onCountChange={handleCommitCount} />

          {activeNotices.length === 0 && informationCount === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无提醒</div>
          ) : activeNotices.length > 0 ? (
            <section className="overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
              <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs font-semibold text-foreground">
                站内提醒
              </div>
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
            </section>
          ) : null}
          </div>
        </div>
      ), document.body) : null}
    </>
  ), host);
}
