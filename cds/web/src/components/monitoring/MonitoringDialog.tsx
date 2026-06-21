/*
 * MonitoringDialog — tabbed ops/monitoring view (运维监控).
 *
 * Replaces the long single-scroll ops panel: the user was tired of scrolling
 * ("老是滑下去，太痛苦了"). Three tabs:
 *   1. 性能   — host CPU% / 内存% / 运行时长 / 核数 / load average + 容器总数
 *   2. 执行器 — executor node cards (status / branches / containers / CPU / mem)
 *   3. 活动   — recent project activity-logs (project context) or host summary
 *
 * Self-contained: fetches its own host-stats/executors/cluster every ~15s via
 * useMonitoringData while open. When projectId is supplied (project page) the
 * 活动 tab shows that project's activity; on the project-list page (no project)
 * it shows host/cluster-level info only.
 *
 * Theme: every color goes through tokens (light + dark). See cds-theme-tokens.md.
 */
import { useState } from 'react';
import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  HardDrive,
  Layers,
  Network,
  RefreshCw,
  Server,
  Timer,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorBlock, LoadingBlock, MetricTile } from '@/pages/cds-settings/components';
import type { ExecutorNode } from '@/pages/cds-settings/types';
import {
  useMonitoringData,
  type MonitoringActivityLog,
  type MonitoringActivityState,
  type MonitoringSnapshot,
} from './useMonitoringData';

function formatBytesFromMB(value?: number): string {
  if (!value || value <= 0) return '未知';
  if (value >= 1024) return `${Math.round(value / 102.4) / 10} GB`;
  return `${value} MB`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function executorMemPercent(node: ExecutorNode): number {
  const total = node.capacity?.memoryMB || 0;
  if (total <= 0) return 0;
  return Math.round(((node.load?.memoryUsedMB || 0) / total) * 100);
}

function formatRelativeTime(value?: string | null): string {
  if (!value) return '暂无';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '暂无';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  deploy: '部署',
  'deploy-failed': '部署失败',
  pull: '拉取',
  stop: '停止',
  restart: '重启',
  crash: '崩溃',
  'colormark-on': '标记调试',
  'colormark-off': '取消标记',
  'ai-occupy': 'AI 接管',
  'ai-release': 'AI 释放',
  'branch-deleted': '删除分支',
  'branch-created': '创建分支',
  'resource-created': '新建资源',
  'resource-deleted': '删除资源',
  'resource-restart': '重启资源',
  'resource-external-access': '外部访问',
  'resource-db-clone': '克隆库',
  'resource-backup': '备份',
  'resource-restore': '恢复',
  'resource-credentials-reset': '重置凭据',
  'resource-connection-inject': '注入连接',
  'resource-data-query': '数据查询',
};

function activityTypeLabel(type: string): string {
  return ACTIVITY_TYPE_LABELS[type] || type;
}

const TAB_TRIGGER_CLASS =
  'w-auto min-h-9 flex-row justify-center rounded-md border border-transparent px-4 data-[state=active]:border-[hsl(var(--hairline))] data-[state=active]:bg-[hsl(var(--surface-raised))]';

export interface MonitoringDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
  projectName?: string;
}

export function MonitoringDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
}: MonitoringDialogProps): JSX.Element {
  const { state, activity, reload } = useMonitoringData(open, projectId);
  const [tab, setTab] = useState('performance');

  const title = projectName ? `运维监控 · ${projectName}` : '运维监控';
  const description = projectId
    ? '主机性能、执行器节点与本项目最近活动。每 15 秒自动刷新。'
    : '主机性能与执行器节点（系统级）。每 15 秒自动刷新。';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl overflow-hidden p-0"
        style={{ maxHeight: '86vh' }}
      >
        <div className="flex min-h-0 flex-col" style={{ maxHeight: '86vh' }}>
          <DialogHeader className="shrink-0 border-b border-[hsl(var(--hairline))] px-6 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle className="flex items-center gap-2">
                  <Gauge className="h-5 w-5 text-muted-foreground" />
                  {title}
                </DialogTitle>
                <DialogDescription className="mt-1.5">{description}</DialogDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void reload()}
              >
                <RefreshCw />
                刷新
              </Button>
            </div>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="shrink-0 flex-row gap-2 border-b border-[hsl(var(--hairline))] px-6 py-3">
              <TabsTrigger value="performance" className={TAB_TRIGGER_CLASS}>
                <Gauge className="h-4 w-4 shrink-0" />
                性能
              </TabsTrigger>
              <TabsTrigger value="executors" className={TAB_TRIGGER_CLASS}>
                <Server className="h-4 w-4 shrink-0" />
                执行器
              </TabsTrigger>
              <TabsTrigger value="activity" className={TAB_TRIGGER_CLASS}>
                <Activity className="h-4 w-4 shrink-0" />
                活动
              </TabsTrigger>
            </TabsList>

            <div
              className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
              style={{ minHeight: 0, overscrollBehavior: 'contain' }}
            >
              {state.status === 'loading' ? <LoadingBlock label="加载监控数据" /> : null}
              {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
              {state.status === 'ok' ? (
                <>
                  <TabsContent value="performance">
                    <PerformanceTab data={state.data} />
                  </TabsContent>
                  <TabsContent value="executors">
                    <ExecutorsTab data={state.data} />
                  </TabsContent>
                  <TabsContent value="activity">
                    <ActivityTab
                      data={state.data}
                      activity={activity}
                      hasProject={Boolean(projectId)}
                    />
                  </TabsContent>
                </>
              ) : null}
            </div>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PerformanceTab({ data }: { data: MonitoringSnapshot }): JSX.Element {
  const { host, totalContainers, executors } = data;
  const usedMem = host.mem.totalMB - host.mem.freeMB;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricTile
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="CPU 使用率"
          value={`${host.cpu.loadPercent}%`}
        />
        <MetricTile
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="内存使用率"
          value={`${host.mem.usedPercent}%`}
        />
        <MetricTile
          icon={<Boxes className="h-3.5 w-3.5" />}
          label="容器总数"
          value={totalContainers}
          detail={executors.length > 0 ? `${executors.length} 个执行器` : undefined}
        />
        <MetricTile
          icon={<Timer className="h-3.5 w-3.5" />}
          label="运行时长"
          value={formatUptime(host.uptimeSeconds)}
        />
        <MetricTile
          icon={<Layers className="h-3.5 w-3.5" />}
          label="核数"
          value={host.cpu.cores}
        />
        <MetricTile
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="负载均值"
          value={`${host.cpu.loadAvg1}`}
          detail={`5分 ${host.cpu.loadAvg5} · 15分 ${host.cpu.loadAvg15}`}
        />
      </div>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3 text-xs leading-6 text-muted-foreground">
        内存 {formatBytesFromMB(usedMem)} / {formatBytesFromMB(host.mem.totalMB)}
        ，load {host.cpu.loadAvg1}/{host.cpu.loadAvg5}/{host.cpu.loadAvg15}
        ，运行模式 {data.cluster.effectiveRole || data.cluster.mode || 'standalone'}
      </div>
    </div>
  );
}

