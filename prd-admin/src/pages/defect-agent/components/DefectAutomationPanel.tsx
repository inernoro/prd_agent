import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Copy, ExternalLink, GitCommit, History, KeyRound, RefreshCw, RotateCcw, Share2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ensureDefectAutomationAuthorization, getDefectAutomationConsole } from '@/services';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import type {
  DefectAutomationAuthorization,
  DefectAutomationConsole,
  DefectAutomationRun,
} from '@/services/contracts/defectAgent';

interface DefectAutomationPanelProps {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  teamId?: string;
  onOpenShareManager: () => void;
}

const DEFAULT_STATUS = 'submitted,assigned,processing';

export function getAutomationPrimaryActionLabel(hasActiveAuthorization: boolean) {
  return hasActiveAuthorization ? '重新生成并复制配置' : '生成并复制每日任务配置';
}

export function DefectAutomationPanel({
  open,
  onClose,
  projectId,
  teamId,
  onOpenShareManager,
}: DefectAutomationPanelProps) {
  const [data, setData] = useState<DefectAutomationConsole | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [lastCopiedKey, setLastCopiedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getDefectAutomationConsole({
        projectId: projectId || undefined,
        teamId: teamId || undefined,
        status: DEFAULT_STATUS,
      });
      if (res.success && res.data) setData(res.data);
      else toast.error(res.error?.message || '加载缺陷自动化配置失败');
    } catch {
      toast.error('加载缺陷自动化配置失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, teamId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const activeAuth = data?.activeAuthorization ?? null;
  const dailyPlan = useMemo(() => {
    if (!data) return '';
    if (lastCopiedKey) return data.dailyPlan.replace('{K}', lastCopiedKey);
    return data.dailyPlan;
  }, [data, lastCopiedKey]);

  const handleCreateAndCopy = async () => {
    setCreating(true);
    try {
      const res = await ensureDefectAutomationAuthorization({
        forceNew: true,
        projectId: projectId || undefined,
        teamId: teamId || undefined,
        status: DEFAULT_STATUS,
      });
      if (!res.success || !res.data?.apiKey) {
        toast.error(res.error?.message || '生成缺陷处理授权失败');
        return;
      }
      const copyText = res.data.dailyPlan || res.data.copyTemplate?.dailyPlan;
      if (!copyText) {
        toast.error('授权已创建，但复制内容为空');
        return;
      }
      await navigator.clipboard.writeText(copyText);
      setLastCopiedKey(res.data.apiKey);
      toast.success('每日任务配置已复制');
      await load();
    } catch {
      toast.error('生成缺陷处理授权失败');
    } finally {
      setCreating(false);
    }
  };

  const handleCopyPlan = async () => {
    if (!dailyPlan) return;
    await navigator.clipboard.writeText(dailyPlan);
    toast.success(lastCopiedKey ? '每日任务配置已复制' : '已复制配置模板，请替换 K');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="缺陷自动化"
      maxWidth={920}
      content={
        <div className="mt-2 flex max-h-[76vh] min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <div className="surface-row rounded-lg p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-token-primary">
                  <Bot size={16} />
                  日常自动修复入口
                </div>
                <p className="mt-1 text-xs text-token-secondary">
                  定时任务只需要这里复制出的 domain 和 K。缺陷由接口自动拉取，不需要手工提供缺陷链接。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
                  {loading ? <MapSpinner size={12} /> : <RefreshCw size={12} />}
                  刷新
                </Button>
                <Button variant="secondary" size="sm" onClick={onOpenShareManager}>
                  <Share2 size={12} />
                  分享管理
                </Button>
                <Button variant="primary" size="sm" onClick={handleCreateAndCopy} disabled={creating}>
                  {creating ? <MapSpinner size={12} /> : <KeyRound size={12} />}
                  {getAutomationPrimaryActionLabel(Boolean(activeAuth))}
                </Button>
              </div>
            </div>
          </div>

          {loading && !data ? (
            <div className="surface-row rounded-lg p-4 text-xs text-token-muted">
              <MapSpinner size={12} /> 正在加载自动化配置...
            </div>
          ) : data ? (
            <>
              <div className="grid gap-2 md:grid-cols-4">
                <Metric label="待处理缺陷" value={data.stats.pendingDefectCount} />
                <Metric label="已拉取" value={data.stats.totalFetched} />
                <Metric label="已修复" value={data.stats.totalFixed} tone="success" />
                <Metric label="失败/阻塞" value={data.stats.totalFailed} tone={data.stats.totalFailed > 0 ? 'danger' : undefined} />
              </div>

              <section className="surface-row rounded-lg p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium text-token-primary">授权状态</h3>
                    <p className="text-xs text-token-muted">默认授权永不过期；旧 K 明文不会回显，丢失时重新生成即可。</p>
                  </div>
                  {activeAuth ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-token-nested px-2 py-1 text-xs text-token-success">
                      <CheckCircle2 size={12} />
                      可用
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-token-nested px-2 py-1 text-xs text-token-warning">
                      <RotateCcw size={12} />
                      需生成
                    </span>
                  )}
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <Field label="domain" value={data.domain} />
                  <Field label="scope" value={data.requiredScope} />
                  <Field label="授权名称" value={data.suggestedKeyName} />
                  <Field label="处理状态" value={data.statusFilter} />
                </div>
                <AuthorizationList items={data.authorizations} />
              </section>

              <section className="surface-row rounded-lg p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium text-token-primary">每日计划内容</h3>
                    <p className="text-xs text-token-muted">复制到 Codex 每日计划后，每天按单缺陷闭环执行。</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={handleCopyPlan}>
                    <Copy size={12} />
                    复制
                  </Button>
                </div>
                <textarea
                  readOnly
                  value={dailyPlan}
                  className="h-44 w-full resize-none rounded-lg border border-token-subtle bg-token-nested p-2 font-mono text-[11px] leading-5 text-token-primary outline-none"
                />
              </section>

              <section className="surface-row rounded-lg p-3">
                <div className="mb-2 flex items-center gap-2">
                  <History size={14} className="text-token-muted" />
                  <h3 className="text-sm font-medium text-token-primary">最近运行</h3>
                </div>
                <RunList runs={data.recentRuns} />
              </section>
            </>
          ) : (
            <div className="surface-row rounded-lg p-4 text-xs text-token-muted">暂无自动化配置</div>
          )}
        </div>
      }
    />
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  return (
    <div className="surface-row rounded-lg p-3">
      <div className="text-xs text-token-muted">{label}</div>
      <div
        className={cn(
          'mt-1 text-xl font-semibold text-token-primary',
          tone === 'success' && 'text-token-success',
          tone === 'danger' && 'text-token-error'
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="rounded-lg border border-token-subtle bg-token-nested px-2 py-1.5">
      <div className="text-[10px] text-token-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-token-primary">{value || '-'}</div>
    </div>
  );
}

function AuthorizationList({ items }: { items: DefectAutomationAuthorization[] }) {
  if (items.length === 0) {
    return <div className="mt-2 rounded-lg border border-token-subtle p-3 text-xs text-token-muted">暂无历史授权</div>;
  }
  return (
    <div className="mt-2 space-y-1.5">
      {items.map((item) => (
        <div key={item.id} className="rounded-lg border border-token-subtle bg-token-nested px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-token-primary">{item.name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-token-muted">
                <span>{item.keyPrefix || '无前缀'}</span>
                <span>{item.neverExpires ? '永不过期' : `过期 ${formatTime(item.expiresAt)}`}</span>
                <span>使用 {item.totalRequests}</span>
                {item.lastUsedAt && <span>最近 {formatTime(item.lastUsedAt)}</span>}
              </div>
            </div>
            <span className={cn('rounded-md px-2 py-0.5 text-[10px]', item.canUse ? 'text-token-success' : 'text-token-warning')}>
              {item.canUse ? '可用' : statusLabel(item.status)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RunList({ runs }: { runs: DefectAutomationRun[] }) {
  if (runs.length === 0) {
    return <div className="rounded-lg border border-token-subtle p-3 text-xs text-token-muted">暂无运行记录</div>;
  }
  return (
    <div className="space-y-1.5">
      {runs.map((run) => (
        <div key={run.id} className="rounded-lg border border-token-subtle bg-token-nested px-2 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs text-token-primary">
                {run.currentDefectNo ? `${run.currentDefectNo} ${run.currentDefectTitle || ''}` : run.id}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-token-muted">
                <span>{run.triggerType}</span>
                <span>{statusLabel(run.status)}</span>
                <span>拉取 {run.totalFetched}</span>
                <span>修复 {run.totalFixed}</span>
                <span>失败 {run.totalFailed}</span>
                <span>{formatTime(run.createdAt)}</span>
              </div>
              {run.lastFailureReason && (
                <div className="mt-1 truncate text-[10px] text-token-error">{run.lastFailureReason}</div>
              )}
            </div>
            <RunQuickLink run={run} />
          </div>
          <RunItemList items={run.items} />
        </div>
      ))}
    </div>
  );
}

function RunQuickLink({ run }: { run: DefectAutomationRun }) {
  const previewUrl = run.items.find((x) => x.previewUrl)?.previewUrl;
  if (!previewUrl) return null;
  return (
    <a
      href={previewUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-token-accent hover:opacity-80"
    >
      <ExternalLink size={12} />
      预览
    </a>
  );
}

function RunItemList({ items }: { items: DefectAutomationRun['items'] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 border-t border-token-subtle pt-2">
      {items.slice(0, 6).map((item) => (
        <div key={`${item.defectId}-${item.updatedAt}`} className="rounded-md bg-token-nested px-2 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a
              href={`/defect-agent?defectId=${encodeURIComponent(item.defectId)}`}
              className="min-w-0 truncate text-[11px] font-medium text-token-primary hover:underline"
            >
              {item.defectNo ? `${item.defectNo} ` : ''}{item.defectTitle || item.defectId}
            </a>
            <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', runItemStatusClass(item.status))}>
              {statusLabel(item.status)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-token-muted">
            {item.shortSha && (
              <span className="inline-flex items-center gap-1 font-mono text-token-secondary">
                <GitCommit size={10} />
                {item.shortSha}
              </span>
            )}
            {item.previewUrl && (
              <a href={item.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-token-accent hover:opacity-80">
                <ExternalLink size={10} />
                预览
              </a>
            )}
            {item.visualReportUrl && (
              <a href={item.visualReportUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-token-accent hover:opacity-80">
                <ExternalLink size={10} />
                验收
              </a>
            )}
            {item.failureReason && (
              <span className="inline-flex min-w-0 items-center gap-1 text-token-error">
                <AlertTriangle size={10} />
                <span className="truncate">{item.failureReason}</span>
              </span>
            )}
          </div>
        </div>
      ))}
      {items.length > 6 && <div className="px-2 text-[10px] text-token-muted">还有 {items.length - 6} 条缺陷记录</div>}
    </div>
  );
}

function runItemStatusClass(status?: string | null) {
  switch (status) {
    case 'fixed':
      return 'bg-token-nested text-token-success';
    case 'failed':
      return 'bg-token-nested text-token-error';
    case 'commit_written':
      return 'bg-token-nested text-token-accent';
    default:
      return 'bg-token-nested text-token-muted';
  }
}

export function statusLabel(status?: string | null) {
  switch (status) {
    case 'active':
      return '可用';
    case 'expired':
      return '已过期';
    case 'revoked':
      return '已撤销';
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'fetched':
      return '已拉取';
    case 'commented':
      return '已评论';
    case 'commit_written':
      return '已回写提交';
    case 'fixed':
      return '已修复';
    case 'cancelled':
      return '已取消';
    default:
      return status || '未知';
  }
}

function formatTime(value?: string | null) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('zh-CN');
  } catch {
    return value;
  }
}
