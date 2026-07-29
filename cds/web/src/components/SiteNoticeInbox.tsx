/*
 * SiteNoticeInbox — 右上角站内信铃铛。
 *
 * 2026-07-29 起数据源换成**服务端账本**（GET /api/notices）。
 * 此前这份是 localStorage + window CustomEvent 的纯浏览器实现，服务端从没记过一条，
 * 于是发布失败 / 生产掉线在没人开着页面时彻底沉默。localStorage 现在连缓存都不做：
 * 账本是服务端权威，前端不做第二份归并（两份归并必然漂移）。
 *
 * 兼容层保留：BranchListPage 那四处 window.dispatchEvent('cds:notice:upsert')
 * 一行不用改——本组件把它从「写 localStorage」改成「乐观插入 + POST /api/notices」。
 *
 * 两处如实告知（绝不假装通知过谁）：
 *   - 外发未配置时顶部显示「仅记录在 CDS 本地，未外发」；
 *   - 单条通知的外发失败原因原样展示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Database, ExternalLink, Rocket, Settings, ShieldAlert, TerminalSquare, Trash2, X } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';

type NoticeLevel = 'info' | 'warning' | 'danger';

/** window 'cds:notice:upsert' 的载荷。tone 是历史字段名，与 level 等价。 */
export interface SiteNoticePayload {
  id: string;
  title: string;
  body: string;
  tone?: NoticeLevel;
  href?: string;
  actionLabel?: string;
  source?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
}

/** 与后端 CdsNoticeRecord 对齐。 */
interface SiteNotice {
  id: string;
  dedupeKey: string;
  level: NoticeLevel;
  title: string;
  body: string;
  source?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  href?: string;
  actionLabel?: string;
  createdAt: string;
  updatedAt: string;
  occurrences: number;
  readAt?: string;
  dismissedAt?: string;
  outbound?: { status: 'sent' | 'skipped' | 'failed'; at: string; reason?: string; reference?: string };
}

interface NoticesResponse {
  notices: SiteNotice[];
  outbound: { configured: boolean; reason?: string };
}

function levelClass(level: NoticeLevel = 'info'): string {
  // 语义色走 token，暗/亮双主题各自成立（禁暗色字面量 fallback）。
  if (level === 'danger') return 'border-[hsl(var(--destructive))]/35 bg-[hsl(var(--destructive))]/10 text-[hsl(var(--destructive))]';
  if (level === 'warning') return 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300';
}

function NoticeIcon({ source }: { source?: string }): JSX.Element {
  if (source === 'schema') return <Database className="h-4 w-4" />;
  if (source === 'env') return <TerminalSquare className="h-4 w-4" />;
  if (source === 'release' || source === 'drift') return <Rocket className="h-4 w-4" />;
  if (source === 'uptime' || source === 'system') return <ShieldAlert className="h-4 w-4" />;
  return <Settings className="h-4 w-4" />;
}

function noticeProjectLabel(notice: SiteNotice): string {
  return notice.projectName || notice.projectSlug || notice.projectId || '';
}

function outboundHint(notice: SiteNotice): string | null {
  if (!notice.outbound) return null;
  if (notice.outbound.status === 'failed') return `外发失败：${notice.outbound.reason || '原因未知'}`;
  if (notice.outbound.status === 'skipped') return notice.outbound.reason || '未外发，仅记录在 CDS 本地';
  return null;
}

