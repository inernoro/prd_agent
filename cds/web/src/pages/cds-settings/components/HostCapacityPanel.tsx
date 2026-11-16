import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import type { CapacityObservation } from '../../../../../src/services/host-capacity-observation';

const amount = (n: number | null): string => n === null ? '未知' : `${(n / 1024 ** 3).toFixed(2)} GiB`;
const rate = (n: number | null): string => n === null ? '未知' : `${amount(n)} / 天`;
export function HostCapacityView({ observation }: { observation: CapacityObservation }): JSX.Element {
  const report = observation.report;
  const label = { ok: '本次增长与余量检查正常', warning: '增长与余量预警', critical: '增长与余量严重风险', unknown: '当前容量风险未知' }[observation.status];
  return <section className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4" aria-label="宿主容量来源与增长">
    <h3 className="font-semibold">宿主容量来源与增长</h3>
    <p className={observation.status === 'ok' ? 'text-sm' : 'text-sm text-warn'} role="status">{label}</p>
    {observation.reason && <p className="break-words text-sm text-muted-foreground">{observation.reason}</p>}
    <p className="text-xs text-muted-foreground">采样时间：{observation.sampledAt ? new Date(observation.sampledAt).toLocaleString() : '未知'}。此检查不代表回收任务已成功。</p>
    {report && <>
      <p className="break-all text-sm">宿主：{report.host}</p>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">{Object.entries(report.sources).map(([name, source]) => <div key={name} className="min-w-0 rounded border border-border p-3 text-sm">
        <p className="break-all font-medium">{name}</p><p className="break-all text-xs text-muted-foreground">{source.path}</p>
        <p>实际分配：{amount(source.bytes)}</p><p>期间变化：{amount(source.deltaBytes)}</p><p>日增长率：{rate(source.bytesPerDay)}</p>
      </div>)}</div>
      {Object.entries(report.filesystems).map(([device, disk]) => <div key={device} className="space-y-1 rounded border border-border p-3 text-sm">
        <p className="break-all font-medium">文件系统 {device}：占用 {disk.usedPercent.toFixed(1)}%</p>
        <p>可用空间：{amount(disk.availableBytes)}；安全余量：{amount(report.policy.reserveBytes)}</p>
        <p>预计触及安全余量：{disk.daysToReserve === null ? (disk.bytesPerDay === null ? '未知' : '当前未观察到正增长') : `${disk.daysToReserve.toFixed(1)} 天`}</p>
        <p>日增长率：{rate(disk.bytesPerDay)}；提前预警窗口：{report.policy.horizonDays} 天</p>
      </div>)}
      <p className="text-xs text-muted-foreground">来源按实际分配字节计量；跨目录硬链接、Docker 共享层可能重叠，不能相加作为整盘占用或回收收益。</p>
    </>}
  </section>;
}
export function HostCapacityPanel(): JSX.Element {
  const [observation, setObservation] = useState<CapacityObservation>({ status: 'unknown', sampledAt: null, reason: '正在读取容量观测' });
  const [key, setKey] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      try {
        const next = await apiRequest<CapacityObservation>('/api/host-capacity/observation', { signal: controller.signal });
        if (!controller.signal.aborted) setObservation(next);
      } catch {
        if (!controller.signal.aborted) setObservation({ status: 'unknown', sampledAt: null, reason: '容量观测读取失败，当前风险未知，请刷新重试' });
      } finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void load(), 60_000); } }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);
  return <div className="space-y-2"><HostCapacityView observation={observation} /><Button variant="outline" size="sm" disabled={loading} aria-busy={loading} onClick={() => setKey(k => k + 1)}>{loading ? <><span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />读取容量观测</> : '刷新容量观测'}</Button></div>;
}
