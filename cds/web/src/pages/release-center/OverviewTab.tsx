/**
 * 概览页：密度要足。三格摘要（线上跑哪一版 / 健不健康 / 近 30 天）+ 提升条 +
 * 带提交说明的发布时间线（失败行可就地展开诊断）。
 *
 * 这三格正对着用户真正关心的三个问题：线上跑哪一版、健不健康、坏了退哪。
 * 「坏了退哪」由时间线上每一行的「回滚到此版本」承载，不需要另开一屏。
 */

import { ArrowUpRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describeCommitPosition, formatAgo } from '@/lib/releaseRail';
import { formatDoraDuration } from '@/lib/releaseDora';
import { releaseEtaText } from '@/lib/releaseEta';
import { ReleaseTimeline } from './ReleaseTimeline';
import {
  Chip,
  CodeText,
  SectionLabel,
  formatAvailability,
  formatDateTime,
  formatResponseTime,
  healthLabel,
  healthTone,
} from './shared';
import type { CenterRow, ReleaseCommitMeta, ReleaseRun } from './types';
import { isReleaseTerminal } from './types';

export interface OverviewTabProps {
  row: CenterRow;
  runs: ReleaseRun[];
  commitMeta: Record<string, ReleaseCommitMeta>;
  branch: string;
  nowMs: number;
  retryingRunId: string;
  promoting: boolean;
  onPromote: () => void;
  onOpenLogs: (run: ReleaseRun) => void;
  onRetry: (run: ReleaseRun) => void;
  onRollback: (run: ReleaseRun) => void;
  onSeeAll: () => void;
  onOpenConfig: () => void;
}

const RECENT_RUNS = 5;

