import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, GitCommit, Inbox, Tag, X } from 'lucide-react';

interface BranchSummary {
  id: string;
  projectId: string;
  branch: string;
  status?: string;
  githubRepoFullName?: string;
  githubCommitSha?: string;
  commitSha?: string;
  subject?: string;
}

interface BranchCreatedPayload {
  branch?: BranchSummary;
  source?: string;
  ts?: string;
}

interface BranchUpdatedPayload {
  branchId?: string;
  projectId?: string;
  patch?: Partial<BranchSummary>;
  branch?: BranchSummary;
  ts?: string;
}

interface CommitNotice {
  id: string;
  branchId: string;
  projectId: string;
  branchName: string;
  repoFullName?: string;
  sha?: string;
  subject?: string;
  eventTs: string;
  receivedAt: string;
  latencyMs: number;
  source: 'created' | 'updated';
}

const MAX_NOTICES = 20;
const STORAGE_KEY = 'cds:commit-inbox:notices';

function shortSha(value?: string): string {
  return value ? value.slice(0, 7) : '-';
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso.slice(11, 19);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function formatExactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const now = new Date();
  if (isSameLocalDay(date, now)) return time;
  const day = date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  return `${day} ${time}`;
}

function eventActionLabel(source: CommitNotice['source']): string {
  return source === 'created' ? '新建分支' : '提交更新';
}

function branchDetailHref(notice: CommitNotice): string {
  return `/branches/${encodeURIComponent(notice.projectId)}?branch=${encodeURIComponent(notice.branchId)}`;
}

function noticeFromBranch(branch: BranchSummary, ts: string | undefined, source: CommitNotice['source']): CommitNotice | null {
  const sha = branch.githubCommitSha || branch.commitSha;
  if (!branch.id || !branch.projectId || !sha) return null;
  const eventTs = ts || new Date().toISOString();
  const receivedAt = new Date().toISOString();
  return {
    id: `${branch.id}:${sha}:${source}`,
    branchId: branch.id,
    projectId: branch.projectId,
    branchName: branch.branch || branch.id,
    repoFullName: branch.githubRepoFullName,
    sha,
    subject: branch.subject,
    eventTs,
    receivedAt,
    latencyMs: Date.now() - Date.parse(eventTs),
    source,
  };
}

function loadStoredNotices(): CommitNotice[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CommitNotice[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTICES) : [];
  } catch {
    return [];
  }
}

function storeNotices(notices: CommitNotice[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(notices.slice(0, MAX_NOTICES)));
  } catch {
    /* ignore */
  }
}

