import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PhaseTree } from './PhaseTree';
import { deriveBranchPhases } from '@/lib/deploymentPhases';
import type { BranchDeploymentItem } from '@/components/BranchDetailDrawer';

/*
 * HistoryRow — 折叠的历史部署行。
 *
 * 单行布局：dot · 中文 kind · short sha · duration · 相对时间 · 展开/日志按钮
 * 展开后渲染同款 PhaseTree（让历史失败也能一眼看到红行在哪个阶段）。
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

function formatDuration(deployment: BranchDeploymentItem): string {
  const finished = deployment.finishedAt || deployment.startedAt;
  const ms = Math.max(0, finished - deployment.startedAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function HistoryRow({ deployment, onOpenLogs, defaultExpanded = false }: HistoryRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const phases = expanded
    ? deriveBranchPhases(deployment.log, deployment.status, deployment.message)
    : [];

  return (
    <div className="cds-surface-sunken cds-hairline overflow-hidden rounded-md">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <button
          type="button"
          aria-label={expanded ? '收起' : '展开'}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(deployment.status)}`} />
        <span className="shrink-0 font-medium">{deploymentKindLabel(deployment.kind)}</span>
        {deployment.commitSha ? (
          <span className="shrink-0 font-mono text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span>
        ) : null}
        <span className="shrink-0 text-muted-foreground">{formatDuration(deployment)}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{formatRelative(deployment.startedAt)}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => onOpenLogs(deployment)}
        >
          <FileText />
          日志
        </Button>
      </div>
      {expanded ? (
        <div className="border-t border-[hsl(var(--hairline))] px-3 py-3">
          {deployment.message ? (
            <div className="mb-2 truncate text-xs text-muted-foreground">{deployment.message}</div>
          ) : null}
          <PhaseTree phases={phases} />
        </div>
      ) : null}
    </div>
  );
}
