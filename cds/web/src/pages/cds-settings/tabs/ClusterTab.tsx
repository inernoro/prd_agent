import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Link2,
  Loader2,
  Network,
  PowerOff,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, EmptyBlock, ErrorBlock, Field, LoadingBlock, MetricTile, Section } from '../components';
import type { ClusterStatus, ExecutorNode, ExecutorsResponse, HostStatsResponse, LoadState } from '../types';

interface ClusterData {
  status: ClusterStatus;
  executors: ExecutorsResponse;
  host: HostStatsResponse;
}

interface TokenResponse {
  connectionCode: string;
  masterUrl?: string;
  expiresAt?: string;
  ttlSeconds?: number;
}

interface JoinResponse {
  success?: boolean;
  executorId?: string;
  masterUrl?: string;
  restartWarning?: string;
}

type ActionState = Record<string, string>;

function formatBytesFromMB(value?: number): string {
  if (!value || value <= 0) return '未知';
  if (value >= 1024) return `${Math.round(value / 102.4) / 10} GB`;
  return `${value} MB`;
}

function formatDate(value?: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString();
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

export function ClusterTab(): JSX.Element {
  const [state, setState] = useState<LoadState<ClusterData>>({ status: 'loading' });
  const [action, setAction] = useState<ActionState>({});
  const [token, setToken] = useState<TokenResponse | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [message, setMessage] = useState('');
  const [joinResult, setJoinResult] = useState<JoinResponse | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [status, executors, host] = await Promise.all([
        apiRequest<ClusterStatus>('/api/cluster/status'),
        apiRequest<ExecutorsResponse>('/api/executors'),
        apiRequest<HostStatsResponse>('/api/host-stats', { headers: { 'X-CDS-Poll': 'true' } }),
      ]);
      setState({ status: 'ok', data: { status, executors, host } });
    } catch (err: unknown) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const nodes = state.status === 'ok' ? state.data.executors.executors || [] : [];
  const remoteNodes = useMemo(() => nodes.filter((node) => node.role !== 'embedded'), [nodes]);

  async function withNodeAction(node: ExecutorNode, label: string, work: () => Promise<void>): Promise<void> {
    if (!node.id) return;
    setAction((current) => ({ ...current, [node.id!]: label }));
    setMessage('');
    try {
      await work();
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAction((current) => {
        const next = { ...current };
        delete next[node.id!];
        return next;
      });
    }
  }

  async function drainNode(node: ExecutorNode): Promise<void> {
    if (!node.id) return;
    await withNodeAction(node, '排空中', async () => {
      await apiRequest(`/api/executors/${encodeURIComponent(node.id!)}/drain`, { method: 'POST' });
      setMessage(`执行器 ${node.id} 已进入排空状态`);
    });
  }

  async function removeNode(node: ExecutorNode): Promise<void> {
    if (!node.id) return;
    await withNodeAction(node, '移除中', async () => {
      await apiRequest(`/api/executors/${encodeURIComponent(node.id!)}`, { method: 'DELETE' });
      setMessage(`执行器 ${node.id} 已移除`);
    });
  }

  async function issueToken(): Promise<void> {
    setAction((current) => ({ ...current, issue: '签发中' }));
    setMessage('');
    try {
      const data = await apiRequest<TokenResponse>('/api/cluster/issue-token', { method: 'POST' });
      setToken(data);
      setMessage('连接码已生成');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAction((current) => {
        const next = { ...current };
        delete next.issue;
        return next;
      });
    }
  }

  async function joinCluster(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const code = joinCode.trim();
    if (!code) {
      setMessage('请输入连接码');
      return;
    }
    setAction((current) => ({ ...current, join: '加入中' }));
    setMessage('');
    setJoinResult(null);
    try {
      const data = await apiRequest<JoinResponse>('/api/cluster/join', {
        method: 'POST',
        body: { connectionCode: code },
      });
      setJoinResult(data);
      setJoinCode('');
      setMessage(data.restartWarning || '已加入集群');
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAction((current) => {
        const next = { ...current };
        delete next.join;
        return next;
      });
    }
  }

  async function leaveCluster(): Promise<void> {
    setAction((current) => ({ ...current, leave: '退出中' }));
    setMessage('');
    try {
      await apiRequest('/api/cluster/leave', { method: 'POST' });
      setMessage('已退出集群，建议执行 ./exec_cds.sh restart');
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAction((current) => {
        const next = { ...current };
        delete next.leave;
        return next;
      });
    }
  }

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const { status, host } = state.data;
  const capacity = status.capacity;
  const mode = status.effectiveRole || status.mode || 'standalone';
  const canLeave = mode === 'executor' || mode === 'hybrid';

  return (
    <Section title="集群" description="主节点、执行器与本机容量。">
      <div className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-4">
          <MetricTile label="运行模式" value={mode} />
          <MetricTile label="远端节点" value={status.remoteExecutorCount || remoteNodes.length || 0} />
          <MetricTile label="空闲容量" value={capacity?.freePercent !== undefined ? `${Math.round(capacity.freePercent)}%` : '未知'} />
          <MetricTile label="本机运行" value={formatUptime(host.uptimeSeconds)} />
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold">执行器节点</h3>
                  <p className="mt-1 text-xs text-muted-foreground">排空用于停止接新部署；移除只清注册表，不停止远端进程。</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  <RefreshCw />
                  刷新
                </Button>
              </div>

              {nodes.length === 0 ? (
                <EmptyBlock
                  title="暂无执行器"
                  description={
                    <>
                      当前没有注册节点。单机部署会使用本机执行器；需要扩容时在主节点签发连接码，在新机器粘贴加入。
                    </>
                  }
                />
              ) : (
                <div className="space-y-3">
                  {nodes.map((node) => (
                    <ExecutorCard
                      key={node.id || `${node.host}-${node.role}`}
                      node={node}
                      actionLabel={node.id ? action[node.id] : undefined}
                      onDrain={() => void drainNode(node)}
                      onRemove={() => void removeNode(node)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">主节点连接</h3>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="主节点 URL">{status.masterUrl || '本机即主节点'}</Field>
                <Field label="调度策略"><CodePill>{status.strategy || 'least-load'}</CodePill></Field>
                <Field label="总容量">{capacity?.total?.maxBranches ?? capacity?.totalSlots ?? '未知'} 槽</Field>
                <Field label="已用容量">{capacity?.used?.branches ?? capacity?.usedSlots ?? 0} 槽</Field>
              </div>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <h3 className="text-sm font-semibold">本机健康</h3>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MetricTile label="CPU" value={`${host.cpu.loadPercent}%`} />
                <MetricTile label="内存" value={`${host.mem.usedPercent}%`} />
                <MetricTile label="核数" value={host.cpu.cores} />
              </div>
              <div className="mt-3 text-xs leading-5 text-muted-foreground">
                内存 {formatBytesFromMB(host.mem.totalMB - host.mem.freeMB)} / {formatBytesFromMB(host.mem.totalMB)}
                ，load {host.cpu.loadAvg1}/{host.cpu.loadAvg5}/{host.cpu.loadAvg15}
              </div>
            </div>

            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">扩容连接码</h3>
                  <p className="mt-1 text-xs text-muted-foreground">在主节点生成，复制到另一台机器加入。</p>
                </div>
                <Button type="button" size="sm" onClick={() => void issueToken()} disabled={Boolean(action.issue)}>
                  {action.issue ? <Loader2 className="animate-spin" /> : <Link2 />}
                  签发
                </Button>
              </div>
              {token ? (
                <div className="space-y-3">
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-3 font-mono text-xs">
                    {token.connectionCode}
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void navigator.clipboard.writeText(token.connectionCode).then(() => setMessage('连接码已复制'))}
                    >
                      <Copy />
                      复制
                    </Button>
                    {token.expiresAt ? <span className="text-xs text-muted-foreground">过期：{formatDate(token.expiresAt)}</span> : null}
                  </div>
                </div>
              ) : null}
            </div>

            <form className="rounded-md border border-border bg-card p-4" onSubmit={(event) => void joinCluster(event)}>
              <div className="mb-3 flex items-center gap-2">
                <Network className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">加入主节点</h3>
              </div>
              <textarea
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="粘贴 connection code"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="submit" disabled={Boolean(action.join)}>
                  {action.join ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  加入
                </Button>
                <ConfirmAction
                  title="退出集群"
                  description="本节点将恢复 standalone 配置，建议随后重启 CDS。"
                  confirmLabel="退出"
                  pending={Boolean(action.leave)}
                  disabled={!canLeave}
                  onConfirm={leaveCluster}
                  trigger={
                    <Button type="button" variant="outline" disabled={!canLeave || Boolean(action.leave)}>
                      {action.leave ? <Loader2 className="animate-spin" /> : <Unplug />}
                      退出
                    </Button>
                  }
                />
              </div>
              {joinResult?.executorId ? (
                <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600">
                  已注册：{joinResult.executorId}
                </div>
              ) : null}
            </form>
          </aside>
        </div>

        {message ? (
          <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            {message}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ExecutorCard({
  node,
  actionLabel,
  onDrain,
  onRemove,
}: {
  node: ExecutorNode;
  actionLabel?: string;
  onDrain: () => void;
  onRemove: () => void;
}): JSX.Element {
  const isEmbedded = node.role === 'embedded';
  const memPercent = executorMemPercent(node);
  const statusClass =
    node.status === 'online'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
      : node.status === 'draining'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600'
        : 'border-destructive/30 bg-destructive/10 text-destructive';

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <Network className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-semibold">{node.id || '?'}</span>
              <span className={`rounded border px-1.5 py-0.5 text-xs ${statusClass}`}>
                {actionLabel || node.status || 'unknown'}
              </span>
            </div>
            <div className="mt-2 truncate text-xs text-muted-foreground">
              {node.host || 'local'}{node.port ? `:${node.port}` : ''} · {node.role || 'remote'} · 心跳 {formatDate(node.lastHeartbeat)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ConfirmAction
              title="排空执行器"
              description={<span className="break-all font-mono">{node.id}</span>}
              confirmLabel="排空"
              disabled={isEmbedded || node.status !== 'online'}
              pending={Boolean(actionLabel)}
              onConfirm={onDrain}
              trigger={
                <Button type="button" variant="outline" size="sm" disabled={isEmbedded || node.status !== 'online' || Boolean(actionLabel)}>
                  <PowerOff />
                  排空
                </Button>
              }
            />
            <ConfirmAction
              title="移除执行器"
              description={
                <>
                  <span className="break-all font-mono">{node.id}</span>
                  <span className="mt-1 block">只清理主节点注册表，不会停止远端进程。</span>
                </>
              }
              confirmLabel="移除"
              disabled={isEmbedded}
              pending={Boolean(actionLabel)}
              onConfirm={onRemove}
              trigger={
                <Button type="button" variant="outline" size="sm" disabled={isEmbedded || Boolean(actionLabel)}>
                  <Trash2 />
                  移除
                </Button>
              }
            />
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <MetricTile label="分支" value={node.branchCount || 0} />
          <MetricTile label="容器" value={node.runningContainers ?? '-'} />
          <MetricTile label="CPU" value={`${node.load?.cpuPercent ?? 0}%`} />
          <MetricTile label="内存" value={`${memPercent}%`} />
        </div>
      </CardContent>
    </Card>
  );
}
