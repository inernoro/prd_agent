/*
 * 功能监控的证据区：本次判定 + 历史产物画廊。
 *
 * 为什么详情页主体是产物而不是一条 up/down 线：功能监控问的是「返回的东西对不对」，
 * 判据红了以后要回答的第一个问题是「这次到底生成出了什么」。没有产物可看，
 * 就说不清是模型抽风还是判据写错，最后只能把监控静音。
 */
import { useEffect, useState } from 'react';

import { apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AssertionResult {
  path: string;
  op: string;
  expected?: string;
  actual?: string;
  ok: boolean;
  err?: string;
}

interface Observation {
  at: string;
  ok: boolean;
  elapsedMs: number;
  code?: number;
  results: AssertionResult[];
  artifactUrl?: string;
  requestBody?: string;
  err?: string;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 一张产物缩略图；没有产物或加载不出来时退回一个占位方块，不留破图。 */
function ArtifactThumb({ observation, size }: { observation: Observation; size: number }): JSX.Element {
  const [broken, setBroken] = useState(false);
  const failed = !observation.ok;
  const style = { width: size, height: size };
  if (!observation.artifactUrl || broken) {
    return (
      <div
        style={style}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md border text-[0.625rem] text-muted-foreground',
          failed ? 'border-destructive/50' : 'border-dashed border-[hsl(var(--hairline))]',
        )}
      >
        无产物
      </div>
    );
  }
  return (
    <img
      src={observation.artifactUrl}
      alt=""
      loading="lazy"
      style={style}
      onError={() => setBroken(true)}
      className={cn(
        'shrink-0 rounded-md border object-cover',
        failed ? 'border-2 border-destructive' : 'border-[hsl(var(--hairline))]',
      )}
    />
  );
}

function AssertionRow({ result }: { result: AssertionResult }): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md border px-2.5 py-1.5',
        result.ok
          ? 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]'
          : 'border-destructive/40 bg-destructive/10',
      )}
    >
      <span className={cn('shrink-0 text-xs', result.ok ? 'text-[hsl(var(--ok))]' : 'text-destructive')}>
        {result.ok ? '通过' : '未过'}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{result.path}</span>
      <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
        {result.op}{result.expected === undefined ? '' : ` ${result.expected}`}
      </span>
      <span
        className={cn(
          'shrink-0 font-mono text-xs',
          result.ok ? 'text-[hsl(var(--ok))]' : 'font-medium text-destructive',
        )}
      >
        {/* 实际值必须显示：没有它，排障还得自己再打一次接口 */}
        {result.actual ?? '缺失'}
      </span>
    </div>
  );
}

export function FunctionalEvidence({ monitorId }: { monitorId: string }): JSX.Element | null {
  const [observations, setObservations] = useState<Observation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);

  useEffect(() => {
    let alive = true;
    setObservations(null);
    setError(null);
    setPicked(0);
    apiRequest<{ observations: Observation[] }>(`/api/uptime/monitors/${encodeURIComponent(monitorId)}/observations`)
      .then((r) => { if (alive) setObservations(r.observations || []); })
      .catch((e: unknown) => { if (alive) setError((e as Error).message || '读取观测证据失败'); });
    return () => { alive = false; };
  }, [monitorId]);

  if (error) {
    return <p className="text-xs text-destructive">观测证据读取失败：{error}</p>;
  }
  if (!observations) {
    return <p className="text-xs text-muted-foreground">正在读取观测证据…</p>;
  }
  if (observations.length === 0) {
    // 说清是「还没跑过」而不是「没有这个能力」——两者的下一步完全不同。
    return <p className="text-xs text-muted-foreground">这条监控还没有观测记录，下一轮探测后出现。</p>;
  }

  const current = observations[Math.min(picked, observations.length - 1)];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">
          {picked === 0 ? '最近一次判定' : `${timeOf(current.at)} 那次判定`}
        </h3>
        <span className={cn('text-xs', current.ok ? 'text-[hsl(var(--ok))]' : 'text-destructive')}>
          {current.ok ? '通过' : '不通过'}
        </span>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          {current.elapsedMs} ms{current.code === undefined ? '' : ` · HTTP ${current.code}`}
        </span>
      </div>

      <div className="flex gap-3">
        <ArtifactThumb observation={current} size={168} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {current.results.length === 0 ? (
            <p className="text-xs text-destructive">{current.err || '这次没有判据结果'}</p>
          ) : (
            current.results.map((r) => <AssertionRow key={`${r.path}-${r.op}`} result={r} />)
          )}
          {current.requestBody ? (
            <div className="mt-1 flex flex-col gap-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 py-2">
              <span className="text-[0.6875rem] text-muted-foreground">本次发出去的请求</span>
              <code className="break-all font-mono text-[0.6875rem] text-foreground/80">{current.requestBody}</code>
            </div>
          ) : null}
          {current.err && current.results.length > 0 ? (
            <p className="font-mono text-[0.6875rem] text-destructive">{current.err}</p>
          ) : null}
        </div>
      </div>

      {observations.length > 1 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">历史产物 · 点开看那一次的判定</span>
          <div className="flex flex-wrap gap-2">
            {observations.map((o, i) => (
              <button
                key={o.at}
                type="button"
                onClick={() => setPicked(i)}
                aria-current={i === picked ? 'true' : undefined}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md p-1 transition-colors',
                  i === picked ? 'bg-primary/10 ring-1 ring-primary/50' : 'hover:bg-[hsl(var(--surface-sunken))]',
                )}
              >
                <ArtifactThumb observation={o} size={64} />
                <span className={cn('font-mono text-[0.625rem]', o.ok ? 'text-muted-foreground' : 'text-destructive')}>
                  {timeOf(o.at)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
