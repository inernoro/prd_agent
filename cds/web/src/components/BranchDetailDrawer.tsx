import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Play, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

/*
 * BranchDetailDrawer — right-side slide-in showing the most-used parts
 * of BranchDetailPage without leaving the current page.
 *
 * Why exists: user feedback — "能在一个页面完成的，切勿跳转页面"。
 * Clicking "详情" on a BranchCard now slides this drawer over the
 * branch list grid instead of router-pushing to /branch-panel/<id>.
 *
 * What it loads:
 *   - GET /api/branches/:id              → branch + services
 *   - GET /api/branches/:id/logs         → recent build/run logs (last 5)
 *
 * Escape hatch: header has "完整页面" link → /branch-panel/<id> for the
 * dedicated page when the user wants the full set of tabs.
 */

interface ServiceState {
  profileId: string;
  containerName: string;
  hostPort: number;
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
  errorMessage?: string;
}

interface BranchDetailData {
  id: string;
  projectId: string;
  branch: string;
  status: string;
  services: Record<string, ServiceState>;
  commitSha?: string;
  subject?: string;
  lastDeployAt?: string;
}

interface OperationLogEvent {
  step: string;
  status: string;
  title?: string;
  log?: string;
}

interface OperationLog {
  type: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];
}

function statusLabel(s: string): string {
  return ({
    idle: '未运行', building: '构建中', starting: '启动中', running: '运行中',
    restarting: '重启中', stopping: '停止中', stopped: '已停止', error: '异常',
  } as Record<string, string>)[s] || s;
}

function statusClass(s: string): string {
  if (s === 'running') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (s === 'building' || s === 'starting' || s === 'restarting') return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  if (s === 'error') return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-[hsl(var(--hairline))] bg-muted/40 text-muted-foreground';
}

export function BranchDetailDrawer({
  branchId,
  projectId,
  open,
  onClose,
}: {
  branchId: string | null;
  projectId: string;
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [branch, setBranch] = useState<BranchDetailData | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      // The backend exposes /api/branches?project=<id> (list) but no
      // single-branch endpoint, mirroring how BranchDetailPage loads.
      const [branchesRes, logsRes] = await Promise.all([
        apiRequest<{ branches: BranchDetailData[] }>(`/api/branches?project=${encodeURIComponent(projectId)}`),
        apiRequest<{ logs: OperationLog[] }>(`/api/branches/${encodeURIComponent(branchId)}/logs`).catch(() => ({ logs: [] })),
      ]);
      const found = (branchesRes.branches || []).find((b) => b.id === branchId);
      if (!found) {
        setError('branch_not_found');
        setBranch(null);
      } else {
        setBranch(found);
      }
      setLogs(logsRes.logs || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [branchId, projectId]);

  useEffect(() => {
    if (!open || !branchId) return;
    void load();
  }, [open, branchId, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open || !branchId) return null;

  const services = branch ? Object.values(branch.services || {}) : [];
  const fullPageHref = `/branch-panel/${encodeURIComponent(branchId)}?project=${encodeURIComponent(projectId)}`;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="分支详情">
      <button
        type="button"
        className="cds-overlay-anim absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label="关闭分支详情"
      />
      <div
        className="cds-drawer-anim ml-auto flex h-full w-full max-w-[640px] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl"
        style={{ minHeight: 0 }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold">分支详情</span>
            {branch ? (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span className="min-w-0 truncate font-mono text-xs">{branch.branch}</span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm" title="完整页面">
              <a href={fullPageHref}>
                <ExternalLink />
                完整页面
              </a>
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void load()} title="刷新" aria-label="刷新">
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
              <X />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5" style={{ overscrollBehavior: 'contain' }}>
          {loading && !branch ? <LoadingBlock label="加载分支详情" /> : null}
          {error ? <ErrorBlock message={error} /> : null}
          {branch ? (
            <>
              {/* Status header */}
              <section className="cds-surface-raised cds-hairline px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(branch.status)}`}>
                    {statusLabel(branch.status)}
                  </span>
                  {branch.commitSha ? <span className="font-mono text-xs text-muted-foreground">{branch.commitSha.slice(0, 7)}</span> : null}
                </div>
                {branch.subject ? (
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{branch.subject}</p>
                ) : null}
              </section>

              {/* Services */}
              <section className="cds-surface-raised cds-hairline">
                <header className="border-b border-[hsl(var(--hairline))] px-5 py-3">
                  <h3 className="text-sm font-semibold">服务（{services.length}）</h3>
                </header>
                <div className="divide-y divide-[hsl(var(--hairline))]">
                  {services.length === 0 ? (
                    <div className="px-5 py-6 text-sm text-muted-foreground">没有运行中的服务。</div>
                  ) : (
                    services.map((svc) => (
                      <div key={svc.profileId} className="flex items-center gap-3 px-5 py-3">
                        <span className={`rounded border px-2 py-0.5 text-[11px] ${statusClass(svc.status)}`}>
                          {statusLabel(svc.status)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{svc.profileId}</span>
                        <span className="text-xs text-muted-foreground">:{svc.hostPort || '?'}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* Recent build/run logs */}
              <section className="cds-surface-raised cds-hairline">
                <header className="border-b border-[hsl(var(--hairline))] px-5 py-3">
                  <h3 className="text-sm font-semibold">最近构建（{logs.length}）</h3>
                </header>
                <div className="space-y-3 p-5">
                  {logs.length === 0 ? (
                    <div className="text-sm text-muted-foreground">还没有构建记录。</div>
                  ) : (
                    logs.slice().reverse().slice(0, 3).map((log) => (
                      <div key={`${log.startedAt}-${log.type}`} className="cds-surface-sunken cds-hairline">
                        <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs">
                          <span className={`rounded border px-2 py-0.5 ${statusClass(log.status)}`}>{statusLabel(log.status)}</span>
                          <span className="font-mono">{log.type}</span>
                          <span className="text-muted-foreground">{new Date(log.startedAt).toLocaleString()}</span>
                        </div>
                        <pre className="m-3 mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[hsl(var(--surface-base))] p-3 font-mono text-[11px] leading-5">
                          {log.events.slice(-12).map((event) => `[${event.status}] ${event.title || event.step}${event.log ? ` - ${event.log}` : ''}`).join('\n') || '(no log lines)'}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* Hint */}
              <p className="text-center text-xs text-muted-foreground">
                需要修改构建配置 / 环境变量 / 路由？打开
                <a href={`/settings/${encodeURIComponent(projectId)}`} className="ml-1 text-primary hover:underline">
                  项目设置
                </a>
                。需要查看完整日志、Bridge、提交历史？打开
                <a href={fullPageHref} className="ml-1 text-primary hover:underline">完整页面</a>
                。
              </p>
            </>
          ) : null}
        </div>

        {/* Quick action footer */}
        {branch ? (
          <footer className="flex items-center gap-2 border-t border-[hsl(var(--hairline))] px-4 py-3">
            <Button asChild className="flex-1">
              <a href={fullPageHref}>
                <Play />
                打开完整页面
              </a>
            </Button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
