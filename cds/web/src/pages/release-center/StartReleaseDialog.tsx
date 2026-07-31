/**
 * 就地发布：在发布中心里选分支 → 发布前检查 → 开始发布 → 看实时日志。
 *
 * 2026-07-30 按用户五张截图整体重做，四条结构性决定：
 *
 * 1. **frame 布局，底栏永远可见**。旧版把全部内容塞进弹窗的整体滚动区，
 *    发布前检查一长（含整段脚本），「开始发布」按钮被推到两屏以外。
 *    现在是 shrink-0 头部 / flex-1 滚动主体 / shrink-0 底栏，操作不再消失。
 * 2. **发布中不再渲染表单**。旧版发布开始后仍渲染那排「分支下拉 + Commit +
 *    预览地址」，长日志把内容撑宽后这些格子被裁掉一半（截图里「输入框不见了」）。
 *    发布中改为一行静态摘要 chips——反正也不允许改。
 * 3. **地址两端说清**。「来源」是分支预览产物（CDS API 的 previewUrl/previewUrls，
 *    SSOT，公式只兜底），「发布到」是目标的上线地址（用户配置过的那一端）。
 *    旧版只显示一个「预览地址」，用户看到 miduo.org 子域以为发错了地方。
 * 4. **长文案折叠 + 日志自动跟最新**。判定纯函数在 lib/releaseDialogAddress.ts，
 *    日志窗格与发布记录弹窗共用 ReleaseLogPane。
 *
 * 提升（promote）复用同一个弹窗：它只是「预先选好分支 + 钉死 commit」的发布，
 * 不引入「发布候选」这样一个中间实体。expectedCommitSha 是那道 fail-closed 钳制——
 * 少了它，源环境那一版之后分支又前进了的话，会静默发出另一个从未验证过的版本。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Gauge, Loader2, Rocket, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import { resolvePreviewUrl, type PreviewMode, type PreviewUrlConfig } from '@/lib/previewUrl';
import {
  collapseCheckMessage,
  releaseTargetPublicUrl,
  resolveReleaseSourceUrls,
} from '@/lib/releaseDialogAddress';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { useNowTick } from '@/hooks/useNowTick';
import { releaseEtaText } from '@/lib/releaseEta';
import { dedupeLogs, parseSseJson } from './dialogs';
import { Chip, CodeText, ReleaseLogPane, StatusPill, formatClock } from './shared';
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

  // `port` 模式的入口是运行期分配的端口，公式算不出来（resolvePreviewUrl 会如实给空串）。
  // 现取一次，取不到就保持空串让发布前检查拦下——绝不编一个子域出来充数。
  const [portPreviewUrl, setPortPreviewUrl] = useState('');
  useEffect(() => {
    if (previewMode !== 'port' || !branchId || intent?.previewUrl) {
      setPortPreviewUrl('');
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiRequest<{ port: number }>(
          `/api/branches/${encodeURIComponent(branchId)}/preview-port`,
          { method: 'POST' },
        );
        if (cancelled || !result?.port) return;
        setPortPreviewUrl(`${window.location.protocol}//${window.location.hostname}:${result.port}`);
      } catch {
        // 静默：错误由发布前检查的「可发布产物」那一项统一说明，
        // 这里再弹一个 toast 只会让用户看到两遍同一件事。
        if (!cancelled) setPortPreviewUrl('');
      }
    })();
    return () => { cancelled = true; };
  }, [previewMode, branchId, intent?.previewUrl]);

  // 来源地址：promote 钉死值 > CDS API 的 previewUrl/previewUrls（SSOT）> 公式/端口兜底。
  const sourceUrls = resolveReleaseSourceUrls({
    intentPreviewUrl: intent?.previewUrl,
    branch,
    fallbackUrl: (branch ? resolvePreviewUrl(previewMode, branch, previewConfig) : '') || portPreviewUrl,
  });
  const previewUrl = sourceUrls[0] || '';
  const publicUrl = releaseTargetPublicUrl(intent?.row.target);
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
  const logText = logs.map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.message}`).join('\n');

  return (
    <Dialog open={Boolean(intent)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        frame
        className="max-w-none"
        // 发布中钉死高度：日志窗格要一块稳定的地盘来吸底滚动；
        // 发布前由内容决定高度（上限 90vh），短内容不硬撑一个空壳。
        style={{ width: 'min(880px, calc(100vw - 24px))', ...(run ? { height: 'min(680px, 90vh)' } : {}) }}
      >
        <div className="flex shrink-0 flex-col gap-1 border-b border-[hsl(var(--hairline))] px-5 py-4">
          <DialogTitle>发布到 {intent?.row.target.name || '环境'}</DialogTitle>
          {intent?.reason ? <p className="text-[12.5px] text-primary">{intent.reason}</p> : null}
        </div>
        {!intent ? null : (
          <>
            {/* 上下文条：发布前是表单，发布中是静态摘要（不再渲染没法交互的表单壳）。 */}
            <div className="shrink-0 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 px-5 py-3">
              {run ? (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                  <Chip>{branch?.branch || intent.branchId || '-'}</Chip>
                  <CodeText className="text-muted-foreground">{commitSha ? commitSha.slice(0, 12) : '-'}</CodeText>
                  {subject ? <span className="min-w-0 truncate text-muted-foreground" title={subject}>{subject}</span> : null}
                  {publicUrl ? (
                    <a href={publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono text-primary hover:underline">
                      <span className="truncate">{publicUrl}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : null}
                </div>
              ) : (
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <label className="grid min-w-0 content-start gap-1">
                    <span className="text-xs text-muted-foreground">分支</span>
                    {intent.expectedCommitSha ? (
                      <span className="truncate font-mono text-xs leading-9">{branch?.branch || intent.branchId || '-'}</span>
                    ) : branchesLoading ? (
                      <span className="inline-flex items-center gap-1.5 text-xs leading-9 text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        正在读取分支
                      </span>
                    ) : (
                      <select
                        value={branchId}
                        onChange={(event) => { setBranchId(event.target.value); setPreflight(null); }}
                        className="h-9 w-full min-w-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 text-sm outline-none focus:border-primary/60"
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
                    <div className="text-xs text-muted-foreground">来源（分支预览产物）</div>
                    {sourceUrls.length > 0 ? sourceUrls.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer" className="mt-1 flex min-w-0 items-center gap-1 font-mono text-xs text-primary hover:underline">
                        <span className="truncate">{url}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    )) : (
                      <div className="mt-1 text-xs text-muted-foreground">未推导出，发布前检查会给出结论</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">发布到（上线地址）</div>
                    {publicUrl ? (
                      <a href={publicUrl} target="_blank" rel="noreferrer" className="mt-1 flex min-w-0 items-center gap-1 font-mono text-xs text-primary hover:underline">
                        <span className="truncate">{publicUrl}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <div className="mt-1 text-xs text-muted-foreground">目标未配置上线地址</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {run ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-5 py-4">
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm">
                  <StatusPill status={run.status} />
                  {etaText ? <span className="text-xs text-primary">{etaText}</span> : null}
                  <CodeText className="text-muted-foreground">{run.releaseId}</CodeText>
                </div>
                <div className="grid shrink-0 gap-2 sm:grid-cols-2">
                  {progress.steps.map((step, index) => (
                    <div key={step.id} className="flex min-w-0 items-center gap-2.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-[13px]">
                      {step.state === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        : step.state === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                          : step.state === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-500" />
                            : <span className="h-4 w-4 shrink-0 rounded-full border border-[hsl(var(--hairline-strong))]" />}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{index + 1}/{progress.total}</span>
                      <span className="min-w-0 truncate">{step.label}</span>
                    </div>
                  ))}
                </div>
                <ReleaseLogPane text={logText} className="flex-1" />
              </div>
            ) : (
              <DialogBody className="flex flex-col gap-3">
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
                      <PreflightCheckItem key={check.id} check={check} />
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-6 text-center text-sm text-muted-foreground">
                    先跑一次发布前检查，确认这一版能发之后再动手。
                  </p>
                )}
              </DialogBody>
            )}

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] px-5 py-3">
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 单条发布前检查。message 可能是整段生成脚本（几百行）——那是「发布策略完整」
 * 的判据证据，有用但不该常驻屏幕。折叠判定见 collapseCheckMessage：
 * 默认只给一行摘要，点「展开完整内容」才铺开，且完整内容在自己的滚动格里消化。
 */
function PreflightCheckItem({ check }: { check: ReleasePreflightResult['checks'][number] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapseCheckMessage(check.message);
  return (
    <li
      className={`flex min-w-0 items-start gap-2.5 rounded-md border px-3 py-2 text-[13px] ${
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
      <span className="min-w-0 flex-1">
        <span className="font-medium">{check.label}</span>
        <span className="mt-0.5 block break-words text-[12px] text-muted-foreground">{collapsed.summary}</span>
        {collapsed.detail ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="mt-1 text-[12px] text-primary hover:underline"
            >
              {expanded ? '收起完整内容' : `展开完整内容（${collapsed.lineCount} 行）`}
            </button>
            {expanded ? (
              <pre className="mt-1.5 max-h-64 max-w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-2.5 font-mono text-[11px] leading-5" style={{ overscrollBehavior: 'contain' }}>
                {collapsed.detail}
              </pre>
            ) : null}
          </>
        ) : null}
      </span>
    </li>
  );
}
