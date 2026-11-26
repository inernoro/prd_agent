import { useEffect, useState } from 'react';
import { MotionLink as Link } from '@/components/layout/RouteMotion';
import { apiRequest, apiUrl, ApiError } from '@/lib/api';
import { formatDurationMs } from '@/lib/deploymentMeta';
import { userErrorMessage } from '@/lib/userErrorMessage';
import { LoadingBlock } from '@/pages/cds-settings/components';

interface BranchIdentity {
  branchId?: string;
  branchName?: string;
  projectName: string;
}

interface ActiveRun extends BranchIdentity {
  id: string;
  commitSha?: string;
  status: string;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  latestEvent?: { message: string; at: string; phase: string; profileIds?: string[] };
  ciUrl?: string;
}

interface Snapshot {
  generatedAt: string;
  runs: ActiveRun[];
  recent: ActiveRun[];
  ci: Array<BranchIdentity & { commitSha?: string; since?: string; label?: string; ciUrl?: string }>;
  buildQueue: Array<BranchIdentity & { ahead: number; queuedAt: string; serviceIds: string[] }>;
  buildCapacity: { active: number; queued: number; max: number } | null;
  phaseQueue: Array<BranchIdentity & { phase: string; profileId?: string; enqueuedAt: number; reason: string }>;
}

const RUN_LABELS: Record<string, string> = {
  pending: '已受理', preparing: '准备部署', building: '构建与启动', starting: '启动服务',
  verifying: '就绪检查', queued: '等待前序部署', 'artifact-wait': '镜像核验', 'artifact-ready': '等待部署资格',
  running: '已就绪', failed: '部署失败', cancelled: '已取消',
};

const PHASE_LABELS: Record<string, string> = { pull: '拉取镜像', start: '启动容器', ready: '就绪检查', cleanup: '清理', terminal: '部署收尾' };
const QUEUE_REASONS: Record<string, string> = {
  'memory-headroom': '等待可用内存', 'pid-headroom': '等待进程配额',
  'cpu-startup-capacity': '等待可用 CPU', 'build-capacity': '等待构建槽位', 'phase-capacity': '等待阶段槽位',
};

function elapsed(now: number, since?: string | number) {
  const start = typeof since === 'string' ? Date.parse(since) : since;
  return typeof start === 'number' && Number.isFinite(start) ? formatDurationMs(Math.max(0, now - start)) : '未知';
}

function branchLink(row: BranchIdentity) {
  const title = [row.projectName, row.branchName || row.branchId].filter(Boolean).join(' / ');
  return row.branchId
    ? <Link className="font-semibold hover:underline" to={`/branch-panel/${encodeURIComponent(row.branchId)}`}>{title}</Link>
    : <strong>{title}</strong>;
}

function ciLink(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password) {
      return <a className="underline underline-offset-4" href={url.href} target="_blank" rel="noreferrer">查看 GitHub 构建</a>;
    }
  } catch { /* 无有效构建链接。 */ }
  return null;
}

const panelClass = 'min-w-0 rounded-lg border border-[hsl(var(--hairline))] p-4';
const rowClass = 'min-w-0 space-y-1 py-3 text-sm [overflow-wrap:anywhere]';
const detailClass = 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground';