export function SiteNoticeInbox(): JSX.Element {
  const [notices, setNotices] = useState<SiteNotice[]>([]);
  const [outbound, setOutbound] = useState<{ configured: boolean; reason?: string }>({ configured: true });
  const [open, setOpen] = useState(false);
  const { lastNoticeEvent } = useCdsEvents();
  const noticeEventTs = lastNoticeEvent?.ts ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await apiRequest<NoticesResponse>('/api/notices');
      setNotices(Array.isArray(res?.notices) ? res.notices : []);
      if (res?.outbound) setOutbound(res.outbound);
    } catch {
      // 铃铛取不到账本不该炸掉整个 shell：保持上一次的展示，等下一次事件/打开时再拉。
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 服务端记了新通知 → 实时增量刷新（不轮询）。
  useEffect(() => {
    if (!noticeEventTs) return;
    void refresh();
  }, [noticeEventTs, refresh]);

  // 兼容层：BranchListPage 等页面仍用 window 事件报「环境变量缺失」这类前端侧发现的问题。
  // 乐观插入让铃铛立刻亮，同时 POST 到服务端账本落库（失败就靠下一次 refresh 纠正）。
  const pendingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const onUpsert = (event: Event): void => {
      const detail = (event as CustomEvent<SiteNoticePayload>).detail;
      if (!detail?.id || !detail.title) return;
      const level: NoticeLevel = detail.tone || 'info';
      const nowIso = new Date().toISOString();
      setNotices((current) => {
        const existing = current.find((item) => item.id === detail.id);
        if (existing?.dismissedAt) return current;
        const next: SiteNotice = {
          ...existing,
          id: detail.id,
          dedupeKey: existing?.dedupeKey || detail.id,
          level,
          title: detail.title,
          body: detail.body,
          source: detail.source,
          projectId: detail.projectId,
          projectName: detail.projectName,
          projectSlug: detail.projectSlug,
          href: detail.href,
          actionLabel: detail.actionLabel,
          createdAt: existing?.createdAt || nowIso,
          updatedAt: nowIso,
          occurrences: existing ? existing.occurrences + 1 : 1,
        };
        return [next, ...current.filter((item) => item.id !== detail.id)];
      });
      if (pendingRef.current.has(detail.id)) return;
      pendingRef.current.add(detail.id);
      void apiRequest('/api/notices', {
        method: 'POST',
        body: {
          id: detail.id,
          title: detail.title,
          body: detail.body,
          level,
          source: detail.source || 'ops',
          projectId: detail.projectId,
          projectName: detail.projectName,
          projectSlug: detail.projectSlug,
          href: detail.href,
          actionLabel: detail.actionLabel,
        },
      }).catch(() => { /* 落库失败不回滚乐观插入：下一次 refresh 会以服务端为准 */ })
        .finally(() => { pendingRef.current.delete(detail.id); });
    };
    window.addEventListener('cds:notice:upsert', onUpsert);
    return () => window.removeEventListener('cds:notice:upsert', onUpsert);
  }, []);

  const activeNotices = useMemo(() => notices.filter((item) => !item.dismissedAt), [notices]);
  const unreadCount = activeNotices.filter((item) => !item.readAt).length;

  const markAllRead = (): void => {
    const now = new Date().toISOString();
    const before = notices;
    setNotices(notices.map((item) => (item.dismissedAt || item.readAt ? item : { ...item, readAt: now })));
    void apiRequest('/api/notices/read-all', { method: 'POST' })
      .catch(() => { setNotices(before); });
  };

  const dismissNotice = (id: string): void => {
    const now = new Date().toISOString();
    const before = notices;
    setNotices(notices.map((item) => (item.id === id ? { ...item, readAt: item.readAt || now, dismissedAt: now } : item)));
    void apiRequest(`/api/notices/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })
      .catch(() => { setNotices(before); });
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
          if (!open) {
            void refresh();
            markAllRead();
          }
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
              <div className="mt-0.5 text-[11px] text-muted-foreground">由 CDS 服务端记录，关掉页面也不会漏</div>
            </div>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted/30 hover:text-foreground" onClick={() => setOpen(false)} aria-label="关闭站内信">
              <X className="h-4 w-4" />
            </button>
          </div>

          {!outbound.configured ? (
            <div className="border-b border-[hsl(var(--hairline))] bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              {outbound.reason || '未配置外发凭据，通知仅记录在 CDS 本地'}
            </div>
          ) : null}

          {activeNotices.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无提醒</div>
          ) : (
            <div className="max-h-[420px] overflow-auto" style={{ overscrollBehavior: 'contain' }}>
              {activeNotices.map((notice) => (
                <div key={notice.id} className="border-b border-[hsl(var(--hairline))] px-3 py-3 last:border-b-0">
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${levelClass(notice.level)}`}>
                      <NoticeIcon source={notice.source} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 text-sm font-semibold leading-5">{notice.title}</div>
                        {notice.occurrences > 1 ? (
                          <span className="shrink-0 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground">
                            {notice.occurrences} 次
                          </span>
                        ) : null}
                      </div>
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
                      {outboundHint(notice) ? (
                        <div className="mt-1 text-[11px] leading-4 text-muted-foreground/80">{outboundHint(notice)}</div>
                      ) : null}
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
