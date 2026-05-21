import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Clock, Copy, ExternalLink, Loader2, Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PhaseKey } from '@/lib/deploymentPhases';
import { normalizeContainerLogsForDisplay } from '@/lib/containerLogs';
import type { BranchDeploymentItem } from '@/components/BranchDetailDrawer';
import { type PhaseLogState, type InlineContainerLogControls } from './PhaseTree';

function lastLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return lines.slice(-n).join('\n');
}

function logLineClass(line: string): string {
  if (/\b(error|failed|fatal|exception|panic|denied)\b|错误|失败|异常|拒绝/i.test(line)) {
    return 'text-red-300';
  }
  if (/\b(warn|warning|deprecated)\b|警告/i.test(line)) {
    return 'text-amber-300';
  }
  if (/\b(success|succeeded|done|ready|listening|started|completed)\b|成功|完成|就绪|启动/i.test(line)) {
    return 'text-emerald-300';
  }
  if (/https?:\/\/|file:\/\/|\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/.test(line)) {
    return 'text-sky-300';
  }
  if (/^\s*(at |\+|>|npm |pnpm |yarn |dotnet |node )/.test(line)) {
    return 'text-slate-300';
  }
  return 'text-slate-400';
}

function HighlightedLogBlock({
  logs,
  maxLines,
  className = '',
  autoScrollToBottom = false,
}: {
  logs: string;
  maxLines?: number;
  className?: string;
  autoScrollToBottom?: boolean;
}): JSX.Element {
  const displayLogs = normalizeContainerLogsForDisplay(logs);
  const text = maxLines ? lastLines(displayLogs, maxLines) : displayLogs;
  const lines = text.split(/\r?\n/);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = () => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    if (autoScrollToBottom) scrollToBottom();
  }, [autoScrollToBottom, text]);
  return (
    <div className="relative h-full min-h-0">
      <button
        type="button"
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-black/80 px-2 py-1 text-[11px] text-slate-200 shadow hover:border-[hsl(var(--hairline-strong))]"
        onClick={scrollToBottom}
        title="跳到容器日志底部"
      >
        <ArrowDownToLine className="h-3 w-3" />
        底部
      </button>
      <div ref={viewportRef} className={`h-full overflow-auto rounded border border-[hsl(var(--hairline))] bg-black/80 p-3 pr-20 font-mono text-[11px] leading-5 ${className}`}>
        {lines.map((line, index) => (
          <div key={`${index}-${line.slice(0, 24)}`} className={`whitespace-pre-wrap break-words ${logLineClass(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 部署 tab 当前区域只展示容器运行日志。
 * 阶段树已经从主视图移除，避免右侧检查列表挤占用户真正需要看的日志。
 */
function PrimaryContainerLogPanel({
  containerLogsByPhase,
  containerLogControls,
}: {
  containerLogsByPhase?: Partial<Record<PhaseKey, PhaseLogState>>;
  containerLogControls?: InlineContainerLogControls;
}): JSX.Element {
  // 把 by-phase map 折成一个 state：优先 deploy → verify → 第一个 key。
  const state: PhaseLogState | null = useMemo(() => {
    if (!containerLogsByPhase) return null;
    return (
      containerLogsByPhase.deploy
      || containerLogsByPhase.verify
      || (Object.values(containerLogsByPhase)[0] as PhaseLogState | undefined)
      || null
    );
  }, [containerLogsByPhase]);
  const hasTabs = !!(containerLogControls && containerLogControls.services.length > 1);
  const [maximized, setMaximized] = useState(false);
  const logs = state?.status === 'ok' ? (state.logs || '') : '';
  /*
   * Inline logs are a preview, not the full terminal. Keep roughly 20 readable
   * rows so the deployment history below remains visible; the modal keeps the
   * complete scrollable log.
   */
  const logViewportClass = 'h-[424px]';
  const emptyLogStateClass = `${logViewportClass} flex items-center justify-center`;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">容器日志</div>
        {containerLogControls?.onMaximize ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 py-0.5 text-[11px] hover:border-[hsl(var(--hairline-strong))]"
            onClick={() => setMaximized(true)}
            title="在弹窗中查看完整容器日志"
          >
            <Maximize2 className="h-3 w-3" />
            最大化
          </button>
        ) : null}
      </header>
      {hasTabs ? (
        <div className="flex flex-wrap gap-1.5 border-b border-[hsl(var(--hairline))] px-3 py-2">
          {containerLogControls!.services.map((svc) => {
            const active = svc.profileId === containerLogControls!.selected;
            const dot = svc.status === 'running'
              ? 'bg-emerald-500'
              : svc.status === 'error'
                ? 'bg-destructive'
                : 'bg-muted-foreground/40';
            return (
              <button
                key={svc.profileId}
                type="button"
                onClick={() => containerLogControls!.onSelect(svc.profileId)}
                className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                <span className="font-mono">{svc.profileId}</span>
                {svc.hostPort ? <span className="font-mono opacity-70">:{svc.hostPort}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {!state ? (
          <div className={`${emptyLogStateClass} rounded border border-dashed border-[hsl(var(--hairline))] px-3 text-center text-xs text-muted-foreground`}>
            还没有容器日志。容器进入 running 后这里会显示 docker logs 的最后若干行。
          </div>
        ) : state.status === 'loading' ? (
          <div className={`${emptyLogStateClass} gap-2 rounded border border-[hsl(var(--hairline))] px-3 text-xs text-muted-foreground`}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载容器日志…
          </div>
        ) : state.status === 'error' ? (
          <div className={`${emptyLogStateClass} rounded border border-destructive/30 bg-destructive/10 px-3 text-center text-xs text-destructive`}>
            {state.message || '容器日志加载失败'}
          </div>
        ) : !state.logs || !state.logs.trim() ? (
          <div className={`${emptyLogStateClass} rounded border border-[hsl(var(--hairline))] px-3 text-center text-xs text-muted-foreground`}>
            容器尚未输出任何日志（多半是进程在监听端口前就退出了）。
          </div>
        ) : (
          <HighlightedLogBlock logs={state.logs} maxLines={220} className={logViewportClass} autoScrollToBottom />
        )}
      </div>
      {maximized ? (
        <div
          className="fixed inset-0 z-[80] flex items-stretch justify-stretch bg-black/70 p-3"
          role="dialog"
          aria-modal="true"
          aria-label="完整容器日志"
          onClick={() => setMaximized(false)}
        >
          <div
            className="flex h-full w-full flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-base))] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">完整容器日志</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {containerLogControls?.selected || '当前服务'} · error/warn/success/path 已按终端风格标色
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(logs)}
                  disabled={!logs}
                >
                  <Copy />
                  复制
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={() => setMaximized(false)} aria-label="关闭日志弹窗">
                  <X />
                </Button>
              </div>
            </header>
            {hasTabs ? (
              <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-[hsl(var(--hairline))] px-4 py-2">
                {containerLogControls!.services.map((svc) => {
                  const active = svc.profileId === containerLogControls!.selected;
                  const dot = svc.status === 'running'
                    ? 'bg-emerald-500'
                    : svc.status === 'error'
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/40';
                  return (
                    <button
                      key={svc.profileId}
                      type="button"
                      onClick={() => containerLogControls!.onSelect(svc.profileId)}
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${
                        active
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                      <span className="font-mono">{svc.profileId}</span>
                      {svc.hostPort ? <span className="font-mono opacity-70">:{svc.hostPort}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 p-4">
              {state?.status === 'loading' ? (
                <div className="flex items-center gap-2 rounded border border-[hsl(var(--hairline))] px-3 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在加载容器日志…
                </div>
              ) : state?.status === 'error' ? (
                <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {state.message || '容器日志加载失败'}
                </div>
              ) : logs.trim() ? (
                <HighlightedLogBlock logs={logs} className="h-full text-[12px] leading-6" autoScrollToBottom />
              ) : (
                <div className="rounded border border-[hsl(var(--hairline))] px-3 py-6 text-center text-sm text-muted-foreground">
                  暂无容器日志。
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/*
 * ActiveDeployment — 部署 tab 顶部那张「当前部署」大卡。
 *
 * 视觉对齐 Railway / Vercel：
 *  - 顶部 status 大徽章 + commit + 中文 kind + duration
 *  - 中间只显示容器运行日志，阶段检查与调试字段收进完整日志/诊断入口。
 *  - 底部固定一行通用动作：查看日志 / 复制排错摘要
 */

export interface ActiveDeploymentProps {
  deployment: BranchDeploymentItem;
  branchErrorMessage?: string;
  now: number;
  onOpenLogs: (deployment: BranchDeploymentItem) => void;
  onCopyDiagnosis: (deployment: BranchDeploymentItem) => void;
  containerLogsByPhase?: Partial<Record<PhaseKey, PhaseLogState>>;
  /**
   * 多容器 tab 切换 + 最大化控制。
   */
  containerLogControls?: InlineContainerLogControls;
}

function statusBadgeClass(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  if (status === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function statusBadgeLabel(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'success') return '已完成';
  return '失败';
}

function effectiveDeploymentStatus(
  deployment: BranchDeploymentItem,
  branchErrorMessage?: string,
): BranchDeploymentItem['status'] {
  /*
   * A deployment action can be recorded as success while the branch is now in
   * error state after health/runtime checks. In the drawer this looked like
   * "异常" in the header and "已完成" in the deployment card, which is a
   * misleading lifecycle signal. Prefer the current branch error for display.
   */
  if (deployment.status === 'success' && branchErrorMessage) return 'error';
  return deployment.status;
}

function deploymentKindLabel(kind: BranchDeploymentItem['kind']): string {
  return ({
    preview: '预览部署',
    deploy: '部署',
    pull: '拉取',
    stop: '停止',
    create: '创建分支',
    favorite: '收藏',
    reset: '重置',
    delete: '删除',
  } as Record<BranchDeploymentItem['kind'], string>)[kind];
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatRuntimeDuration(deployment: BranchDeploymentItem, now: number): string {
  if (!deployment.runtimeStartedAt) {
    return deployment.status === 'running' ? '未就绪' : '未记录';
  }
  const end = deployment.runtimeEndedAt || now;
  return formatDuration(end - deployment.runtimeStartedAt);
}

export function ActiveDeployment({
  deployment,
  branchErrorMessage,
  now,
  onOpenLogs,
  onCopyDiagnosis,
  containerLogsByPhase,
  containerLogControls,
}: ActiveDeploymentProps): JSX.Element {
  const displayStatus = effectiveDeploymentStatus(deployment, branchErrorMessage);

  const deployDuration = formatDuration((deployment.finishedAt || now) - deployment.startedAt);
  const runtimeDuration = formatRuntimeDuration(deployment, now);
  const isError = displayStatus === 'error';

  return (
    <section
      className={`overflow-hidden rounded-md border bg-[hsl(var(--surface-raised))] ${
        isError ? 'border-destructive/35' : 'cds-hairline'
      }`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-4">
        <span className={`rounded border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${statusBadgeClass(displayStatus)}`}>
          {deployment.status === 'success' && displayStatus === 'error' ? '运行异常' : statusBadgeLabel(displayStatus)}
        </span>
        <span className="text-sm font-semibold">{deploymentKindLabel(deployment.kind)}</span>
        {deployment.commitSha ? (
          <span className="font-mono text-xs text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-xs font-semibold ${
              displayStatus === 'running'
                ? 'border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-300'
                : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground'
            }`}
            title="从开始部署到部署动作完成的耗时；运行中时显示当前已用时间"
          >
            <Clock className="h-3.5 w-3.5" />
            部署耗时 {deployDuration}
          </span>
          <span
            className="inline-flex items-center gap-1.5 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 py-1 font-mono text-xs font-semibold text-muted-foreground"
            title="从容器通过启动/就绪判断后开始计算；没有就绪事件时显示未就绪或未记录"
          >
            <Clock className="h-3.5 w-3.5" />
            运行时间 {runtimeDuration}
          </span>
        </div>
      </header>

      <div className="px-5 py-4">
        <PrimaryContainerLogPanel
          containerLogsByPhase={containerLogsByPhase}
          containerLogControls={containerLogControls}
        />
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-5 py-3">
        <div className="min-w-0 truncate text-xs text-muted-foreground">
          {branchErrorMessage || deployment.message || '部署进行中…'}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onCopyDiagnosis(deployment)}>
            <Copy />
            复制排错摘要
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
            <ExternalLink />
            查看完整日志
          </Button>
        </div>
      </footer>
    </section>
  );
}
