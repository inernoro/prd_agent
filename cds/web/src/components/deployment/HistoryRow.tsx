import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Clock, FileText, GitCommitHorizontal, Layers, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BranchDeploymentItem } from '@/components/BranchDetailDrawer';
import {
  computeDeployDurationDisplay,
  deployModeLabel,
  formatDurationMs,
  triggerSourceLabel,
} from '@/lib/deploymentMeta';

/*
 * HistoryRow — 折叠的历史部署行。
 *
 * 单行布局：dot · 中文 kind · short sha · duration · 相对时间 · 展开/日志按钮
 * 点击整行（或左侧 chevron）展开/收起：展开后先列「触发器 / 部署类型 / 版本 /
 * 开始时间 / 耗时」元数据，再渲染该次部署结束时保存的容器日志快照。
 *
 * 卡死耗时封顶：仍在进行中且已超阈值（默认 60 分钟）的部署不再显示一个越来越
 * 离谱的真实数字（如 772m），而是封顶到阈值并打「疑似卡住」徽章。
 *
 * surface-sunken + hairline 让历史比 ActiveDeployment 视觉权重更弱。
 */

export interface HistoryRowProps {
  deployment: BranchDeploymentItem;
  onOpenLogs: (deployment: BranchDeploymentItem) => void;
  defaultExpanded?: boolean;
}

function dotClass(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return 'bg-sky-500';
  if (status === 'success') return 'bg-emerald-500';
  return 'bg-destructive';
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

function formatRuntime(deployment: BranchDeploymentItem): string {
  if (!deployment.runtimeStartedAt) return '运行 未就绪';
  const end = deployment.runtimeEndedAt || Date.now();
  const seconds = Math.max(0, Math.floor((end - deployment.runtimeStartedAt) / 1000));
  if (seconds < 60) return `运行 ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `运行 ${restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `运行 ${restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`}`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `运行 ${restHours ? `${days}d ${restHours}h` : `${days}d`}`;
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 元数据小标签（icon + 文案），展开后逐项排列。 */
function MetaChip({ icon, label, value, mono }: { icon: JSX.Element; label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="shrink-0 text-muted-foreground/70">{icon}</span>
      <span className="shrink-0">{label}</span>
      <span className={`text-foreground/85 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export function HistoryRow({ deployment, onOpenLogs, defaultExpanded = false }: HistoryRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const snapshots = deployment.containerLogSnapshots || [];
  const primarySnapshot = snapshots.find((item) => item.logs?.trim()) || snapshots[0];

  // 卡死耗时封顶：进行中且超阈值显示「疑似卡住」而非不断增长的数字。
  const duration = computeDeployDurationDisplay(deployment.startedAt, deployment.finishedAt, Date.now());
  const deployModeText = deployModeLabel(deployment.deployMode);
  const triggerText = triggerSourceLabel(deployment.triggerSource);
  const startedAtAbs = new Date(deployment.startedAt).toLocaleString();

  return (
    <div className="cds-surface-sunken cds-hairline overflow-hidden rounded-md">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-muted/20"
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <span
          aria-hidden
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(deployment.status)}`} />
        <span className="shrink-0 font-medium">{deploymentKindLabel(deployment.kind)}</span>
        {triggerText ? (
          <span className="shrink-0 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {triggerText}
          </span>
        ) : null}
        {deployment.commitSha ? (
          <span className="shrink-0 font-mono text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span>
        ) : null}
        {duration.stuck ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            疑似卡住 ≥{formatDurationMs(duration.cappedMs)}
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground">部署 {formatDurationMs(duration.cappedMs)}</span>
        )}
        <span className="shrink-0 text-muted-foreground">{formatRuntime(deployment)}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{formatRelative(deployment.startedAt)}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onOpenLogs(deployment);
          }}
        >
          <FileText />
          日志
        </Button>
      </div>
      {expanded ? (
        <div className="border-t border-[hsl(var(--hairline))] px-3 py-3">
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {triggerText ? (
              <MetaChip icon={<Zap className="h-3.5 w-3.5" />} label="触发器" value={triggerText} />
            ) : null}
            <MetaChip icon={<Layers className="h-3.5 w-3.5" />} label="部署类型" value={deployModeText} />
            <MetaChip
              icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
              label="版本"
              value={deployment.commitSha ? `${deployment.commitSha.slice(0, 7)} · ${deployment.commitSha}` : '未记录'}
              mono
            />
            <MetaChip icon={<Clock className="h-3.5 w-3.5" />} label="开始于" value={startedAtAbs} />
            <MetaChip
              icon={<Clock className="h-3.5 w-3.5" />}
              label="部署耗时"
              value={duration.stuck ? `疑似卡住（已超过 ${formatDurationMs(duration.cappedMs)} 未就绪）` : formatDurationMs(duration.cappedMs)}
            />
          </div>
          {deployment.message ? (
            <div className="mb-2 truncate text-xs text-muted-foreground">{deployment.message}</div>
          ) : null}
          {primarySnapshot ? (
            <section className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50">
              <header className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2 text-xs">
                <span className="font-semibold">容器日志快照</span>
                <span className="font-mono text-muted-foreground">{primarySnapshot.profileId}</span>
                {primarySnapshot.hostPort ? (
                  <span className="font-mono text-muted-foreground">:{primarySnapshot.hostPort}</span>
                ) : null}
                <span className="ml-auto text-muted-foreground">
                  保存于 {formatRelative(new Date(primarySnapshot.capturedAt).getTime())}
                </span>
              </header>
              {primarySnapshot.logs?.trim() ? (
                <pre className="max-h-[360px] overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85 whitespace-pre-wrap break-words">
                  {primarySnapshot.logs}
                </pre>
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {primarySnapshot.message || '本次部署没有捕获到容器输出。'}
                </div>
              )}
            </section>
          ) : (
            <div className="rounded border border-dashed border-[hsl(var(--hairline))] px-3 py-3 text-xs text-muted-foreground">
              旧记录没有保存容器日志快照；新部署会在结束时自动留存 docker logs tail。
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
