import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import type { CapacitySamplingStatus } from '../../../../../src/services/host-capacity-sampling';
import type { CapacityObservation } from '../../../../../src/services/host-capacity-observation';

const alertLabels: Record<string, string> = {
  'bytes-critical': '磁盘字节占用达到严重水位', 'bytes-warning': '磁盘字节占用达到预警水位',
  'reserve-low': '可用空间已触及安全余量', 'reserve-exhaustion-forecast': '预计提前触及安全余量',
  'inodes-critical': '文件节点严重不足', 'inodes-warning': '文件节点余量预警',
  'growth-baseline-missing': '采样不足，增长趋势未知', 'sampling-gap': '采样中断，增长趋势未知',
  'clock-not-increasing': '采样时间倒退，趋势未知',
};
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
        <p>文件节点占用：{disk.inodeUsedPercent === null ? '未知' : `${disk.inodeUsedPercent.toFixed(1)}%`}；剩余 {disk.availableInodes.toLocaleString()} / {disk.totalInodes.toLocaleString()}</p>
        <p>预计触及安全余量：{disk.daysToReserve === null ? (disk.bytesPerDay === null ? '未知' : '当前未观察到正增长') : `${disk.daysToReserve.toFixed(1)} 天`}</p>
        <p>日增长率：{rate(disk.bytesPerDay)}；提前预警窗口：{report.policy.horizonDays} 天</p>
      </div>)}
      {report.alerts.length > 0 && <ul className="list-inside list-disc space-y-1 text-sm" aria-label="容量预警原因">{report.alerts.map((alert, i) => <li key={`${alert.code}-${i}`}>{alertLabels[alert.code] ?? '来源或采集状态异常，当前风险未知'}</li>)}</ul>}
      <p className="text-xs text-muted-foreground">来源按实际分配字节计量；跨目录硬链接、Docker 共享层可能重叠，不能相加作为整盘占用或回收收益。</p>
    </>}
  </section>;
}
export function HostCapacityPanel(): JSX.Element {
  const [observation, setObservation] = useState<CapacityObservation>({ status: 'unknown', sampledAt: null, reason: '正在读取容量观测' });
  const [key, setKey] = useState(0);
  const samplingRunning = useRef(false);
  const [sampling, setSampling] = useState<CapacitySamplingStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [samplingError, setSamplingError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      try {
        const [next, status] = await Promise.all([
          apiRequest<CapacityObservation>('/api/host-capacity/observation', { signal: controller.signal }),
          apiRequest<CapacitySamplingStatus>('/api/host-capacity/sampling', { signal: controller.signal }),
        ]);
        if (!controller.signal.aborted) { setObservation(next); setSampling(status); samplingRunning.current = status.running; }
      } catch {
        if (!controller.signal.aborted) setObservation({ status: 'unknown', sampledAt: null, reason: '容量观测读取失败，当前风险未知，请刷新重试' });
      } finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void load(), samplingRunning.current ? 2000 : 60_000); } }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);
  const change = async (run: boolean) => {
    setSaving(true); setSamplingError('');
    try {
      const next = await apiRequest<CapacitySamplingStatus>(run ? '/api/host-capacity/sampling/run' : '/api/host-capacity/sampling',
        { method: run ? 'POST' : 'PUT', ...(run ? {} : { body: { enabled: !sampling?.enabled } }) });
      setSampling(next); samplingRunning.current = next.running; setKey(k => k + 1);
    } catch { setSamplingError('容量采样操作未能确认，请刷新状态，检查实例持久存储或已有外部采样配置后重试。'); }
    finally { setSaving(false); }
  };
  return <div className="space-y-2">
    <div className="space-y-2 rounded-lg border border-border p-4 text-sm" aria-label="只读容量采样设置">
      <h3 className="font-semibold">只读容量采样</h3>
      <p role="status">{sampling?.external ? '使用外部采样报告' : sampling?.running ? '正在采集目录实际分配与文件系统余量' : sampling?.enabled ? '已启用，每小时采集一次' : '采样未启用'}</p>
      <p className="text-xs text-muted-foreground">首次采样或增长基线不足时显示未知；采样不清理文件、不调整保留策略。历史最多保留192个小时点。</p>
      {sampling && <><p className="break-words text-xs text-muted-foreground">{sampling.coverage}</p>
        <p className="break-all text-xs">已采集目录：{Object.entries(sampling.sources).map(([name, root]) => `${name}：${root}`).join('；') || '尚无'}</p>
        {sampling.unavailableSources.length > 0 && <p className="text-xs text-muted-foreground">尚未存在的目录：{sampling.unavailableSources.join('、')}</p>}
        <p className="text-xs">最近开始：{sampling.lastStartedAt ? new Date(sampling.lastStartedAt).toLocaleString() : '尚未运行'}；最近完成：{sampling.lastFinishedAt ? new Date(sampling.lastFinishedAt).toLocaleString() : '尚未完成'}</p></>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!sampling || sampling.external || saving} onClick={() => void change(false)}>{saving ? '正在确认配置' : sampling?.enabled ? '暂停来源采样' : '启用来源采样'}</Button>
        <Button variant="outline" size="sm" disabled={!sampling?.enabled || sampling.running || saving} onClick={() => void change(true)}>{sampling?.running ? <><span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />正在采样</> : '立即采样'}</Button></div>
      {samplingError && <p role="alert" className="text-destructive">{samplingError}</p>}
    </div>
    <HostCapacityView observation={observation} /><Button variant="outline" size="sm" disabled={loading} aria-busy={loading} onClick={() => setKey(k => k + 1)}>{loading ? <><span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />读取容量观测</> : '刷新容量观测'}</Button></div>;
}