export function CommitInbox(): JSX.Element | null {
  const [notices, setNotices] = useState<CommitNotice[]>(() => loadStoredNotices());
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [updateBadgeVisible, setUpdateBadgeVisible] = useState(false);

  useEffect(() => {
    const onUpdateBadgeVisible = (event: Event): void => {
      const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
      setUpdateBadgeVisible(Boolean(detail?.visible));
    };
    setUpdateBadgeVisible(document.documentElement.dataset.cdsGlobalUpdateBadgeVisible === 'true');
    window.addEventListener('cds:global-update-badge-visible', onUpdateBadgeVisible);
    return () => {
      window.removeEventListener('cds:global-update-badge-visible', onUpdateBadgeVisible);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const source = new EventSource('/api/branches/stream');
    source.onopen = () => {
      if (!cancelled) setConnected(true);
    };
    source.onerror = () => {
      if (!cancelled) setConnected(false);
    };

    const pushNotice = (notice: CommitNotice | null): void => {
      if (!notice || cancelled) return;
      setNotices((current) => {
        const next = [notice, ...current.filter((item) => item.id !== notice.id)].slice(0, MAX_NOTICES);
        storeNotices(next);
        return next;
      });
    };

    source.addEventListener('branch.created', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as BranchCreatedPayload;
        if (data.source !== 'github-webhook' || !data.branch) return;
        pushNotice(noticeFromBranch(data.branch, data.ts, 'created'));
      } catch {
        /* ignore malformed SSE */
      }
    });

    source.addEventListener('branch.updated', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as BranchUpdatedPayload;
        if (!data.branch || !data.patch?.githubCommitSha) return;
        pushNotice(noticeFromBranch(data.branch, data.ts, 'updated'));
      } catch {
        /* ignore malformed SSE */
      }
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  const latest = notices[0];
  const unreadCount = notices.length;
  const latestTime = latest ? `${formatRelative(latest.receivedAt)} · ${formatExactTime(latest.receivedAt)}` : '';
  const title = useMemo(() => {
    if (!latest) return connected ? '提交通知信箱 · 等待推送' : '提交通知信箱 · 连接中';
    return `${latest.branchName} · ${eventActionLabel(latest.source)} · ${shortSha(latest.sha)} · ${latestTime}`;
  }, [connected, latest, latestTime]);

  const openNotice = (notice: CommitNotice): void => {
    window.location.assign(branchDetailHref(notice));
  };

  if (!latest && !open) return null;

  return (
    <div
      className={`fixed left-4 z-[190] select-none transition-[bottom,width] duration-200 ${
        open ? 'w-[min(520px,calc(100vw-2rem))]' : 'w-[min(390px,calc(100vw-2rem))]'
      } ${updateBadgeVisible ? 'bottom-16' : 'bottom-4'}`}
    >
      <div className="overflow-hidden rounded-md border border-sky-500/30 bg-[hsl(var(--surface-raised))] shadow-2xl">
        <button
          type="button"
          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))]/80"
          onClick={() => setOpen((value) => !value)}
          title={title}
        >
          <span className="flex items-center gap-3">
            <Inbox className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
            <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-base font-semibold leading-5">
                {latest ? latest.branchName : title}
              </span>
              {latest ? (
                <span className="shrink-0 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {eventActionLabel(latest.source)}
                </span>
              ) : null}
            </span>
            {latest ? (
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                {latest.subject || latest.repoFullName || '收到提交更新'}
                {' · '}
                <span className="font-mono">{shortSha(latest.sha)}</span>
                {' · '}
                延迟 {formatLatency(latest.latencyMs)}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {latest ? (
              <span className="hidden text-right sm:block">
                <span className="block text-xs font-semibold text-foreground">{formatRelative(latest.receivedAt)}</span>
                <span className="block font-mono text-[11px] text-muted-foreground">{formatExactTime(latest.receivedAt)}</span>
              </span>
            ) : null}
            {unreadCount > 0 ? (
              <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 font-mono text-xs text-sky-700 dark:text-sky-300">
                {unreadCount}
              </span>
            ) : null}
            {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronUp className="h-4 w-4 shrink-0" />}
          </span>
        </button>

        {open ? (
          <div className="border-t border-[hsl(var(--hairline))]">
            {notices.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground">正在等待 GitHub push 通知。</div>
            ) : (
              <div className="max-h-80 overflow-auto">
                {notices.map((notice) => (
                  <div
                    key={notice.id}
                    className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-[hsl(var(--hairline))] px-4 py-2.5 transition-colors hover:bg-[hsl(var(--surface-sunken))]/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60 last:border-b-0"
                    role="link"
                    tabIndex={0}
                    onClick={() => openNotice(notice)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openNotice(notice);
                      }
                    }}
                    title={`打开分支 ${notice.branchName}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <GitCommit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">{notice.branchName}</span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          <Tag className="h-3 w-3" />
                          {eventActionLabel(notice.source)}
                        </span>
                      </div>
                      {notice.subject ? (
                        <div className="mt-0.5 truncate pl-5 text-xs leading-5 text-foreground/85">{notice.subject}</div>
                      ) : null}
                      <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-1 pl-5 text-[11px] text-muted-foreground">
                        <span className="font-mono">{shortSha(notice.sha)}</span>
                        <span>延迟 {formatLatency(notice.latencyMs)}</span>
                        {notice.repoFullName ? <span className="min-w-0 truncate">{notice.repoFullName}</span> : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end justify-center gap-1.5">
                      <div className="whitespace-nowrap text-right text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{formatRelative(notice.receivedAt)}</span>
                        <span className="mx-1 text-muted-foreground/60">·</span>
                        <span className="font-mono">{formatExactTime(notice.receivedAt)}</span>
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] px-2 py-1 text-[11px] text-primary hover:bg-primary/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          openNotice(notice);
                        }}
                      >
                        <ExternalLink className="h-3 w-3" />
                        打开分支
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] px-3 py-2">
              <span className="text-[11px] text-muted-foreground">实时流 {connected ? '在线' : '重连中'}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  setNotices([]);
                  storeNotices([]);
                  setOpen(false);
                }}
              >
                <X className="h-3 w-3" />
                清空
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
