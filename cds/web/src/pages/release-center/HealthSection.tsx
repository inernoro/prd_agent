/**
 * 分区四「健康监测」——设计稿 design_handoff_release_center §5。
 *
 * 元素照稿子：左卡片 420px 探测配置（检查地址 / 探测间隔 / 超时 / 连续失败阈值）+
 * 底部未监测提示块；右卡片可用率趋势，每个环境一行，24 根柱子（每根一小时）。
 *
 * 数据全部来自既有的 `GET /api/uptime/summary?segments=24`——它本来就返回
 * `buckets`（bucketizeSamples 降采样到指定桶数）、`probeUrl`、`availability24h`，
 * 以及顶层的 `intervalSeconds` / `timeoutMs` / `failureThreshold`。
 * 发布目标在 uptime 里的 id 是 `release@{targetId}`（uptime-monitor 的命名约定）。
 *
 * 未监测的环境**不画柱子**，按稿子写明「可用率、恢复时长算不出来，留空而非 0」。
 */

import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import type { FleetEnv } from '@/lib/releaseFleet';
import { fleetAvailabilityText } from '@/lib/releaseFleet';

interface UptimeBucket {
  from: number;
  to: number;
  up: number;
  down: number;
  status: 'up' | 'down' | 'partial' | 'none';
}

interface UptimeTarget {
  id: string;
  probeUrl?: string;
  availability24h?: number | null;
  sampleCount24h?: number;
  avgLatencyMs24h?: number | null;
  lastSample?: { t: number; up: boolean; ms: number } | null;
  buckets?: UptimeBucket[];
}

interface UptimeSummary {
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  targets: UptimeTarget[];
}

export interface HealthSectionProps {
  envs: FleetEnv[];
  /** 当前选中的环境，用于左栏探测配置那一卡。 */
  selected: FleetEnv | undefined;
}

/** 发布目标在 uptime monitor 里的 id 约定，见 uptime-monitor.ts 的注释。 */
function uptimeIdOf(envId: string): string {
  return `release@${envId}`;
}

function barClass(bucket: UptimeBucket): string {
  if (bucket.status === 'none') return 'bg-[hsl(var(--hairline))]';
  const total = bucket.up + bucket.down;
  const ratio = total > 0 ? (bucket.up / total) * 100 : 0;
  if (ratio < 98) return 'bg-bad';
  if (ratio < 99.5) return 'bg-warn';
  return 'bg-ok';
}

