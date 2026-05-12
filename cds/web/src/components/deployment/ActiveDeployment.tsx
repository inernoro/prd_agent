import { useMemo } from 'react';
import { Clock, Copy, ExternalLink, FileText, RotateCcw, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { deriveBranchPhases, type PhaseKey } from '@/lib/deploymentPhases';
import type { BranchDeploymentItem } from '@/components/BranchDetailDrawer';
import { PhaseTree, type PhaseLogState } from './PhaseTree';

/*
 * ActiveDeployment — 部署 tab 顶部那张「当前部署」大卡。
 *
 * 视觉对齐 Railway / Vercel：
 *  - 顶部 status 大徽章 + commit + 中文 kind + duration
 *  - 中间 PhaseTree 4 阶段（最少高度 ~150px，避免 running → success 抖动）
 *  - 失败阶段下方挂诊断 CTA：
 *      · build + 缺 BuildProfile     → 主按钮「修复构建配置」
 *      · build 通用                   → ghost 「查看完整日志」
 *      · deploy                       → ghost 「重置异常」
 *      · verify                       → ghost 「重新诊断」
 *  - 底部固定一行通用动作：查看日志 / 复制排错摘要
 */

export interface ActiveDeploymentProps {
  deployment: BranchDeploymentItem;
  projectId: string;
  branchErrorMessage?: string;
  now: number;
  onOpenLogs: (deployment: BranchDeploymentItem) => void;
  onCopyDiagnosis: (deployment: BranchDeploymentItem) => void;
  onRetryDiagnosis?: (deployment: BranchDeploymentItem) => void;
  onResetError?: (deployment: BranchDeploymentItem) => void;
  /**
   * 失败阶段下方内联展示的容器日志。Drawer 在 deploy / verify 阶段失败时
   * 自动 fetch 容器日志并通过该 prop 透传，PhaseTree 渲染在错误提示下方。
   * build 阶段不走这条路径——构建失败的日志在另一个 build-log 面板。
   */
  containerLogsByPhase?: Partial<Record<PhaseKey, PhaseLogState>>;
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

function looksLikeMissingBuildProfile(message: string): boolean {
  const text = (message || '').toLowerCase();
  return text.includes('buildprofile')
    || text.includes('build profile')
    || text.includes('build_profile')
    || message.includes('尚未配置构建配置')
    || message.includes('未找到 BuildProfile')
    || message.includes('未找到构建配置');
}

export function ActiveDeployment({
  deployment,
  projectId,
  branchErrorMessage,
  now,
  onOpenLogs,
  onCopyDiagnosis,
  onRetryDiagnosis,
  onResetError,
  containerLogsByPhase,
}: ActiveDeploymentProps): JSX.Element {
  const displayStatus = effectiveDeploymentStatus(deployment, branchErrorMessage);
  const phases = useMemo(
    () => deriveBranchPhases(deployment.log, displayStatus, branchErrorMessage || deployment.message),
    [branchErrorMessage, deployment.log, deployment.message, displayStatus],
  );

  const duration = formatDuration((deployment.finishedAt || now) - deployment.startedAt);
  const isError = displayStatus === 'error';
  const errorPhaseKey = phases.find((phase) => phase.status === 'error')?.key;

  function renderActionForError(key: PhaseKey): JSX.Element | null {
    if (!isError || key !== errorPhaseKey) return null;

    const message = branchErrorMessage || deployment.message || '';
    const settingsHref = `/settings/${encodeURIComponent(projectId)}`;

    if (key === 'build' && looksLikeMissingBuildProfile(message)) {
      return (
        <>
          <Button asChild size="sm">
            <a href={settingsHref}>
              <Wrench />
              修复构建配置
            </a>
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
            <FileText />
            查看完整日志
          </Button>
        </>
      );
    }

    if (key === 'build') {
      return (
        <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
          <FileText />
          查看完整日志
        </Button>
      );
    }

    if (key === 'deploy') {
      return (
        <>
          {onResetError ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onResetError(deployment)}>
              <RotateCcw />
              重置异常
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
            <FileText />
            查看完整日志
          </Button>
        </>
      );
    }

    if (key === 'verify') {
      return (
        <>
          {onRetryDiagnosis ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onRetryDiagnosis(deployment)}>
              <RotateCcw />
              重新诊断
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
            <FileText />
            查看完整日志
          </Button>
        </>
      );
    }

    return (
      <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(deployment)}>
        <FileText />
        查看完整日志
      </Button>
    );
  }

  return (
    <section
      className={`cds-shape-panel overflow-hidden rounded-md border ${
        isError ? 'border-destructive/35' : 'cds-hairline'
      }`}
    >
      <ShapeGrid
        className="cds-shape-backdrop"
        speed={displayStatus === 'running' ? 0.16 : 0.08}
        squareSize={36}
        borderColor={isError ? 'hsl(var(--destructive) / 0.15)' : 'hsl(var(--foreground) / 0.07)'}
        hoverFillColor={isError ? 'hsl(var(--destructive) / 0.08)' : 'hsl(var(--foreground) / 0.045)'}
        hoverTrailAmount={0}
      />
      <header className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-4">
        <span className={`rounded border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${statusBadgeClass(displayStatus)}`}>
          {deployment.status === 'success' && displayStatus === 'error' ? '运行异常' : statusBadgeLabel(displayStatus)}
        </span>
        <span className="text-sm font-semibold">{deploymentKindLabel(deployment.kind)}</span>
        {deployment.commitSha ? (
          <span className="font-mono text-xs text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          {duration}
        </span>
      </header>

      <div className="px-5 py-4" style={{ minHeight: 168 }}>
        <PhaseTree
          phases={phases}
          onActionForError={renderActionForError}
          containerLogsByPhase={containerLogsByPhase}
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