export function OverviewTab({
  row,
  runs,
  commitMeta,
  branch,
  nowMs,
  retryingRunId,
  promoting,
  onPromote,
  onOpenLogs,
  onRetry,
  onRollback,
  onSeeAll,
  onOpenConfig,
}: OverviewTabProps): JSX.Element {
  const currentMeta = commitMeta[row.currentCommit];
  const position = describeCommitPosition(row.commitPosition, branch);
  const inFlight = Boolean(row.latestRun && !isReleaseTerminal(row.latestRun.status));
  const etaText = inFlight ? releaseEtaText(row.latestRun?.startedAt, row.releaseEstimate, nowMs) : '';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {row.promotion ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warn-soft px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-warn">
              {row.promotion.fromTargetName} 上跑着更新的一版
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              <CodeText>{row.promotion.commitSha.slice(0, 7)}</CodeText>
              {row.promotion.fromReleasedAt ? `（${formatAgo(row.promotion.fromReleasedAt, nowMs)}` : '（'}
              {row.promotion.fromHealthStatus === 'healthy' ? '，健康' : ''}
              {'）'}
              {typeof row.promotion.aheadCount === 'number'
                ? ` 比这里新 ${row.promotion.aheadCount} 个提交，可以原样发过来`
                : ' 可以原样发过来（这里还没有发布过版本，无从比较提交数）'}
            </div>
            {/* 已知发不出去时先说清楚，别等用户点了才吃一句「已拒绝发布」。 */}
            {row.promotion.executable === false && row.promotion.blockedReason ? (
              <div className="mt-1 text-xs text-warn">
                {row.promotion.blockedReason}
              </div>
            ) : null}
          </div>
          <Button
            onClick={onPromote}
            disabled={promoting || row.promotion.executable === false}
            title={row.promotion.executable === false ? row.promotion.blockedReason : undefined}
          >
            {promoting ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
            把 {row.promotion.fromTargetName} 这一版发到{row.target.name}
          </Button>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="线上版本">
          <div className="font-mono text-lg font-semibold tabular-nums">
            {row.currentCommit ? row.currentCommit.slice(0, 7) : '未发布'}
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {currentMeta?.subject || (row.currentCommit ? '台账里没有这个提交的说明' : '这个环境还没有成功发布过')}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {row.currentVersion ? `${row.currentVersion} · ` : ''}
            {formatDateTime(row.lastReleasedAt)}
            {row.lastOperator ? ` · ${row.lastOperator}` : ''}
          </p>
          <p className={`text-[12px] ${position.tone === 'warn' ? 'text-warn' : 'text-muted-foreground'}`}>
            {position.text}
          </p>
        </StatCard>

        <StatCard label="健康">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">{formatResponseTime(row.health?.responseTimeMs)}</span>
            <Chip tone={healthTone(row.healthStatus)}>{healthLabel(row.healthStatus)}</Chip>
          </div>
          <p className="break-all text-[12.5px] text-muted-foreground">
            {row.health?.url || '未配置健康检查地址'}
          </p>
          <p className="text-[12px] text-muted-foreground">
            最近检查 {formatAgo(row.health?.checkedAt, nowMs) || '-'}
            {row.health?.checkedAt ? '' : '（未监测）'}
          </p>
          <p className="text-[12px] text-muted-foreground">
            近 24 小时可用率 {formatAvailability(row.health?.availability24h)}
            {typeof row.health?.sampleCount24h === 'number' && row.health.sampleCount24h > 0
              ? `（${row.health.upCount24h ?? 0}/${row.health.sampleCount24h} 次探测通过）`
              : ''}
          </p>
        </StatCard>

        <StatCard label={`近 ${row.dora?.windowDays ?? 30} 天`}>
          {row.dora ? (
            <>
              <div className="text-lg font-semibold">
                {row.dora.changeFailure.total} 次 · 失败 {row.dora.changeFailure.failed}
              </div>
              <p className="text-[12.5px] text-muted-foreground">
                变更失败率{' '}
                {row.dora.changeFailure.ratio === null
                  ? '样本不足'
                  : `${Math.round(row.dora.changeFailure.ratio * 100)}%`}
                {' · '}
                恢复中位 {row.dora.recovery.p50Ms === null ? '样本不足' : formatDoraDuration(row.dora.recovery.p50Ms)}
              </p>
              <p className="text-[12px] text-muted-foreground">
                成功 {row.dora.frequency.successCount} 次 · 前置时间中位{' '}
                {row.dora.leadTime.p50Ms === null ? '样本不足' : formatDoraDuration(row.dora.leadTime.p50Ms)}
              </p>
              {row.dora.recovery.ongoingCount > 0 ? (
                <p className="text-[12px] text-warn">
                  有 {row.dora.recovery.ongoingCount} 次失败尚未恢复
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="text-lg font-medium text-muted-foreground">样本不足</div>
              <p className="text-[12.5px] text-muted-foreground">
                这个 CDS 还没有下发本目标的发布统计，或统计窗口内一次发布都没有。
              </p>
            </>
          )}
        </StatCard>
      </section>

      {etaText ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/8 px-3 py-2 text-sm text-primary">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span className="min-w-0">{etaText}</span>
        </div>
      ) : null}

      <ReleaseTimeline
        title="最近发布"
        runs={runs.slice(0, RECENT_RUNS)}
        row={row}
        commitMeta={commitMeta}
        nowMs={nowMs}
        liveReleaseId={row.currentVersion}
        retryingRunId={retryingRunId}
        onOpenLogs={onOpenLogs}
        onRetry={onRetry}
        onRollback={onRollback}
        onSeeAll={onSeeAll}
        seeAllLabel={`查看全部 ${runs.length} 次`}
      />

      <section className="cds-surface-raised cds-hairline rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">发布方式</h3>
          <button type="button" onClick={onOpenConfig} className="text-xs text-primary hover:underline">
            去配置页看完整脚本
          </button>
        </div>
        <p className="mt-2 break-words text-[12.5px] text-muted-foreground">
          {releaseMethodSummary(row)}
        </p>
      </section>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <article className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </article>
  );
}

/**
 * 一句话说清「这个目标会怎么发」。脚本原文不在这里展开——它在配置页签，
 * 首屏放整段 shell 是旧版最招人烦的一处（用户不是来读脚本的）。
 */
export function releaseMethodSummary(row: CenterRow): string {
  const strategy = row.target.strategy;
  const health = row.target.ssh?.healthcheckUrl ? ` · 健康检查 ${row.target.ssh.healthcheckUrl}` : '';
  if (strategy?.mode === 'generated-compose') {
    return `CDS 动态 Compose 发布 · ${strategy.composeFile || 'compose.yml'} · 保留上一版本可回滚${health}`;
  }
  if (strategy?.mode === 'generated-static') {
    return `CDS 动态静态站发布 · 原子切换 ${strategy.publicDirectory || '-'}/current · 保留 previous${health}`;
  }
  const command = strategy?.command || row.target.ssh?.deployCommand || '';
  const rollback = row.target.ssh?.rollbackCommand?.trim();
  const head = command ? `项目现有脚本 · ${command.split(/&&|;/)[0].trim()}` : '项目现有脚本 · 未配置发布命令';
  return `${head} · 回滚${rollback ? `执行 ${rollback}` : '重新发布历史成功版本'}${health}`;
}
