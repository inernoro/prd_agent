/*
 * SiteNoticeInbox — 右上角「信息中心」（合并了两条主线，2026-07-30）：
 *
 * 1. **服务端账本数据源**（本分支，2026-07-29）：站内提醒来自 GET /api/notices。
 *    此前是 localStorage + window CustomEvent 的纯浏览器实现，服务端从没记过一条，
 *    发布失败 / 生产掉线在没人开着页面时彻底沉默。localStorage 现在连缓存都不做：
 *    账本是服务端权威，前端不做第二份归并（两份归并必然漂移）。
 * 2. **信息中心外壳**（main c26c017）：铃铛聚合授权审批 / 待定导入 / 系统更新 /
 *    提交收件四个子收件箱的计数，面板走 overlay dock + 浮动定位。
 *
 * 兼容层保留：BranchListPage 那四处 window.dispatchEvent('cds:notice:upsert')
 * 一行不用改——本组件把它从「写 localStorage」改成「乐观插入 + POST /api/notices」。
 *
 * 死链自动清理（main 211242d 的意图，落到新数据源上）：通知引用的项目已删除时
 * （GET /api/projects/:id 明确 404），改调服务端 dismiss 而不是删本地缓存——
 * 账本在服务端，本地删了下一次 refresh 又会回来。
 *
 * 处理状态机（2026-08-02）：阻断类通知不能只「看见」，还要能被接手。每条通知带
 * 待处理 / 处理中 / 已解决三档，状态持久化在服务端账本（换台机器仍在，不是
 * localStorage）；筛选条走服务端 `?status=`，计数由服务端给，避免前端第二份口径。
 *
 * 三处如实告知（绝不假装通知过谁、也绝不假装有人负责）：
 *   - 外发未配置时顶部显示「仅记录在 CDS 本地，未外发」；
 *   - 单条通知的外发失败原因原样展示；
 *   - 认领人取不到时明说「当前部署未启用账号身份，未记录责任人」（见 lib/noticeStatus）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCircle2, Database, ExternalLink, Rocket, Settings, ShieldAlert, TerminalSquare, Trash2, Undo2, UserCheck, X } from 'lucide-react';
import { AccessRequestInbox } from '@/components/AccessRequestInbox';
import { CommitInbox } from '@/components/CommitInbox';
import { GlobalUpdateBadge } from '@/components/GlobalUpdateBadge';
import { PendingImportInbox } from '@/components/PendingImportInbox';
import { apiRequest, ApiError } from '@/lib/api';
import {
  NOTICE_STATUS_META,
  noticeHandlerText,
  noticeStatusOf,
  type NoticeHandling,
  type NoticeStatus,
} from '@/lib/noticeStatus';
import { floatingPanelPosition, type FloatingPanelPosition } from '@/lib/floatingPanelPosition';
import { useOverlayDock } from '@/lib/useOverlayDock';
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
  handling?: NoticeHandling;
}

interface NoticesResponse {
  notices: SiteNotice[];
  counts?: Record<NoticeStatus, number>;
  unread?: number;
  outbound: { configured: boolean; reason?: string };
}

/** 筛选条。null = 全部；其余透传给服务端 `?status=`，不在前端做第二份过滤。 */
const STATUS_FILTERS: Array<{ value: NoticeStatus | null; label: string }> = [
  { value: null, label: '全部' },
  { value: 'open', label: NOTICE_STATUS_META.open.label },
  { value: 'working', label: NOTICE_STATUS_META.working.label },
  { value: 'resolved', label: NOTICE_STATUS_META.resolved.label },
];

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
  const host = useOverlayDock('#cds-information-center-host');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [notices, setNotices] = useState<SiteNotice[]>([]);
  const [outbound, setOutbound] = useState<{ configured: boolean; reason?: string }>({ configured: true });
  // 计数与未读来自服务端全量作用域，与当前筛选无关（见后端 summary 的注释）。
  const [counts, setCounts] = useState<Record<NoticeStatus, number>>({ open: 0, working: 0, resolved: 0 });
  const [unread, setUnread] = useState(0);
  const [statusFilter, setStatusFilter] = useState<NoticeStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [expandedNoticeIds, setExpandedNoticeIds] = useState<Set<string>>(() => new Set());
  const [panelPosition, setPanelPosition] = useState<FloatingPanelPosition | null>(null);
  const [sourceCounts, setSourceCounts] = useState({
    access: 0,
    commit: 0,
    import: 0,
    update: 0,
  });
  const { lastNoticeEvent } = useCdsEvents();
  const noticeEventTs = lastNoticeEvent?.ts ?? null;

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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // 筛选走服务端而不是前端 filter：账本是服务端权威，前端再筛一遍就成了第二份口径，
      // 「旧记录算不算待处理」这类判定迟早两边漂（本文件顶部那段历史就是这么来的）。
      const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const res = await apiRequest<NoticesResponse>(`/api/notices${query}`);
      setNotices(Array.isArray(res?.notices) ? res.notices : []);
      if (res?.counts) setCounts(res.counts);
      if (typeof res?.unread === 'number') setUnread(res.unread);
      if (res?.outbound) setOutbound(res.outbound);
    } catch {
      // 铃铛取不到账本不该炸掉整个 shell：保持上一次的展示，等下一次事件/打开时再拉。
    }
  }, [statusFilter]);

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
      }).then(() => { void refresh(); }) // 拉一次把计数/未读对回服务端权威值
        .catch(() => { /* 落库失败不回滚乐观插入：下一次 refresh 会以服务端为准 */ })
        .finally(() => { pendingRef.current.delete(detail.id); });
    };
    window.addEventListener('cds:notice:upsert', onUpsert);
    return () => window.removeEventListener('cds:notice:upsert', onUpsert);
  }, [refresh]);

  const activeNotices = useMemo(() => notices.filter((item) => !item.dismissedAt), [notices]);
  // 未读来自服务端全量摘要：列表可能正被筛选，用列表长度去数会让角标随筛选跳变。
  const unreadCount = unread;
  const informationCount = unreadCount
    + sourceCounts.access
    + sourceCounts.commit
    + sourceCounts.import
    + sourceCounts.update;

  const dismissNotice = useCallback((id: string): void => {
    const now = new Date().toISOString();
    setNotices((current) => current.map((item) => (
      item.id === id ? { ...item, readAt: item.readAt || now, dismissedAt: now } : item
    )));
    void apiRequest(`/api/notices/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })
      .then(() => { void refresh(); })
      .catch(() => { void refresh(); });
  }, [refresh]);

  /**
   * 推进处理状态机。状态存在服务端账本，换台机器/换个人打开都看得到——
   * 这正是它不能像旧版那样落 localStorage 的原因。
   *
   * 乐观更新只为「点下去立刻有反应」；服务端返回的记录（含真实变更时间与身份）
   * 立即覆盖回来，随后 refresh 把计数对齐。失败则整条拉回服务端值，不留假状态。
   */
  const setNoticeHandling = useCallback((id: string, status: NoticeStatus): void => {
    setNotices((current) => current.map((item) => (
      item.id === id
        ? {
          ...item,
          readAt: item.readAt || new Date().toISOString(),
          handling: {
            status,
            updatedAt: new Date().toISOString(),
            // 身份由服务端判定：前端不知道自己是不是"有账号的会话"，
            // 猜一个名字出来就是假责任人。先留空，等服务端返回覆盖。
            actor: { channel: 'user', userId: null, userLabel: null, provider: null },
          },
        }
        : item
    )));
    void apiRequest<{ notice?: SiteNotice }>(`/api/notices/${encodeURIComponent(id)}/handling`, {
      method: 'POST',
      body: { status },
    })
      .then((res) => {
        if (res?.notice) {
          setNotices((current) => current.map((item) => (item.id === id ? res.notice as SiteNotice : item)));
        }
        void refresh();
      })
      .catch(() => { void refresh(); });
  }, [refresh]);

  // 陈旧通知清理（2026-07-21 的意图，迁移到服务端账本）：通知携带创建时刻的项目 id，
  // 项目删除/重建后旧通知的深链会落到 /settings/<旧id> 404。面板打开时对引用的项目
  // 逐个探活，确认 404（project_not_found）的通知改调服务端 dismiss——本地删除没用，
  // 账本在服务端，下一次 refresh 又会回来。网络错误/5xx 不动（可能是瞬时故障，不能误删）。
  // 每个项目 id 每次会话只探一次。
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
        return null; // 瞬时错误不判死，下次打开重探
      }
    })).then((results) => {
      if (cancelled) return;
      const goneIds = new Set(results.filter((id): id is string => !!id));
      if (goneIds.size === 0) return;
      for (const notice of notices) {
        if (!notice.dismissedAt && notice.projectId && goneIds.has(notice.projectId)) {
          dismissNotice(notice.id);
        }
      }
    });
    return () => { cancelled = true; };
  }, [open, notices, dismissNotice]);

  const markAllRead = (): void => {
    const now = new Date().toISOString();
    const before = notices;
    const beforeUnread = unread;
    setNotices(notices.map((item) => (item.dismissedAt || item.readAt ? item : { ...item, readAt: now })));
    setUnread(0);
    void apiRequest('/api/notices/read-all', { method: 'POST' })
      .catch(() => { setNotices(before); setUnread(beforeUnread); });
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
              void refresh();
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

      {/* 授权是需要立刻决策的高优先级消息：常驻右下角，同时仍保留在信息中心。 */}
      <AccessRequestInbox placement="floating" onCountChange={handleAccessCount} />

      {open && panelPosition ? createPortal((
        <div
          data-testid="cds-information-center-panel"
          className="fixed z-[220] flex flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl"
          style={panelPosition}
        >
          <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">信息中心</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">系统动态、授权审批与服务端站内信</div>
            </div>
            <button type="button" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/30 hover:text-foreground" onClick={() => setOpen(false)} aria-label="关闭信息中心">
              <X className="h-4 w-4" />
            </button>
          </div>

          {!outbound.configured ? (
            <div className="border-b border-[hsl(var(--hairline))] bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              {outbound.reason || '未配置外发凭据，通知仅记录在 CDS 本地'}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" style={{ overscrollBehavior: 'contain' }}>
            <AccessRequestInbox />
            <PendingImportInbox onCountChange={handleImportCount} />
            <GlobalUpdateBadge onCountChange={handleUpdateCount} />
            <CommitInbox onCountChange={handleCommitCount} />

            {activeNotices.length === 0 && informationCount === 0 && counts.open + counts.working + counts.resolved === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无提醒</div>
            ) : counts.open + counts.working + counts.resolved > 0 ? (
              <section className="overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
                <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
                  <div className="text-xs font-semibold text-foreground">
                    站内提醒（服务端记录，关掉页面也不会漏）
                  </div>
                  <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                    {counts.open > 0
                      ? `还有 ${counts.open} 条没人处理`
                      : '所有提醒都已有人接手'}
                  </div>
                  {/* 筛选条：待处理是这里最该被看见的一档，所以计数常驻显示。 */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {STATUS_FILTERS.map((chip) => {
                      const active = statusFilter === chip.value;
                      const count = chip.value ? counts[chip.value] : counts.open + counts.working + counts.resolved;
                      return (
                        <button
                          key={chip.label}
                          type="button"
                          aria-pressed={active}
                          data-testid={`cds-notice-filter-${chip.value ?? 'all'}`}
                          className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors ${
                            active
                              ? 'border-primary/45 bg-primary/10 text-primary'
                              : 'border-[hsl(var(--hairline))] text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                          }`}
                          onClick={() => setStatusFilter(chip.value)}
                        >
                          <span>{chip.label}</span>
                          <span className="font-mono">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {activeNotices.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    该筛选下没有提醒
                  </div>
                ) : null}
                {activeNotices.map((notice) => {
                  const bodyExpanded = expandedNoticeIds.has(notice.id);
                  const bodyCanExpand = notice.body.length > 180 || notice.body.includes('\n');
                  const status = noticeStatusOf(notice);
                  const handlerText = noticeHandlerText(notice.handling);
                  return (
                  <div key={notice.id} className="border-b border-[hsl(var(--hairline))] px-3 py-3 last:border-b-0">
                    <div className="flex items-start gap-3">
                      <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${levelClass(notice.level)}`}>
                        <NoticeIcon source={notice.source} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1 text-sm font-semibold leading-5">{notice.title}</div>
                          <span
                            data-testid={`cds-notice-status-${notice.id}`}
                            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-4 ${NOTICE_STATUS_META[status].badgeClass}`}
                          >
                            {NOTICE_STATUS_META[status].label}
                          </span>
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
                        <div className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground ${bodyExpanded ? '' : 'line-clamp-3'}`}>
                          {notice.body}
                        </div>
                        {bodyCanExpand ? (
                          <button
                            type="button"
                            className="mt-1 text-[11px] font-medium text-primary hover:underline"
                            aria-expanded={bodyExpanded}
                            onClick={() => setExpandedNoticeIds((current) => {
                              const next = new Set(current);
                              if (next.has(notice.id)) next.delete(notice.id);
                              else next.add(notice.id);
                              return next;
                            })}
                          >
                            {bodyExpanded ? '收起详情' : '展开详情'}
                          </button>
                        ) : null}
                        {outboundHint(notice) ? (
                          <div className="mt-1 text-[11px] leading-4 text-muted-foreground/80">{outboundHint(notice)}</div>
                        ) : null}
                        {handlerText ? (
                          <div className="mt-1 text-[11px] leading-4 text-muted-foreground/80">{handlerText}</div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {status !== 'working' ? (
                            <button
                              type="button"
                              data-testid={`cds-notice-claim-${notice.id}`}
                              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/15"
                              onClick={() => setNoticeHandling(notice.id, 'working')}
                            >
                              <UserCheck className="h-3 w-3" />
                              我来处理
                            </button>
                          ) : null}
                          {status !== 'resolved' ? (
                            <button
                              type="button"
                              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 text-xs font-medium text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                              onClick={() => setNoticeHandling(notice.id, 'resolved')}
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              已解决
                            </button>
                          ) : null}
                          {status !== 'open' ? (
                            <button
                              type="button"
                              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                              onClick={() => setNoticeHandling(notice.id, 'open')}
                            >
                              <Undo2 className="h-3 w-3" />
                              退回待处理
                            </button>
                          ) : null}
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
                  );
                })}
              </section>
            ) : null}
          </div>
        </div>
      ), document.body) : null}
    </>
  ), host);
}
