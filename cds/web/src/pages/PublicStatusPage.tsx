/*
 * 公开状态页 `/s/:token`。
 *
 * 给没有账号的人看：不带控制台外壳、不需要登录、不出现任何内部信息。
 * 页面上只有四样东西——业务名、红黄绿、近 7 天条带、更新时间，
 * 全部由后端 public-status-board 白名单构造好，这里一个字段都不加工。
 *
 * 它是「对内那一屏」的同一批观测记录的另一个出口，不另跑一套探测：
 * 两边跑两套，迟早会说出不一样的话。
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Activity, CheckCircle2, HelpCircle, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';

type PublicStatus = 'ok' | 'degraded' | 'down' | 'unknown';

interface PublicBoardPayload {
  title: string;
  headline: string;
  status: PublicStatus;
  items: Array<{ name: string; status: PublicStatus; days: Array<{ day: string; status: PublicStatus }> }>;
  updatedAt: number;
  refreshHintSeconds: number;
}

const STATUS_TEXT: Record<PublicStatus, string> = {
  ok: '正常',
  degraded: '部分异常',
  down: '异常',
  unknown: '暂无数据',
};

const DOT: Record<PublicStatus, string> = {
  ok: 'bg-ok',
  degraded: 'bg-warn',
  down: 'bg-destructive',
  unknown: 'bg-[hsl(var(--hairline-strong))]',
};

const BANNER: Record<PublicStatus, string> = {
  ok: 'border-ok/40 bg-ok-soft text-ok',
  degraded: 'border-warn/40 bg-warn-soft text-warn',
  down: 'border-destructive/40 bg-destructive/10 text-destructive',
  unknown: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
};

const BANNER_ICON: Record<PublicStatus, typeof CheckCircle2> = {
  ok: CheckCircle2,
  degraded: Activity,
  down: AlertTriangle,
  unknown: HelpCircle,
};

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PublicStatusPage(): JSX.Element {
  // 刻意不用 useParams：这一页不挂在控制台路由树上时也要能独立跑。
  const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
  const [board, setBoard] = useState<PublicBoardPayload | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'gone'>('loading');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/public/status/${encodeURIComponent(token)}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) { setPhase('gone'); return; }
      if (!res.ok) throw new Error(String(res.status));
      setBoard(await res.json() as PublicBoardPayload);
      setPhase('ready');
    } catch {
      // 一次刷新失败保留上一份数据：对外页宁可显示旧结论 + 旧时间，
      // 也不要把一屏已经看到的内容换成错误页。
      if (!board) setPhase('loading');
    } finally {
      setRefreshing(false);
    }
  }, [token, board]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  useEffect(() => {
    if (phase !== 'ready' || !board) return undefined;
    const ms = Math.max(30, board.refreshHintSeconds) * 1000;
    const timer = setInterval(() => { void load(); }, ms);
    return () => clearInterval(timer);
  }, [phase, board, load]);

  if (phase === 'gone') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="max-w-md text-center">
          <div className="text-base font-medium text-foreground">这个状态页不存在或已关闭</div>
          <div className="mt-2 text-sm leading-6 text-muted-foreground">
            链接可能已被撤销。如果你是从别处拿到它的，去问发你链接的人要一个新的。
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'loading' || !board) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="w-full max-w-2xl">
          <div className="cds-loading-skeleton-line h-6 w-40 rounded" />
          <div className="mt-4 cds-loading-skeleton-line h-14 w-full rounded-lg" />
          <div className="mt-4 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="cds-loading-skeleton-line h-12 w-full rounded-lg" style={{ animationDelay: `${i * 90}ms` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const BannerIcon = BANNER_ICON[board.status];

  return (
    <div className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center gap-2.5">
          <span className="h-5 w-5 rounded bg-primary" aria-hidden />
          <h1 className="text-base font-semibold text-foreground">{board.title} 服务状态</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--hairline))] px-2 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
            刷新
          </button>
        </div>

        <div className={cn('mt-5 flex items-center gap-3 rounded-lg border px-4 py-3.5', BANNER[board.status])}>
          <BannerIcon className="h-4 w-4 shrink-0" />
          <span className="text-sm font-semibold">{board.headline}</span>
        </div>

        <div className="mt-6 flex flex-col gap-5">
          {board.items.map((item) => (
            <div key={item.name} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[item.status])} />
                <span className="truncate text-[0.8125rem] font-medium text-foreground">{item.name}</span>
                <div className="flex-1" />
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{STATUS_TEXT[item.status]}</span>
              </div>
              <div className="flex h-5 gap-1" role="img" aria-label={`${item.name} 近 ${item.days.length} 天`}>
                {item.days.map((d) => (
                  <span
                    key={d.day}
                    title={`${d.day} ${STATUS_TEXT[d.status]}`}
                    className={cn('min-w-0 flex-1 rounded-[2px]', DOT[d.status])}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] pt-4 text-[0.6875rem] text-muted-foreground">
          <span>近 {board.items[0]?.days.length ?? 7} 天 · 每格一天</span>
          <span>更新于 {formatClock(board.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}
