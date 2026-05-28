/**
 * GitHubWebhookLogTab — GitHub Webhook 投递日志(2026-05-07)
 *
 * 用户反馈"github 的 hook 日志能看到吗?每次触发的 hook 日志我需要能看到,
 * 好知道的确更新了,每一条必须非常清晰地展示,点开还能看到详情,这种链路
 * 追踪很重要,包括提交的版本短 id 什么的"。
 *
 * 后端:
 *   - GithubWebhookDelivery in types.ts (ring buffer 200 条)
 *   - state.ts.recordGithubWebhookDelivery / getGithubWebhookDeliveries
 *   - github-webhook.ts 路由用 res.on('finish') 在响应完毕后写一条
 *   - GET /api/cds-system/github/webhook-deliveries?limit=N 暴露列表
 *
 * 本 tab:
 *   - 30s 自动轮询 + 顶部「刷新」按钮
 *   - 每条列表行:相对时间 / repo / event chip / 短 SHA / actor / dispatch chip
 *   - 点击 entry 展开:deliveryId / 耗时 / signatureValid / dispatchReason /
 *     payload JSON 折叠
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorBlock, LoadingBlock, Section } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';

interface GithubWebhookDelivery {
  id: string;
  receivedAt: string;
  durationMs: number;
  deliveryId?: string;
  event: string;
  repoFullName?: string;
  ref?: string;
  commitSha?: string;
  commitMessage?: string;
  actor?: string;
  githubOwner?: string;
  githubWhitelistDecision?: 'allowed' | 'blocked' | 'not-evaluated';
  githubWhitelistCommentPosted?: boolean;
  signatureValid: boolean;
  dispatchAction: 'branch-created' | 'deploy' | 'skipped' | 'ignored' | 'error';
  dispatchReason?: string;
  branchId?: string;
  deployDispatched?: boolean;
  deployDispatchError?: string;
  deployDedupSkipped?: boolean;
  selfStatusBroadcast?: boolean;
  payloadSnippet?: string;
  error?: string;
}

interface ListResponse {
  deliveries: GithubWebhookDelivery[];
  total: number;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; deliveries: GithubWebhookDelivery[]; total: number };

interface Props {
  onToast: (message: string) => void;
}

const POLL_INTERVAL_MS = 30_000;
type WebhookLogFilter = 'blocked' | 'deploy' | 'workflow' | 'other' | 'all';

const filterTabs: Array<{ key: WebhookLogFilter; label: string; description: string }> = [
  { key: 'blocked', label: '白名单拦截', description: '已验签,但 GitHub owner 不在 CDS GitHub App 白名单' },
  { key: 'deploy', label: '推送代码', description: 'push / check_run 触发部署、创建分支、去重部署' },
  { key: 'workflow', label: 'Workflow / 构建', description: 'workflow_run / check_suite / check_run / status 等构建类事件' },
  { key: 'other', label: '其他有效', description: '非部署、非 workflow,但不是纯噪音的事件' },
  { key: 'all', label: '全部', description: '包含 GitHub 投递的噪音事件' },
];

function isDeployDelivery(d: GithubWebhookDelivery): boolean {
  return d.dispatchAction === 'deploy' ||
    d.dispatchAction === 'branch-created' ||
    d.deployDispatched === true ||
    d.deployDedupSkipped === true;
}

function isWorkflowDelivery(d: GithubWebhookDelivery): boolean {
  return d.event === 'workflow_run' ||
    d.event === 'workflow_job' ||
    d.event === 'check_suite' ||
    d.event === 'check_run' ||
    d.event === 'status';
}

function isOtherEffectiveDelivery(d: GithubWebhookDelivery): boolean {
  return !isDeployDelivery(d) && !isWorkflowDelivery(d) && d.dispatchAction !== 'ignored' && d.githubWhitelistDecision !== 'blocked';
}

function filterDelivery(d: GithubWebhookDelivery, filter: WebhookLogFilter): boolean {
  switch (filter) {
    case 'blocked': return d.githubWhitelistDecision === 'blocked';
    case 'deploy': return isDeployDelivery(d);
    case 'workflow': return isWorkflowDelivery(d);
    case 'other': return isOtherEffectiveDelivery(d);
    case 'all': return true;
  }
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso.slice(11, 19);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

function dispatchActionTone(action: GithubWebhookDelivery['dispatchAction']): string {
  switch (action) {
    case 'deploy':         return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'branch-created': return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'skipped':        return 'border-muted bg-muted/20 text-muted-foreground';
    case 'ignored':        return 'border-muted bg-muted/20 text-muted-foreground';
    case 'error':          return 'border-destructive/40 bg-destructive/10 text-destructive';
  }
}

function dispatchActionLabel(action: GithubWebhookDelivery['dispatchAction']): string {
  switch (action) {
    case 'deploy':         return '触发部署';
    case 'branch-created': return '新建分支';
    case 'skipped':        return '已跳过';
    case 'ignored':        return '不处理';
    case 'error':          return '错误';
  }
}

/** 鼠标悬浮 chip 时的友好解释,用户不再问"未订阅是什么"。 */
function dispatchActionTooltip(action: GithubWebhookDelivery['dispatchAction']): string {
  switch (action) {
    case 'deploy':         return 'CDS 已派发部署到目标分支(异步,具体耗时看 Activity Monitor 或部署历史)';
    case 'branch-created': return 'GitHub 通知有新分支被推,CDS 已注册分支条目(未必立即部署)';
    case 'skipped':        return '已订阅但本次没动作 — 比如同 commit 在 dedup 窗口内(2s)被去重,或 PR 状态不需要操作';
    case 'ignored':        return 'event 类型不在 CDS 关心列表 — 比如 workflow_run / status / check_suite。已 ack GitHub,无任何副作用';
    case 'error':          return '处理过程中抛错 — 见下方 dispatchReason 看具体原因(验签失败 / payload 无效 / dispatcher 异常)';
  }
}