export function DeploymentQueueTab({ projectId, refreshKey }: { projectId?: string; refreshKey: number }): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'artifact' | 'queued' | 'executing' | 'recent'>('all');

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ view: 'active' });
    if (projectId) query.set('project', projectId);
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const payload = await apiRequest<Snapshot>(`/api/deployment-runs?${query}`, { signal: controller.signal, headers: { 'X-CDS-Poll': 'true' } });
        if (!payload.generatedAt || !Array.isArray(payload.phaseQueue)) throw new Error('当前 CDS 版本尚未提供部署队列。');
        if (!controller.signal.aborted) { setSnapshot(payload); setError(''); }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setSnapshot(undefined);
        setError(userErrorMessage(err));
      } finally {
        pending = false;
      }
    };
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [projectId, refreshKey]);

  if (!snapshot && !error) return <LoadingBlock label="读取部署队列" />;
  if (!snapshot) return <p role="alert" className="text-sm text-bad">{error}</p>;

  const now = Date.parse(snapshot.generatedAt);
  const artifact = snapshot.runs.filter(run => run.phase === 'artifact-wait').length;
  const queued = snapshot.runs.filter(run => run.status === 'queued' && run.phase !== 'artifact-wait').length;
  const executing = snapshot.runs.length - artifact - queued;
  const runs = filter === 'recent' ? snapshot.recent : snapshot.runs.filter(run => filter === 'all'
    || (filter === 'artifact' && run.phase === 'artifact-wait')
    || (filter === 'queued' && run.status === 'queued' && run.phase !== 'artifact-wait')
    || (filter === 'executing' && run.phase !== 'artifact-wait' && run.status !== 'queued'));
  const criteria = [
    ['all', '所有在途', snapshot.runs.length], ['artifact', '镜像核验', artifact],
    ['queued', '部署排队', queued], ['executing', '执行中', executing], ['recent', '最近结束', snapshot.recent.length],
  ] as const;
  const timeLabel = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
  return <div className="space-y-4" data-testid="deployment-queue">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-base font-semibold">{projectId ? '项目部署进度' : '本实例部署进度'}</h2>
      <p className="text-xs text-muted-foreground">刷新于 {timeLabel} · 每 15 秒更新</p>
    </div>
    {error && <p className="text-sm text-warn" role="alert">刷新失败，当前显示上次记录。{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <section className={panelClass} aria-label="部署列表">
        <div className="flex flex-wrap gap-2">
          {criteria.map(([value, label, count]) => <button type="button" key={value} onClick={() => setFilter(value)}
            aria-pressed={filter === value} className={`min-h-9 rounded-md border px-3 text-sm ${filter === value ? 'border-foreground/40 bg-muted font-semibold' : 'border-[hsl(var(--hairline))] text-muted-foreground'}`}>
            {label} <span className="tabular-nums">{count}</span>
          </button>)}
        </div>
        <ul className="mt-2 divide-y divide-[hsl(var(--hairline))]">
          {runs.map(run => <li className={rowClass} key={run.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">{branchLink(run)}
              <span className={`font-medium ${run.status === 'failed' ? 'text-bad' : run.status === 'running' ? 'text-ok' : 'text-info'}`}>
                {RUN_LABELS[run.phase] || RUN_LABELS[run.status] || run.status}</span></div>
            <div className={detailClass}><span>{run.finishedAt ? '总耗时' : '已用'} {elapsed(run.finishedAt ? Date.parse(run.finishedAt) : now, run.startedAt)}</span>{run.commitSha && <code>{run.commitSha.slice(0, 10)}</code>}
              {ciLink(run.ciUrl)}<a className="underline underline-offset-4" href={apiUrl(`/api/deployment-runs/${encodeURIComponent(run.id)}`)} target="_blank" rel="noreferrer">运行事件</a>
              {run.latestEvent && <span>最近事件在 {elapsed(now, run.latestEvent.at)} 前</span>}</div>
            {run.latestEvent && <p className="text-muted-foreground">{run.latestEvent.message}
              {Array.isArray(run.latestEvent.profileIds) && run.latestEvent.profileIds.length > 0 && <span> · {run.latestEvent.profileIds.join('、')}</span>}</p>}
          </li>)}
        </ul>
        {!runs.length && <p className="py-3 text-sm text-muted-foreground">{filter === 'recent' ? '暂无已结束的部署。' : '当前筛选下没有在途部署。'}</p>}
      </section>
      <div className="min-w-0 space-y-4">
        <section className={panelClass} aria-label="执行资源排队">
          <h3 className="font-semibold">执行资源排队</h3>
          {snapshot.buildCapacity && <p className="mt-1 text-sm text-muted-foreground">本机源码构建 {snapshot.buildCapacity.active}/{snapshot.buildCapacity.max} 在用 · {snapshot.buildCapacity.queued} 排队</p>}
          {snapshot.buildQueue.map(row => <div className={rowClass} key={row.branchId}>
            {branchLink(row)}<p className="text-muted-foreground">构建 · 前面有 {row.ahead} 个服务 · 已等 {elapsed(now, row.queuedAt)}</p>
            <p className={detailClass}>{row.serviceIds.join('、')}</p>
          </div>)}
          {snapshot.phaseQueue.map((row, index) => <div className={rowClass} key={`${row.phase}:${row.branchId}:${row.profileId}:${row.enqueuedAt}:${index}`}>
            {branchLink(row)}<p className="text-muted-foreground">{PHASE_LABELS[row.phase] || row.phase} · {QUEUE_REASONS[row.reason] || '等待资源'} · 已等 {elapsed(now, row.enqueuedAt)}</p>
            {row.profileId && <p className={detailClass}>{row.profileId}</p>}
          </div>)}
          {!snapshot.buildQueue.length && !snapshot.phaseQueue.length
            && <p className="mt-2 text-sm text-muted-foreground">当前没有可见的执行资源排队。</p>}
        </section>
        <section className={panelClass} aria-label="等待 GitHub 镜像">
          <h3 className="font-semibold">等待 GitHub 镜像 <span className="text-muted-foreground">{snapshot.ci.length}</span></h3>
          {snapshot.ci.length === 0 && <p className="mt-2 text-sm text-muted-foreground">没有尚待 GitHub 镜像回执的分支。</p>}
          {snapshot.ci.map(row => <div className={rowClass} key={row.branchId}>
            {branchLink(row)}
            <div className={detailClass}><span>已等 {elapsed(now, row.since)}</span>{row.commitSha && <code>{row.commitSha.slice(0, 10)}</code>}{ciLink(row.ciUrl)}</div>
            {row.label && <p className="text-muted-foreground">{row.label}</p>}
          </div>)}
        </section>
      </div>
    </div>
  </div>;
}
