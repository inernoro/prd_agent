import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileText, Loader2, Plus, RefreshCw, RotateCcw, Rocket, Server } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ReleaseTarget {
  id: string;
  projectId: string;
  name: string;
  type: string;
  isEnabled: boolean;
  ssh?: {
    host: string;
    port: number;
    user: string;
    privateKeyRef: string;
    appPath: string;
    deployCommand: string;
    rollbackCommand?: string;
    healthcheckUrl: string;
  };
}

interface ReleaseRun {
  releaseId: string;
  projectId: string;
  branchId: string;
  commitSha: string;
  targetId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  previousReleaseId?: string;
  rollbackOf?: string;
  logs: ReleaseLogEntry[];
}

interface ReleaseLogEntry {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
}

interface RemoteHostOption {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  fingerprint: string;
  isEnabled: boolean;
}

interface CenterRow {
  target: ReleaseTarget;
  currentVersion: string;
  currentCommit: string;
  latestRun?: ReleaseRun;
  lastReleasedAt?: string;
  healthStatus: string;
  lastOperator?: string;
  canRollback: boolean;
}

interface CenterResponse {
  rows: CenterRow[];
  runs: ReleaseRun[];
}

interface TargetsResponse {
  targets: ReleaseTarget[];
  remoteHosts: RemoteHostOption[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; center: CenterResponse; hosts: RemoteHostOption[] };

const emptyDraft = {
  projectId: 'default',
  name: '',
  host: '',
  port: '22',
  user: '',
  privateKeyRef: '',
  appPath: '/opt/app',
  deployCommand: './deploy.sh',
  rollbackCommand: './rollback.sh',
  healthcheckUrl: '',
};

export function ReleaseCenterPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const initialProject = searchParams.get('project') || 'default';
  const [projectId, setProjectId] = useState(initialProject);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState({ ...emptyDraft, projectId: initialProject });
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState('');
  const [logRun, setLogRun] = useState<ReleaseRun | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [center, targets] = await Promise.all([
        apiRequest<CenterResponse>(`/api/releases/center?project=${encodeURIComponent(projectId)}`),
        apiRequest<TargetsResponse>(`/api/releases/targets?project=${encodeURIComponent(projectId)}`),
      ]);
      setState({ status: 'ok', center, hosts: targets.remoteHosts || [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const hostOptions = state.status === 'ok' ? state.hosts : [];
  const rows = state.status === 'ok' ? state.center.rows : [];
  const runs = state.status === 'ok' ? state.center.runs : [];

  const selectHost = (hostId: string): void => {
    const host = hostOptions.find((item) => item.id === hostId);
    setDraft((current) => ({
      ...current,
      privateKeyRef: hostId,
      host: host?.host || current.host,
      port: host ? String(host.sshPort || 22) : current.port,
      user: host?.sshUser || current.user,
    }));
  };

  const createTarget = async (): Promise<void> => {
    setCreating(true);
    setToast('');
    try {
      await apiRequest('/api/releases/targets', {
        method: 'POST',
        body: { ...draft, projectId, port: Number(draft.port || 22) },
      });
      setDraft({ ...emptyDraft, projectId });
      setToast('发布目标已创建');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const rollback = async (run: ReleaseRun): Promise<void> => {
    setToast('');
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/rollback`, { method: 'POST' });
      setLogRun(res.run);
      setToast('回滚已开始');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <AppShell
      active="release-center"
      wide
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '发布中心' }]} />}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace wide>
        <div className="space-y-4">
          <section className="cds-surface-raised cds-hairline p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold">发布中心</h1>
                <p className="mt-1 text-sm text-muted-foreground">目标、当前线上版本、发布日志和回滚入口。</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Project</span>
                <input
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value.trim() || 'default');
                    setDraft((current) => ({ ...current, projectId: event.target.value.trim() || 'default' }));
                  }}
                  className="h-9 w-48 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 font-mono text-sm outline-none focus:border-primary/60"
                />
              </label>
            </div>
            <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr]">
              <Field label="目标名称" value={draft.name} onChange={(value) => setDraft((c) => ({ ...c, name: value }))} placeholder="production-ssh" />
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">SSH 凭据</span>
                <select
                  value={draft.privateKeyRef}
                  onChange={(event) => selectHost(event.target.value)}
                  className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
                >
                  <option value="">选择 RemoteHost privateKeyRef</option>
                  {hostOptions.map((host) => (
                    <option key={host.id} value={host.id}>{host.name} · {host.sshUser}@{host.host}</option>
                  ))}
                </select>
              </label>
              <Field label="健康检查 URL" value={draft.healthcheckUrl} onChange={(value) => setDraft((c) => ({ ...c, healthcheckUrl: value }))} placeholder="https://example.com/healthz" />
              <Field label="Host" value={draft.host} onChange={(value) => setDraft((c) => ({ ...c, host: value }))} />
              <Field label="Port" value={draft.port} onChange={(value) => setDraft((c) => ({ ...c, port: value }))} />
              <Field label="User" value={draft.user} onChange={(value) => setDraft((c) => ({ ...c, user: value }))} />
              <Field label="App Path" value={draft.appPath} onChange={(value) => setDraft((c) => ({ ...c, appPath: value }))} />
              <Field label="Deploy Command" value={draft.deployCommand} onChange={(value) => setDraft((c) => ({ ...c, deployCommand: value }))} />
              <Field label="Rollback Command" value={draft.rollbackCommand} onChange={(value) => setDraft((c) => ({ ...c, rollbackCommand: value }))} />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {hostOptions.length === 0 ? (
                  <span className="inline-flex items-center gap-1 text-amber-500"><AlertTriangle className="h-3 w-3" /> 先在 Settings / Remote Hosts 添加 SSH 凭据。</span>
                ) : 'MVP 模板：SSH 脚本发布'}
              </div>
              <Button onClick={() => void createTarget()} disabled={creating}>
                {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                新增 SSH Target
              </Button>
            </div>
            {toast ? <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">{toast}</div> : null}
          </section>

          {state.status === 'loading' ? <LoadingBlock label="正在加载发布中心" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
          {state.status === 'ok' ? (
            <>
              <section className="cds-surface-raised cds-hairline overflow-hidden">
                <div className="border-b border-[hsl(var(--hairline))] px-4 py-3 text-sm font-semibold">目标与线上状态</div>
                {rows.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">还没有发布目标。</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[980px] text-left text-sm">
                      <thead className="bg-[hsl(var(--surface-sunken))] text-xs text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3">目标名称</th>
                          <th className="px-4 py-3">类型</th>
                          <th className="px-4 py-3">当前版本</th>
                          <th className="px-4 py-3">当前 commit</th>
                          <th className="px-4 py-3">最近发布时间</th>
                          <th className="px-4 py-3">健康状态</th>
                          <th className="px-4 py-3">最近发布人</th>
                          <th className="px-4 py-3">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.target.id} className="border-t border-[hsl(var(--hairline))]">
                            <td className="px-4 py-3 font-medium">{row.target.name}</td>
                            <td className="px-4 py-3"><CodeText>{row.target.type}</CodeText></td>
                            <td className="px-4 py-3"><CodeText>{row.currentVersion || '-'}</CodeText></td>
                            <td className="px-4 py-3"><CodeText>{row.currentCommit ? row.currentCommit.slice(0, 12) : '-'}</CodeText></td>
                            <td className="px-4 py-3 text-muted-foreground">{formatDate(row.lastReleasedAt)}</td>
                            <td className="px-4 py-3"><StatusPill status={row.healthStatus} /></td>
                            <td className="px-4 py-3">{row.lastOperator || '-'}</td>
                            <td className="px-4 py-3">
                              <div className="flex gap-2">
                                <Button asChild variant="outline" size="sm">
                                  <Link to={`/branch-list?project=${encodeURIComponent(row.target.projectId)}`}>
                                    <Rocket />
                                    发布
                                  </Link>
                                </Button>
                                {row.latestRun ? (
                                  <Button variant="outline" size="sm" onClick={() => setLogRun(row.latestRun!)}>
                                    <FileText />
                                    日志
                                  </Button>
                                ) : null}
                                {row.latestRun ? (
                                  <Button variant="outline" size="sm" onClick={() => void rollback(row.latestRun!)} disabled={!row.canRollback}>
                                    <RotateCcw />
                                    回滚
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="cds-surface-raised cds-hairline overflow-hidden">
                <div className="border-b border-[hsl(var(--hairline))] px-4 py-3 text-sm font-semibold">最近 ReleaseRun</div>
                {runs.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">还没有发布记录。</div>
                ) : (
                  <div className="divide-y divide-[hsl(var(--hairline))]">
                    {runs.slice(0, 12).map((run) => (
                      <button
                        key={run.releaseId}
                        type="button"
                        onClick={() => setLogRun(run)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_120px_120px_160px] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-[hsl(var(--surface-sunken))]/60"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Server className="h-4 w-4 text-muted-foreground" />
                            <CodeText>{run.releaseId}</CodeText>
                            {run.rollbackOf ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-xs text-amber-500">rollback</span> : null}
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">{run.branchId} · {run.commitSha}</div>
                        </div>
                        <StatusPill status={run.status} />
                        <div className="text-muted-foreground">{run.operator || '-'}</div>
                        <div className="text-muted-foreground">{formatDate(run.startedAt)}</div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </Workspace>
      <ReleaseLogDialog run={logRun} onClose={() => setLogRun(null)} />
    </AppShell>
  );
}

function ReleaseLogDialog({ run, onClose }: { run: ReleaseRun | null; onClose: () => void }): JSX.Element {
  const [current, setCurrent] = useState<ReleaseRun | null>(run);
  useEffect(() => setCurrent(run), [run]);
  useEffect(() => {
    if (!run || isTerminal(run.status)) return undefined;
    const source = new EventSource(apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${run.logs.at(-1)?.seq || 0}`));
    source.addEventListener('snapshot', (event) => {
      const data = parseSseJson<{ run: ReleaseRun; logs: ReleaseLogEntry[] }>(event);
      if (data?.run) setCurrent(data.run);
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSseJson<{ log: ReleaseLogEntry }>(event);
      if (!data?.log) return;
      setCurrent((prev) => prev ? { ...prev, logs: [...prev.logs, data.log] } : prev);
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSseJson<{ run: ReleaseRun }>(event);
      if (data?.run) setCurrent(data.run);
    });
    return () => source.close();
  }, [run]);
  return (
    <Dialog open={!!run} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>发布日志 {current?.releaseId ? <span className="font-mono text-sm text-muted-foreground">{current.releaseId}</span> : null}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between text-sm">
          <StatusPill status={current?.status || 'unknown'} />
          <span className="text-muted-foreground">{formatDate(current?.startedAt)}</span>
        </div>
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-xs leading-5">
          {(current?.logs || []).map((log) => `[${formatTime(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`).join('\n') || '暂无日志'}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }): JSX.Element {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
      />
    </label>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const tone = status.includes('failed') || status === 'failed'
    ? 'border-red-500/35 bg-red-500/10 text-red-500'
    : status.includes('running') || status === 'queued' || status === 'healthchecking'
      ? 'border-sky-500/35 bg-sky-500/10 text-sky-500'
      : status === 'success' || status === 'healthy' || status === 'rollback_success'
        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-500'
        : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  return <span className={`inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium ${tone}`}>{status}</span>;
}

function CodeText({ children }: { children: string }): JSX.Element {
  return <span className="font-mono text-xs text-muted-foreground">{children}</span>;
}

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function isTerminal(status: string): boolean {
  return ['success', 'failed', 'rollback_success', 'rollback_failed'].includes(status);
}

function parseSseJson<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}
