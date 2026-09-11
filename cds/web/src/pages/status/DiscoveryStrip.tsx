/*
 * 监控自发现的「插口」：插上一个自检端点，它自己说该怎么监控它。
 *
 * 心智是 USB：这里只收一个地址，剩下的（判什么、多久看一次、坏了算多严重、
 * 要不要公开）全由端点自报。所以这一条上**没有任何判据输入框**——
 * 有的话就等于把声明又搬回了 CDS 这一侧，回到了那份 yml 的老路。
 *
 * 被拒的声明必须摆出来：静默跳过等于那条监控凭空消失，没人会发现。
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Cable, Plus, X } from 'lucide-react';

import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';

interface EndpointOutcome {
  url: string;
  reachable: boolean;
  err?: string;
  discovered: number;
  rejected: Array<{ componentId: string; reason: string }>;
  added: number;
  updated: number;
  removed: number;
  heldBecauseUnreachable: boolean;
}

interface EndpointsPayload {
  endpoints: string[];
  lastRun: { at: string; endpoints: EndpointOutcome[] } | null;
}

export function DiscoveryStrip({ projectId, onChanged }: {
  projectId: string;
  onChanged: () => void;
}): JSX.Element {
  const [data, setData] = useState<EndpointsPayload | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await apiRequest<EndpointsPayload>(`/api/projects/${encodeURIComponent(projectId)}/monitor-endpoints`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const plug = useCallback(async (): Promise<void> => {
    const url = draft.trim();
    if (!url || busy) return;
    setBusy(true);
    try {
      setData(await apiRequest<EndpointsPayload>(
        `/api/projects/${encodeURIComponent(projectId)}/monitor-endpoints`,
        { method: 'POST', body: { url } },
      ));
      setDraft('');
      setAdding(false);
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, projectId, onChanged]);

  const unplug = useCallback(async (url: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      setData(await apiRequest<EndpointsPayload>(
        `/api/projects/${encodeURIComponent(projectId)}/monitor-endpoints?url=${encodeURIComponent(url)}`,
        { method: 'DELETE' },
      ));
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, projectId, onChanged]);

  const outcomes = data?.lastRun?.endpoints || [];
  const outcomeOf = (url: string): EndpointOutcome | undefined => outcomes.find((o) => o.url === url);
  const rejected = outcomes.flatMap((o) => o.rejected.map((r) => ({ ...r, url: o.url })));

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Cable className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">自检端点</span>
        {(data?.endpoints.length || 0) === 0 ? (
          <span className="text-[0.6875rem] text-muted-foreground">
            插上一个实现了协议的自检端点，监控项由它自己申报 —— 这里不填判据，判据归服务自己说
          </span>
        ) : (
          <span className="text-[0.6875rem] text-muted-foreground">
            {data?.endpoints.length} 个已插 · 自报 {outcomes.reduce((n, o) => n + o.discovered, 0)} 条监控
          </span>
        )}
        <div className="flex-grow" />
        {error ? <span className="max-w-md truncate text-[0.6875rem] text-destructive">{error}</span> : null}
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--hairline-strong))] px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:border-primary/50"
        >
          <Plus className="h-3 w-3" />
          插上一个端点
        </button>
      </div>

      {adding ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void plug(); }}
            placeholder="https://<你的服务>/gw/v1/healthz/deep"
            className="h-8 min-w-0 flex-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
          />
          <button
            type="button"
            onClick={() => void plug()}
            disabled={busy || !draft.trim()}
            className="rounded-md border border-primary/45 bg-primary-soft px-2.5 py-1 text-[0.6875rem] text-primary-ink transition-colors hover:border-primary/70 disabled:opacity-60"
          >
            {busy ? '连接中' : '插上'}
          </button>
        </div>
      ) : null}

      {(data?.endpoints || []).map((url) => {
        const o = outcomeOf(url);
        return (
          <div key={url} className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 py-1.5">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', o?.reachable ? 'bg-ok' : 'bg-destructive')} />
            <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-foreground">{url}</span>
            {o ? (
              <span className={cn('shrink-0 text-[0.6875rem]', o.reachable ? 'text-muted-foreground' : 'text-destructive')}>
                {o.reachable
                  ? `自报 ${o.discovered} 条${o.rejected.length ? ` · 拒 ${o.rejected.length} 条` : ''}`
                  : `${o.err || '打不通'}${o.heldBecauseUnreachable ? ' · 已登记的监控保持不动' : ''}`}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void unplug(url)}
              disabled={busy}
              title="拔掉这个端点，它名下的监控当场下线"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-60"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {rejected.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-warn/35 bg-warn-soft/50 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 text-warn" />
            <span className="text-[0.6875rem] text-warn">这些声明写得不合法，已跳过（跳过的不会变成一条永远绿的假监控）</span>
          </div>
          {rejected.map((r) => (
            <div key={`${r.url}#${r.componentId}`} className="truncate font-mono text-[0.6875rem] text-muted-foreground">
              {r.componentId}：{r.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