export function HealthSection({ envs, selected }: HealthSectionProps): JSX.Element {
  const [summary, setSummary] = useState<UptimeSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // segments=24：每根柱子一小时，正好铺满稿子要的 24 根。
    apiRequest<UptimeSummary>('/api/uptime/summary?segments=24')
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const byId = new Map((summary?.targets || []).map((target) => [target.id, target]));
  const selectedProbe = selected ? byId.get(uptimeIdOf(selected.id)) : undefined;
  const unmonitored = envs.filter((env) => env.health === 'unmonitored');

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
      <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
        <div className="border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-4">
          <h2 className="text-sm font-bold">探测配置</h2>
        </div>
        <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-2.5 px-[18px] py-4 text-[12.5px]">
          <dt className="text-[11.5px] text-muted-foreground">检查地址</dt>
          <dd className="min-w-0 break-all cds-ident">
            {selected ? (selectedProbe?.probeUrl || '未配置健康检查地址') : '未选择环境'}
          </dd>
          <dt className="text-[11.5px] text-muted-foreground">探测间隔</dt>
          <dd className="cds-ident">{summary ? `${summary.intervalSeconds} 秒` : '读取中'}</dd>
          <dt className="text-[11.5px] text-muted-foreground">超时</dt>
          <dd className="cds-ident">{summary ? `${summary.timeoutMs} 毫秒` : '读取中'}</dd>
          <dt className="text-[11.5px] text-muted-foreground">连续失败阈值</dt>
          <dd className="cds-ident">{summary ? `${summary.failureThreshold} 次` : '读取中'}</dd>
          {/* 这两行稿子没有，但它们是既有页面上真有的信息（探测的即时状态），
              删掉等于交付时悄悄少一块。数据同样来自 uptime summary 的 lastSample。 */}
          <dt className="text-[11.5px] text-muted-foreground">最近检查</dt>
          <dd className="cds-ident">
            {selectedProbe?.lastSample
              ? `${Math.max(0, Math.round((Date.now() - selectedProbe.lastSample.t) / 60_000))} 分钟前`
              : '尚未探测'}
          </dd>
          <dt className="text-[11.5px] text-muted-foreground">响应时间</dt>
          <dd className="cds-ident">
            {typeof selectedProbe?.lastSample?.ms === 'number' ? `${selectedProbe.lastSample.ms} ms` : '无数据'}
          </dd>
        </dl>
        {error ? <p className="px-[18px] pb-4 text-xs text-bad">{error}</p> : null}
        {summary && !summary.enabled ? (
          <p className="mx-[18px] mb-4 rounded-[9px] border border-warn/40 bg-warn-soft px-3 py-2.5 text-[11.5px] text-warn">
            存活监控当前是关闭的，下面的可用率与趋势都不会更新。
          </p>
        ) : null}
        {unmonitored.length > 0 ? (
          <div className="mx-[18px] mb-4 rounded-[9px] border border-warn/40 bg-warn-soft px-3 py-2.5 text-[11.5px] text-warn">
            {unmonitored.length} 个环境未监测（{unmonitored.map((env) => env.name).join('、')}）：
            它们的可用率、恢复时长算不出来，本页留空而不是写 0。
          </div>
        ) : null}
      </section>

      <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-4">
          <h2 className="text-sm font-bold">可用率趋势</h2>
          <span className="cds-ident text-[11px] text-muted-foreground">近 24 小时 · 每根柱子 1 小时</span>
        </div>
        <div className="flex flex-col gap-4 p-[18px]">
          {envs.map((env) => {
            const target = byId.get(uptimeIdOf(env.id));
            const buckets = target?.buckets || [];
            const monitored = env.health !== 'unmonitored' && buckets.length > 0;
            return (
              <div key={env.id} className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="truncate text-[12.5px] font-semibold">{env.name}</span>
                  <span className="cds-ident text-[12.5px]">{fleetAvailabilityText(env)}</span>
                </div>
                {monitored ? (
                  <>
                    <div className="mt-2 flex h-[34px] items-end gap-[3px]">
                      {buckets.map((bucket) => {
                        const total = bucket.up + bucket.down;
                        const ratio = total > 0 ? bucket.up / total : 0;
                        // 没有采样的那一小时给一根很矮的灰柱：它是「没数据」，
                        // 不是「可用率 0」——画成满高的红柱等于报一次假故障。
                        const height = bucket.status === 'none' ? 4 : Math.max(4, Math.round(ratio * 34));
                        return (
                          <span
                            key={bucket.from}
                            title={`${new Date(bucket.from).getHours()} 时 · ${bucket.status === 'none' ? '无采样' : `${bucket.up}/${total} 次通过`}`}
                            className={`flex-1 rounded-t-[2px] ${barClass(bucket)}`}
                            style={{ height }}
                          />
                        );
                      })}
                    </div>
                    <div className="mt-1 text-[10.5px] text-muted-foreground">
                      {target?.sampleCount24h ? `${target.sampleCount24h} 次采样` : '窗口内暂无采样'}
                    </div>
                  </>
                ) : (
                  <div className="mt-2 rounded-[9px] border border-dashed border-[hsl(var(--hairline-strong))] px-3 py-2.5 text-[11.5px] text-muted-foreground">
                    未配置健康检查地址，趋势不可绘制。
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