export function GitHubWebhookLogTab({ onToast }: Props): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<WebhookLogFilter>('deploy');

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setState({ status: 'loading' });
    setRefreshing(true);
    try {
      const data = await apiRequest<ListResponse>('/api/cds-system/github/webhook-deliveries?limit=100', silent
        ? { headers: { 'X-CDS-Poll': 'true' } }
        : undefined);
      setState({ status: 'ok', deliveries: data.deliveries, total: data.total });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
      if (!silent) onToast(`加载失败：${message}`);
    } finally {
      setRefreshing(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load(false);
    const id = setInterval(() => { void load(true); }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const toggle = (key: string): void =>
    setExpanded((cur) => ({ ...cur, [key]: !cur[key] }));

  const visibleDeliveries = useMemo(() => (
    state.status === 'ok'
      ? state.deliveries.filter((item) => filterDelivery(item, filter))
      : []
  ), [filter, state]);

  const counts = useMemo(() => {
    const deliveries = state.status === 'ok' ? state.deliveries : [];
    return {
      blocked: deliveries.filter((item) => item.githubWhitelistDecision === 'blocked').length,
      deploy: deliveries.filter(isDeployDelivery).length,
      workflow: deliveries.filter(isWorkflowDelivery).length,
      other: deliveries.filter(isOtherEffectiveDelivery).length,
      all: deliveries.length,
    } satisfies Record<WebhookLogFilter, number>;
  }, [state]);

  return (
    <Section
      title="GitHub Webhook 日志"
      description="每次 GitHub 推送 webhook 命中 CDS 都会记录到这里(最多保留 200 条)。点击条目展开看完整详情:headers / payload / dispatch 决策。"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-md border border-border bg-[hsl(var(--surface-sunken))] p-1">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              title={tab.description}
              onClick={() => setFilter(tab.key)}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-3 text-xs transition-colors ${
                filter === tab.key
                  ? 'bg-[hsl(var(--surface-raised))] text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>{tab.label}</span>
              <span className="font-mono text-[11px] opacity-75">{counts[tab.key]}</span>
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load(false)}
          disabled={refreshing}
        >
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新
        </Button>
      </div>
      {state.status === 'loading' || state.status === 'idle' ? (
        <LoadingBlock />
      ) : state.status === 'error' ? (
        <ErrorBlock message={state.message} />
      ) : state.deliveries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          还没有 webhook 投递记录。GitHub 推送 / PR / check-run 命中 CDS 后会出现在这里。
        </div>
      ) : visibleDeliveries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
          当前筛选没有记录。切到「全部」可以查看 GitHub 投递的原始噪音事件。
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            共 {state.total} 条(显示最近 {state.deliveries.length}),当前筛选 {visibleDeliveries.length} 条,每 30 秒自动刷新。
          </div>
          <ul className="divide-y divide-[hsl(var(--hairline))] rounded-md border border-border">
            {visibleDeliveries.map((d) => {
              const open = !!expanded[d.id];
              return (
                <li key={d.id} className="px-4 py-3 text-sm">
                  <button
                    type="button"
                    onClick={() => toggle(d.id)}
                    className="flex w-full items-start gap-2 text-left hover:opacity-80"
                  >
                    {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatRelativeTime(d.receivedAt)}</span>
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {d.event}
                        </span>
                        {d.repoFullName ? (
                          <span className="text-xs text-foreground/80">{d.repoFullName}</span>
                        ) : null}
                        {d.ref ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {d.ref.replace(/^refs\/heads\//, '')}
                          </span>
                        ) : null}
                        {d.commitSha ? (
                          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">
                            {d.commitSha}
                          </span>
                        ) : null}
                        {d.actor ? <span className="text-xs text-muted-foreground">{d.actor}</span> : null}
                        {d.githubOwner ? (
                          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            owner {d.githubOwner}
                          </span>
                        ) : null}
                        <span
                          className={`rounded-md border px-1.5 py-0.5 text-[11px] ${dispatchActionTone(d.dispatchAction)}`}
                          title={dispatchActionTooltip(d.dispatchAction)}
                        >
                          {dispatchActionLabel(d.dispatchAction)}
                        </span>
                        {d.githubWhitelistDecision === 'blocked' ? (
                          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                            白名单拦截
                          </span>
                        ) : null}
                        {d.githubWhitelistCommentPosted ? (
                          <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300">
                            已回复评论区
                          </span>
                        ) : null}
                        {d.branchId ? (
                          <span
                            className="rounded border border-border bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
                            title="CDS 实际派发或匹配到的目标分支 ID"
                          >
                            目标 {d.branchId}
                          </span>
                        ) : null}
                        {d.deployDispatched ? (
                          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                            已派发
                          </span>
                        ) : null}
                        {d.deployDispatchError ? (
                          <span className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
                            派发失败
                          </span>
                        ) : null}
                        {d.deployDedupSkipped ? (
                          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                            去重跳过
                          </span>
                        ) : null}
                        {d.selfStatusBroadcast ? (
                          <span
                            className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300"
                            title="这只说明左下角 self-update 提示收到刷新,不等同于部署成功"
                          >
                            左下角已通知
                          </span>
                        ) : null}
                        {!d.signatureValid ? (
                          <span className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
                            验签失败
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs text-muted-foreground">{d.durationMs}ms</span>
                      </div>
                      {d.commitMessage ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {d.commitMessage}
                        </div>
                      ) : null}
                      {d.dispatchReason ? (
                        <div className="mt-0.5 text-xs text-foreground/70">
                          {d.dispatchReason}
                        </div>
                      ) : null}
                      {d.deployDispatchError ? (
                        <div className="mt-1 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                          部署未启动：{d.deployDispatchError}
                        </div>
                      ) : null}
                    </div>
                  </button>
                  {open ? (
                    <div className="mt-3 space-y-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-xs">
                      <KV label="GitHub Delivery ID" value={d.deliveryId || '(none)'} mono />
                      <KV label="内部 ID" value={d.id} mono />
                      <KV label="收到时间" value={d.receivedAt} mono />
                      <KV label="耗时" value={`${d.durationMs}ms`} mono />
                      <KV label="HMAC 验签" value={d.signatureValid ? '通过' : '失败'} />
                      {d.githubOwner ? <KV label="GitHub owner" value={d.githubOwner} mono /> : null}
                      {d.githubWhitelistDecision ? <KV label="白名单判定" value={d.githubWhitelistDecision} mono /> : null}
                      <KV label="白名单拦截评论" value={d.githubWhitelistCommentPosted ? '已回复' : '否或无需回复'} />
                      <KV label="dispatchAction" value={d.dispatchAction} mono />
                      {d.branchId ? <KV label="目标 CDS 分支" value={d.branchId} mono /> : null}
                      <KV label="部署派发" value={d.deployDispatched ? '是' : '否或旧日志未记录'} />
                      {d.deployDispatchError ? <KV label="部署派发失败" value={d.deployDispatchError} /> : null}
                      <KV label="部署去重" value={d.deployDedupSkipped ? '是' : '否'} />
                      <KV label="左下角通知" value={d.selfStatusBroadcast ? '是' : '否或旧日志未记录'} />
                      {d.dispatchReason ? <KV label="dispatchReason" value={d.dispatchReason} /> : null}
                      {d.error ? <KV label="error" value={d.error} /> : null}
                      {d.payloadSnippet ? (
                        <div>
                          <div className="mb-1 text-[11px] font-medium text-muted-foreground">payload (截断 4KB)</div>
                          <pre
                            className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--bg-card))] p-2 font-mono text-[11px] leading-5"
                            style={{ overscrollBehavior: 'contain' }}
                          >
                            {d.payloadSnippet}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-3">
      <span className="text-muted-foreground">{label}:</span>
      <span className={mono ? 'font-mono break-all' : 'break-all'}>{value}</span>
    </div>
  );
}
