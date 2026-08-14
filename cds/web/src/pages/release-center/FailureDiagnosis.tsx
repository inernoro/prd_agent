/**
 * 失败诊断：把结论摆到首屏，原始日志退到折叠区。
 *
 * 旧版这里只给一段 stderr，用户看到一堆 WARN 却看不懂为什么失败——真正的判据
 * （门禁那份 JSON）走 stdout，被错误摘要整段丢掉了。CDS 其实把完整日志一行不落
 * 存下来了，所以这一屏不需要新接口，只需要把结论从日志里捞出来（releaseDiagnosis.ts）。
 *
 * 「未触及生产」这类结论必须由数据推出来，不许拍脑袋：只有当目标当前跑着的
 * commit 与这次失败的 commit 不同时，才敢说生产还停在原来那一版。
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, HardDrive, Loader2, RotateCcw, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import {
  diagnoseReleaseFailure,
  parseDiskGuardShortfall,
  type ReleaseGateCheck,
  type ReleaseLogGroup,
} from '@/lib/releaseDiagnosis';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { Chip, CodeText, formatClock, formatDateTime, formatDuration } from './shared';
import type { CenterRow, ReleaseRun } from './types';

export interface FailureDiagnosisProps {
  run: ReleaseRun;
  row?: CenterRow;
  retrying: boolean;
  canRollback: boolean;
  onRetry: (run: ReleaseRun) => void;
  onRollback: (run: ReleaseRun) => void;
}

export function FailureDiagnosis({
  run,
  row,
  retrying,
  canRollback,
  onRetry,
  onRollback,
}: FailureDiagnosisProps): JSX.Element {
  const diagnosis = diagnoseReleaseFailure(run.logs || []);
  const diskShortfall = parseDiskGuardShortfall(run.logs || []);
  const progress = resolveReleaseSteps(run);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  // 生产是否被改动：只在「目标当前成功版本 ≠ 本次失败版本」时才敢下结论。
  const productionUntouched = Boolean(row?.currentCommit) && row?.currentCommit !== run.commitSha;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="rounded-lg border border-[hsl(var(--hairline))] border-l-[3px] border-l-red-500 bg-[hsl(var(--surface-raised))] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="bad">发布失败</Chip>
              {row ? <Chip>{row.target.name}</Chip> : null}
              <CodeText className="text-muted-foreground">{run.releaseId}</CodeText>
            </div>
            {/* 结论位恒为一句话：判据层已切掉 stderr 尾巴，这里再用 line-clamp 兜一道，
                任何漏网的长文本都不许把操作按钮挤出首屏。完整原文见下方 error 行区块。 */}
            <h3 className="mt-2.5 line-clamp-2 text-[17px] font-semibold leading-snug">{diagnosis.headline}</h3>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {formatDateTime(run.startedAt)}
              {run.operator ? ` 由 ${run.operator} 触发` : ''}
              {` · commit ${run.commitSha.slice(0, 7)}`}
              {duration ? ` · 耗时 ${duration}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onRetry(run)} disabled={retrying}>
              <RefreshCw />
              修好后重试
            </Button>
            <Button size="sm" variant="outline" onClick={() => onRollback(run)} disabled={!canRollback}>
              <RotateCcw />
              回滚到历史版本
            </Button>
          </div>
        </div>

        {/* 失败后第一个要确认的事实：生产有没有被动过。以前它是元信息行末尾的一句
            灰色小字，读者要先趟过整条元信息才看得到；现在单独成行。
            只在能被数据证明时出现（目标当前版本 ≠ 本次版本），证明不了就不说。 */}
        {productionUntouched && row ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">生产未受影响</span>
            <span className="text-muted-foreground">
              {row.target.name}仍在 <CodeText>{row.currentCommit.slice(0, 7)}</CodeText>，本次版本没有切换上线
            </span>
          </div>
        ) : null}
      </section>

      {diskShortfall && row ? (
        <DiskDiagnosisCard targetId={row.target.id} shortfall={diskShortfall} />
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {diagnosis.report ? (
            <section className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
              <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
                <h4 className="text-sm font-semibold">失败判据 · {diagnosis.report.totalCount} 项检查</h4>
                <Chip tone={diagnosis.report.failCount > 0 ? 'bad' : 'ok'}>
                  {diagnosis.report.failCount > 0 ? `${diagnosis.report.failCount} 项未通过` : '全部通过'}
                </Chip>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <th className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">检查项</th>
                      <th className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">结果</th>
                      <th className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">细节</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderChecks(diagnosis.report.checks).map((check) => (
                      <CheckRow key={check.name} check={check} />
                    ))}
                  </tbody>
                </table>
              </div>
              {diagnosis.humanHint ? (
                <div className="border-t border-[hsl(var(--hairline))] p-4">
                  <h5 className="text-sm font-semibold">人话</h5>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{diagnosis.humanHint}</p>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="cds-surface-raised cds-hairline rounded-lg p-4">
              <h4 className="text-sm font-semibold">失败判据</h4>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                这次发布的日志里没有结构化的门禁报告，只能给出 error 级日志原文。
                如果远端脚本本身会打 JSON 结论，确认它走的是 stdout 且没有被上层截断。
              </p>
            </section>
          )}

          {diagnosis.errorGroups.length > 0 ? (
            <section className="cds-surface-raised cds-hairline rounded-lg p-4">
              <h4 className="text-sm font-semibold">错误级日志（{describeGroups(diagnosis.errorGroups)}）</h4>
              <LogGroupList groups={diagnosis.errorGroups} />
            </section>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <section className="cds-surface-raised cds-hairline rounded-lg p-4">
            <h4 className="text-sm font-semibold">步骤</h4>
            <ol className="mt-2 flex flex-col">
              {progress.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2.5 border-b border-dashed border-[hsl(var(--hairline))] py-2 last:border-b-0">
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border-2 ${
                      step.state === 'done'
                        ? 'border-emerald-500 bg-emerald-500'
                        : step.state === 'failed'
                          ? 'border-red-500 bg-red-500'
                          : 'border-[hsl(var(--hairline-strong))]'
                    }`}
                  />
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${step.state === 'failed' ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
            {progress.degraded ? (
              <p className="mt-2 text-[11px] text-muted-foreground">历史记录，仅按日志还原大致阶段。</p>
            ) : null}
          </section>

          {diagnosis.noiseGroups.length > 0 ? (
            <section className="cds-surface-raised cds-hairline rounded-lg p-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  顺带发现的噪音
                </h4>
                <Chip tone="warn">{describeGroups(diagnosis.noiseGroups)}</Chip>
              </div>
              {/* 噪音栏只给代表行 + 计数：这一栏本来就写着「不是失败原因」，
                  再把只差一个倒计时的几种写法铺开只是二次刷屏。完整原文在下方原始日志。 */}
              <LogGroupList groups={diagnosis.noiseGroups} showVariants={false} />
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                这些是 WARN，不是失败原因；但它们会把真正的判据挤出错误摘要，
                所以单独列在这里，不与上面的结论混在一起。
              </p>
            </section>
          ) : null}

          <details className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
            <summary className="flex cursor-pointer items-center gap-1.5 px-4 py-3 text-sm font-semibold">
              <ChevronDown className="h-4 w-4" />
              原始日志（{(run.logs || []).length} 行）
            </summary>
            <pre
              className="max-h-[40vh] overflow-auto border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6"
            >
              {(run.logs || [])
                .map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`)
                .join('\n') || '没有日志。'}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

/** 「12 条 · 归并 3 组」——刷屏被压掉多少，得让读者看见，不能悄悄少几行。 */
function describeGroups(groups: ReadonlyArray<ReleaseLogGroup>): string {
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return total > groups.length ? `${total} 条 · 归并 ${groups.length} 组` : `${total} 条`;
}

/**
 * 归并后的日志块。
 *
 * 重复只压缩计数，不压缩差异：同组里出现过的不同原文（`404` 与 `500` 这种）
 * 逐条列出来，读者不必翻原始日志才知道组里并非一模一样。
 */
function LogGroupList({
  groups,
  showVariants = true,
}: {
  groups: ReadonlyArray<ReleaseLogGroup>;
  showVariants?: boolean;
}): JSX.Element {
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6">
      {groups.map((group) => (
        <div key={group.text} className="whitespace-pre-wrap break-all">
          {(showVariants ? group.variants : group.variants.slice(0, 1)).map((variant, index) => (
            <div key={variant} className={index > 0 ? 'text-muted-foreground' : ''}>
              {variant}
              {index === 0 && group.count > 1 ? (
                <span className="ml-2 rounded bg-[hsl(var(--hairline))] px-1.5 text-[10.5px] text-muted-foreground">
                  × {group.count}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 未通过的排最前——用户来这一屏只为看它。 */
function orderChecks(checks: ReadonlyArray<ReleaseGateCheck>): ReleaseGateCheck[] {
  return [...checks].sort((a, b) => Number(a.ok) - Number(b.ok));
}

function CheckRow({ check }: { check: ReleaseGateCheck }): JSX.Element {
  return (
    <tr className={check.ok ? '' : 'bg-red-500/10'}>
      <td className="border-b border-[hsl(var(--hairline))] px-3 py-2 align-top font-mono text-[12px]">{check.name}</td>
      <td className="border-b border-[hsl(var(--hairline))] px-3 py-2 align-top">
        <Chip tone={check.ok ? 'ok' : 'bad'}>{check.ok ? '通过' : '失败'}</Chip>
      </td>
      <td className="border-b border-[hsl(var(--hairline))] px-3 py-2 align-top text-muted-foreground">
        {check.fields.length > 0 ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {check.fields.map((field) => (
              <span key={field.key} className="font-mono text-[11.5px]">
                {field.key}={field.value}
              </span>
            ))}
          </span>
        ) : (
          <span className="break-all font-mono text-[11.5px]">{check.detail || '-'}</span>
        )}
      </td>
    </tr>
  );
}

/**
 * 磁盘护栏失败专属的下一步：一键只读诊断。
 *
 * 背景（2026-07-30）：生产发布三连死在「requires at least 4096MB free on /」，
 * 但 CDS 没有自由 shell，用户只能对着差额干瞪眼。这张卡把差额算清楚，
 * 再给一个按钮在目标机上跑 df / docker system df / 热点目录 du（只读，
 * 见后端 buildDiskDiagnosisCommand），让「清什么」有数据可依。
 * 清理本身仍然是人的决定——这里绝不提供删除按钮。
 */
function DiskDiagnosisCard({ targetId, shortfall }: {
  targetId: string;
  shortfall: { requiredMb: number; availableMb: number; shortfallMb: number; mountPoint: string };
}): JSX.Element {
  const [output, setOutput] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');

  const runDiagnosis = async (): Promise<void> => {
    setState('running');
    setError('');
    try {
      const res = await apiRequest<{ output: string }>(
        `/api/releases/targets/${encodeURIComponent(targetId)}/disk-diagnosis`,
      );
      setOutput(res.output || '（无输出）');
      setState('idle');
    } catch (err) {
      setState('error');
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <section className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <HardDrive className="h-4 w-4 shrink-0 text-amber-500" />
            磁盘空间不足：{shortfall.mountPoint} 还差 {shortfall.shortfallMb}MB
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            发布脚本要求 {shortfall.requiredMb}MB 空闲，当前只有 {shortfall.availableMb}MB。
            先跑一次只读诊断看空间被什么吃掉，再登录目标机清理（诊断不会删除任何东西）。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void runDiagnosis()} disabled={state === 'running'}>
          {state === 'running' ? <Loader2 className="animate-spin" /> : <HardDrive />}
          磁盘诊断
        </Button>
      </div>
      {state === 'error' ? (
        <p className="mt-2 text-xs text-red-500">诊断失败：{error}</p>
      ) : null}
      {output ? (
        <pre
          className="mt-3 max-h-72 max-w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11px] leading-5"
        >
          {output}
        </pre>
      ) : null}
    </section>
  );
}
