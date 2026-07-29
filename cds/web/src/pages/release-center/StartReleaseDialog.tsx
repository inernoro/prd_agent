/**
 * 就地发布：在发布中心里选分支 → 发布前检查 → 开始发布 → 看实时日志。
 *
 * 旧版的「立即发布」是一个跳去 /branch-list 的链接，等于把人从发布中心踢走，
 * 再让他在一堆分支卡里自己找回刚才那个环境。发布是这一页的主动作，
 * 没有理由让它离开当前页面。
 *
 * 提升（promote）复用同一个弹窗：它只是「预先选好分支 + 钉死 commit」的发布，
 * 不引入「发布候选」这样一个中间实体。expectedCommitSha 是那道 fail-closed 钳制——
 * 少了它，源环境那一版之后分支又前进了的话，会静默发出另一个从未验证过的版本。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Gauge, Loader2, Rocket, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import { resolvePreviewUrl, type PreviewMode, type PreviewUrlConfig } from '@/lib/previewUrl';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { useNowTick } from '@/hooks/useNowTick';
import { releaseEtaText } from '@/lib/releaseEta';
import { dedupeLogs, parseSseJson } from './dialogs';
import { Chip, CodeText, StatusPill, formatClock } from './shared';
import type {
  BranchOption,
  CenterRow,
  ReleaseCommitMeta,
  ReleaseLogEntry,
  ReleasePreflightResult,
  ReleaseRun,
} from './types';
import { isReleaseTerminal } from './types';

/** 发布意图。promote 时分支与 commit 都已钉死，用户只需要确认。 */
export interface StartReleaseIntent {
  row: CenterRow;
  /** 预选分支；promote 时来自源环境那次成功发布的 run。 */
  branchId?: string;
  /** 钉死的 commit。只有 promote 会带。 */
  expectedCommitSha?: string;
  /** promote 时的预览地址（源 run 的产物地址），避免重新推导。 */
  previewUrl?: string;
  /** 弹窗标题上的一句话，说明这次发布是怎么来的。 */
  reason?: string;
}

export interface StartReleaseDialogProps {
  intent: StartReleaseIntent | null;
  branches: BranchOption[];
  branchesLoading: boolean;
  previewMode?: PreviewMode;
  previewConfig: PreviewUrlConfig;
  commitMeta: Record<string, ReleaseCommitMeta>;
  onClose: () => void;
  onStarted: (run: ReleaseRun) => void;
  onToast: (message: string) => void;
}