function ExecutorsTab({ data }: { data: MonitoringSnapshot }): JSX.Element {
  const { executors } = data;
  if (executors.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-10 text-center text-sm text-muted-foreground">
        暂无执行器节点。单机部署使用本机执行器；扩容时在 CDS 系统设置的集群页签发连接码。
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {executors.map((node) => (
        <ExecutorRow key={node.id || `${node.host}-${node.role}`} node={node} />
      ))}
    </div>
  );
}

function ExecutorRow({ node }: { node: ExecutorNode }): JSX.Element {
  const memPercent = executorMemPercent(node);
  const statusClass =
    node.status === 'online'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
      : node.status === 'draining'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600'
        : 'border-destructive/30 bg-destructive/10 text-destructive';
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Network className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-semibold">{node.id || '?'}</span>
        <span className={`rounded border px-1.5 py-0.5 text-xs ${statusClass}`}>
          {node.status || 'unknown'}
        </span>
      </div>
      <div className="mt-2 truncate text-xs text-muted-foreground">
        {node.host || 'local'}
        {node.port ? `:${node.port}` : ''} · {node.role || 'remote'} · 心跳 {formatRelativeTime(node.lastHeartbeat)}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label="分支" value={node.branchCount || 0} />
        <MetricTile label="容器" value={node.runningContainers ?? '-'} />
        <MetricTile label="CPU" value={`${node.load?.cpuPercent ?? 0}%`} />
        <MetricTile label="内存" value={`${memPercent}%`} />
      </div>
    </div>
  );
}

function ActivityTab({
  data,
  activity,
  hasProject,
}: {
  data: MonitoringSnapshot;
  activity: MonitoringActivityState;
  hasProject: boolean;
}): JSX.Element {
  if (!hasProject) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3 text-sm leading-6 text-muted-foreground">
          系统级监控无单一项目语境。进入具体项目后，这里会展示该项目最近的部署、拉取、停止等活动记录。
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricTile label="执行器" value={data.executors.length} />
          <MetricTile label="容器总数" value={data.totalContainers} />
          <MetricTile
            label="运行模式"
            value={data.cluster.effectiveRole || data.cluster.mode || 'standalone'}
          />
        </div>
      </div>
    );
  }
  if (activity.status === 'loading' || activity.status === 'idle') {
    return <LoadingBlock label="加载活动记录" />;
  }
  if (activity.status === 'error') {
    return <ErrorBlock message={activity.message} />;
  }
  if (activity.logs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-10 text-center text-sm text-muted-foreground">
        本项目暂无活动记录。部署、拉取、停止等操作会记录在这里。
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {activity.logs.map((log) => (
        <ActivityRow key={log.id} log={log} />
      ))}
    </ul>
  );
}

function ActivityRow({ log }: { log: MonitoringActivityLog }): JSX.Element {
  const resultClass =
    log.result === 'failed'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : log.result === 'pending'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600'
        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  return (
    <li className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-xs text-foreground">
          {activityTypeLabel(log.type)}
        </span>
        {log.result ? (
          <span className={`rounded border px-1.5 py-0.5 text-xs ${resultClass}`}>
            {log.result === 'failed' ? '失败' : log.result === 'pending' ? '进行中' : '成功'}
          </span>
        ) : null}
        {log.branchName ? (
          <span className="text-xs font-medium text-foreground">{log.branchName}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">{formatRelativeTime(log.at)}</span>
      </div>
      {log.note ? (
        <p className="mt-1.5 break-words text-xs leading-5 text-muted-foreground">{log.note}</p>
      ) : null}
      <div className="mt-1.5 text-xs text-muted-foreground">
        {log.actor ? `${log.actor}` : ''}
        {log.resourceName ? ` · ${log.resourceName}` : ''}
      </div>
    </li>
  );
}