export function StartReleaseDialog({
  intent,
  branches,
  branchesLoading,
  previewMode,
  previewConfig,
  commitMeta,
  onClose,
  onStarted,
  onToast,
}: StartReleaseDialogProps): JSX.Element {
  const [branchId, setBranchId] = useState('');
  const [preflight, setPreflight] = useState<ReleasePreflightResult | null>(null);
  const [preflightState, setPreflightState] = useState<'idle' | 'running' | 'error'>('idle');
  const [run, setRun] = useState<ReleaseRun | null>(null);
  const [logs, setLogs] = useState<ReleaseLogEntry[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!intent) return;
    setBranchId(intent.branchId || branches[0]?.id || '');
    setPreflight(null);
    setPreflightState('idle');
    setRun(null);
    setLogs([]);
  }, [intent, branches]);

  const branch = useMemo(() => branches.find((item) => item.id === branchId), [branches, branchId]);
  // promote 走源 run 的产物地址；普通发布按预览模式推导（推导不出来就交给发布前检查说话）。
  const previewUrl = intent?.previewUrl
    || (branch ? resolvePreviewUrl(previewMode, branch, previewConfig) : '');
  const commitSha = intent?.expectedCommitSha || branch?.commitSha || branch?.githubCommitSha || '';
  const subject = commitMeta[commitSha]?.subject || branch?.subject || '';

  const runPreflight = useCallback(async (): Promise<void> => {
    if (!intent || !branchId) return;
    setPreflightState('running');
    setPreflight(null);
    try {
      const result = await apiRequest<ReleasePreflightResult>(
        `/api/releases/branches/${encodeURIComponent(branchId)}/preflight`,
        { method: 'POST', body: { targetId: intent.row.target.id, previewUrl } },
      );
      setPreflight(result);
      setPreflightState('idle');
    } catch (err) {
      setPreflightState('error');
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  }, [intent, branchId, previewUrl, onToast]);

  const start = async (): Promise<void> => {
    if (!intent || !branchId) return;
    setStarting(true);
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(
        `/api/releases/branches/${encodeURIComponent(branchId)}/runs`,
        {
          method: 'POST',
          body: {
            targetId: intent.row.target.id,
            previewUrl,
            ...(intent.expectedCommitSha ? { expectedCommitSha: intent.expectedCommitSha } : {}),
          },
        },
      );
      setRun(res.run);
      setLogs(res.run.logs || []);
      onStarted(res.run);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!run || isReleaseTerminal(run.status)) return undefined;
    const source = new EventSource(apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${run.logs.at(-1)?.seq || 0}`));
    source.addEventListener('snapshot', (event) => {
      const data = parseSseJson<{ run: ReleaseRun }>(event);
      if (!data?.run) return;
      setRun(data.run);
      setLogs(dedupeLogs(data.run.logs || []));
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSseJson<{ log: ReleaseLogEntry }>(event);
      if (!data?.log) return;
      setLogs((current) => dedupeLogs([...current, data.log]));
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSseJson<{ run: ReleaseRun }>(event);
      if (data?.run) setRun(data.run);
    });
    return () => source.close();
  }, [run]);

  const inFlight = Boolean(run && !isReleaseTerminal(run.status));
  const nowMs = useNowTick(inFlight);
  const etaText = inFlight ? releaseEtaText(run?.startedAt, intent?.row.releaseEstimate, nowMs) : '';
  const progress = resolveReleaseSteps(run);
  const blocking = preflight ? preflight.checks.filter((check) => check.status === 'fail' && check.blocking) : [];
  const canStart = Boolean(branchId && preflight && blocking.length === 0 && !starting);

  return (
    <Dialog open={Boolean(intent)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(820px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>发布到 {intent?.row.target.name || '环境'}</DialogTitle>
        </DialogHeader>
        {!intent ? null : (
          <div className="flex flex-col gap-4">
            {intent.reason ? (
              <div className="rounded-md bg-primary/10 px-3 py-2 text-[12.5px] text-primary">{intent.reason}</div>
            ) : null}

            <section className="grid gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm md:grid-cols-3">
              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">分支</span>
                {intent.expectedCommitSha ? (
                  <span className="truncate font-mono text-xs">{branch?.branch || intent.branchId || '-'}</span>
                ) : branchesLoading ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在读取分支
                  </span>
                ) : (
                  <select
                    value={branchId}
                    onChange={(event) => { setBranchId(event.target.value); setPreflight(null); }}
                    disabled={Boolean(run)}
                    className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 text-sm outline-none focus:border-primary/60"
                  >
                    <option value="">请选择分支</option>
                    {branches.map((item) => (
                      <option key={item.id} value={item.id}>{item.branch}</option>
                    ))}
                  </select>
                )}
              </label>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Commit</div>
                <div className="mt-1 truncate font-mono text-xs">{commitSha ? commitSha.slice(0, 12) : '-'}</div>
                {subject ? <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={subject}>{subject}</div> : null}
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">预览地址</div>
                <div className="mt-1 truncate font-mono text-xs">{previewUrl || '未推导出，发布前检查会给出结论'}</div>
              </div>
            </section>

            {run ? (
              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusPill status={run.status} />
                  {etaText ? <span className="text-xs text-primary">{etaText}</span> : null}
                  <CodeText className="text-muted-foreground">{run.releaseId}</CodeText>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {progress.steps.map((step, index) => (
                    <div key={step.id} className="flex items-center gap-2.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-[13px]">
                      {step.state === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        : step.state === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                          : step.state === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-500" />
                            : <span className="h-4 w-4 shrink-0 rounded-full border border-[hsl(var(--hairline-strong))]" />}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{index + 1}/{progress.total}</span>
                      <span className="min-w-0 truncate">{step.label}</span>
                    </div>
                  ))}
                </div>
                <pre
                  className="max-h-[34vh] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-[11.5px] leading-6"
                  style={{ overscrollBehavior: 'contain' }}
                >
                  {logs.map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.message}`).join('\n') || '等待发布日志...'}
                </pre>
              </section>
            ) : (
              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">发布前检查</h4>
                  {preflight ? (
                    <Chip tone={blocking.length > 0 ? 'bad' : 'ok'}>
                      {preflight.checks.filter((check) => check.status === 'pass').length}/{preflight.checks.length} 项通过
                    </Chip>
                  ) : null}
                </div>
                {preflightState === 'running' ? (
                  <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在跑发布前检查
                  </div>
                ) : preflight ? (
                  <ul className="flex flex-col gap-1.5">
                    {preflight.checks.map((check) => (
                      <li
                        key={check.id}
                        className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-[13px] ${
                          check.status === 'fail'
                            ? 'border-red-500/35 bg-red-500/10'
                            : check.status === 'warn'
                              ? 'border-amber-500/35 bg-amber-500/10'
                              : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45'
                        }`}
                      >
                        {check.status === 'pass'
                          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                          : <XCircle className={`mt-0.5 h-4 w-4 shrink-0 ${check.status === 'fail' ? 'text-red-500' : 'text-amber-500'}`} />}
                        <span className="min-w-0">
                          <span className="font-medium">{check.label}</span>
                          <span className="mt-0.5 block break-words text-[12px] text-muted-foreground">{check.message}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-6 text-center text-sm text-muted-foreground">
                    先跑一次发布前检查，确认这一版能发之后再动手。
                  </p>
                )}
              </section>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] pt-3">
              <span className="text-xs text-muted-foreground">
                {run
                  ? '关掉这个弹窗不会中断发布，页面会继续跟进到终态。'
                  : blocking.length > 0
                    ? `有 ${blocking.length} 项阻断检查未通过，先修好再发。`
                    : '发布前检查通过后才能开始发布。'}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose}>{run ? '关闭' : '取消'}</Button>
                {!run ? (
                  <>
                    <Button variant="outline" onClick={() => void runPreflight()} disabled={!branchId || preflightState === 'running'}>
                      {preflightState === 'running' ? <Loader2 className="animate-spin" /> : <Gauge />}
                      发布前检查
                    </Button>
                    <Button onClick={() => void start()} disabled={!canStart}>
                      {starting ? <Loader2 className="animate-spin" /> : <Rocket />}
                      开始发布
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
