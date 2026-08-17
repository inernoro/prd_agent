/*
 * ReplicaLoadTestPanel —— 复制集压测（A/B 负载对比台），design.cds.replica-loadtest。
 *
 * 复制集本来就把「多版本并排 + 权重可控 + 每个成员有独立直达入口」摆好了，
 * 缺的只是打流量、收指标、出结论。这个面板补上这三件事，交互上守三条：
 *
 *   - **少绕路**：目标、路径、并发、时长全部有智能默认，打开就能点「开始压测」；
 *     想细调再展开（奥卡姆：首屏只放 80% 场景要用的东西）。
 *   - **产物即体验**：跑起来之后主视觉是**曲线本身在生长**（每秒一个采样点的
 *     QPS / p95 双轴折线），配阶段文案 + 已耗时 + 预计剩余，不是一个转圈图标。
 *   - **结论要能读**：结束后先给一句人话结论（谁更快、谁更稳），再给并排指标表；
 *     用户不必自己去比四位小数。
 *
 * 颜色一律走 token / Tailwind 语义类，双主题可读；模态走 createPortal + inline
 * 高度 + min-h-0 滚动三硬约束。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChevronDown, ChevronRight, Loader2, Play, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { describeErrors, formatEta, lineColor, polylinePoints } from '@/lib/loadtestChart';

/* ── 服务端契约（src/services/replica-loadtest.ts） ── */

export interface LoadTestSeriesPointView { second: number; qps: number; p95: number; errors: number }

export interface LoadTestTargetMetricsView {
  memberId: string;
  label: string;
  requests: number;
  success: number;
  failed: number;
  successRate: number;
  qps: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  errors: Record<string, number>;
  servedBy: Record<string, number>;
  series: LoadTestSeriesPointView[];
}

export interface LoadTestComparisonView {
  baselineId: string;
  baselineLabel: string;
  rows: Array<{
    memberId: string;
    label: string;
    p95DeltaPct: number | null;
    qpsDeltaPct: number | null;
    successRateDeltaPoint: number | null;
    verdict: string;
  }>;
  summary: string;
}

export interface LoadTestRunView {
  id: string;
  branchId: string;
  profileId: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  config: { concurrency: number; durationSec: number; warmupSec: number; method: string; path: string; host: string };
  targets: LoadTestTargetMetricsView[];
  comparison?: LoadTestComparisonView;
  startedAt: string;
  endedAt?: string;
  elapsedSec: number;
  progressPct: number;
  etaSec: number;
  phase: string;
  message?: string;
}

export interface LoadTestMemberOption { memberId: string; label: string; running: boolean }

interface StartForm {
  profileId: string;
  memberIds: string[];
  concurrency: number;
  durationSec: number;
  warmupSec: number;
  method: string;
  path: string;
}

export function ReplicaLoadTestPanel({ branchId, profileIds, membersOf, defaultProfileId, onClose, onToast }: {
  branchId: string;
  profileIds: string[];
  /** 某个服务当前可压的落点（主实例 + 运行中副本），由画布数据源传入，免用户手填 */
  membersOf: (profileId: string) => LoadTestMemberOption[];
  defaultProfileId?: string;
  onClose: () => void;
  onToast?: (message: string) => void;
}): JSX.Element {
  const firstProfile = defaultProfileId && profileIds.includes(defaultProfileId) ? defaultProfileId : (profileIds[0] || '');
  const [form, setForm] = useState<StartForm>({
    profileId: firstProfile,
    memberIds: [],
    concurrency: 5,
    durationSec: 20,
    warmupSec: 3,
    method: 'GET',
    path: '',
  });
  const [advanced, setAdvanced] = useState(false);
  const [run, setRun] = useState<LoadTestRunView | null>(null);
  const [history, setHistory] = useState<LoadTestRunView[]>([]);
  const [starting, setStarting] = useState(false);
  const runIdRef = useRef<string | null>(null);

  const options = form.profileId ? membersOf(form.profileId) : [];
  const selectable = options.filter((o) => o.running);
  const chosen = form.memberIds.length > 0 ? form.memberIds : selectable.map((o) => o.memberId);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiRequest<{ runs: LoadTestRunView[] }>(`/api/branches/${encodeURIComponent(branchId)}/replica-loadtests`);
      setHistory(res.runs || []);
      const live = (res.runs || []).find((r) => r.status === 'running');
      if (live && !runIdRef.current) {
        runIdRef.current = live.id;
        setRun(live);
      }
    } catch {
      // 历史读不到不影响发起，静默（发起失败会有明确 toast）
    }
  }, [branchId]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // 跑动期间 1s 轮询：曲线逐秒生长（禁止空白等待），结束即停轮询
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await apiRequest<{ run: LoadTestRunView }>(
            `/api/branches/${encodeURIComponent(branchId)}/replica-loadtests/${encodeURIComponent(run.id)}`,
          );
          setRun(res.run);
          if (res.run.status !== 'running') {
            runIdRef.current = null;
            void loadHistory();
          }
        } catch (err) {
          onToast?.(err instanceof ApiError ? err.message : String(err));
        }
      })();
    }, 1000);
    return () => clearInterval(timer);
  }, [run, branchId, loadHistory, onToast]);

  const start = async (): Promise<void> => {
    if (starting || !form.profileId) return;
    setStarting(true);
    try {
      const res = await apiRequest<{ run: LoadTestRunView }>(`/api/branches/${encodeURIComponent(branchId)}/replica-loadtests`, {
        method: 'POST',
        body: {
          profileId: form.profileId,
          memberIds: form.memberIds.length > 0 ? form.memberIds : undefined,
          concurrency: form.concurrency,
          durationSec: form.durationSec,
          warmupSec: form.warmupSec,
          method: form.method,
          path: form.path.trim() || undefined,
        },
      });
      runIdRef.current = res.run.id;
      setRun(res.run);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    }
    setStarting(false);
  };

  const stop = async (): Promise<void> => {
    if (!run) return;
    try {
      const res = await apiRequest<{ run: LoadTestRunView }>(
        `/api/branches/${encodeURIComponent(branchId)}/replica-loadtests/${encodeURIComponent(run.id)}/cancel`,
        { method: 'POST', body: {} },
      );
      runIdRef.current = null;
      setRun(res.run);
      void loadHistory();
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    }
  };

  const running = run?.status === 'running';

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex w-full flex-col rounded-xl border border-[hsl(var(--hairline))] bg-background shadow-2xl"
        style={{ maxWidth: 880, height: '82vh', maxHeight: '82vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
          <Activity className="h-4 w-4 text-primary" />
          <b className="text-sm">复制集压测 · A/B 负载对比</b>
          <span className="text-[11px] text-muted-foreground">同一入口、同一路径、同一时刻并排打，唯一变量是版本</span>
          <button type="button" className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 主产物区：填满剩余高度，内部滚动 */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <StartFormCard
            form={form}
            setForm={setForm}
            profileIds={profileIds}
            options={options}
            chosen={chosen}
            advanced={advanced}
            setAdvanced={setAdvanced}
            disabled={running || starting}
          />

          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void stop()}>
                <Square />停止压测
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={starting || chosen.length === 0} onClick={() => void start()}>
                {starting ? <Loader2 className="animate-spin" /> : <Play />}开始压测
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground">
              {chosen.length === 0
                ? '该服务当前没有运行中的实例，先把服务跑起来再压'
                : `将并排压 ${chosen.length} 个落点，合计并发 ${chosen.length * form.concurrency}（上限由服务端硬闸把关）`}
            </span>
          </div>

          {run ? <RunView run={run} /> : <EmptyHint />}

          {history.length > 0 ? <HistoryList runs={history} activeId={run?.id} onPick={(r) => setRun(r)} /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── 表单（智能默认 + 高级项折叠） ── */

function StartFormCard({ form, setForm, profileIds, options, chosen, advanced, setAdvanced, disabled }: {
  form: StartForm;
  setForm: (f: StartForm) => void;
  profileIds: string[];
  options: LoadTestMemberOption[];
  chosen: string[];
  advanced: boolean;
  setAdvanced: (v: boolean) => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-3">
        {profileIds.length > 1 ? (
          <Field label="服务">
            <select
              className="h-7 rounded-md border border-[hsl(var(--hairline))] bg-background px-2 text-xs"
              value={form.profileId}
              disabled={disabled}
              onChange={(e) => setForm({ ...form, profileId: e.target.value, memberIds: [] })}
            >
              {profileIds.map((pid) => <option key={pid} value={pid}>{pid}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="并发（每个落点）">
          <NumberInput value={form.concurrency} min={1} max={20} disabled={disabled} onChange={(v) => setForm({ ...form, concurrency: v })} />
        </Field>
        <Field label="持续（秒）">
          <NumberInput value={form.durationSec} min={3} max={300} disabled={disabled} onChange={(v) => setForm({ ...form, durationSec: v })} />
        </Field>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}高级选项
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">落点：</span>
        {options.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">该服务没有可压的实例</span>
        ) : options.map((o) => {
          const active = chosen.includes(o.memberId);
          return (
            <button
              key={o.memberId}
              type="button"
              disabled={disabled || !o.running}
              title={o.running ? '点击切换是否纳入本次压测' : '该实例不在运行态，无法压测'}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                !o.running
                  ? 'cursor-not-allowed border-[hsl(var(--hairline))] text-muted-foreground opacity-60'
                  : active
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => {
                const base = chosen;
                const next = active ? base.filter((id) => id !== o.memberId) : [...base, o.memberId];
                setForm({ ...form, memberIds: next });
              }}
            >
              {o.label}{o.running ? '' : '（未运行）'}
            </button>
          );
        })}
      </div>

      {advanced ? (
        <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-[hsl(var(--hairline))] pt-2">
          <Field label="预热（秒，样本不计入指标）">
            <NumberInput value={form.warmupSec} min={0} max={30} disabled={disabled} onChange={(v) => setForm({ ...form, warmupSec: v })} />
          </Field>
          <Field label="方法">
            <select
              className="h-7 rounded-md border border-[hsl(var(--hairline))] bg-background px-2 text-xs"
              value={form.method}
              disabled={disabled}
              onChange={(e) => setForm({ ...form, method: e.target.value })}
            >
              {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="路径（留空 = 按服务路由自动推导）">
            <input
              type="text"
              className="h-7 w-64 rounded-md border border-[hsl(var(--hairline))] bg-background px-2 font-mono text-xs"
              placeholder="/api/health"
              value={form.path}
              disabled={disabled}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({ value, min, max, disabled, onChange }: {
  value: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void;
}): JSX.Element {
  return (
    <input
      type="number"
      className="h-7 w-20 rounded-md border border-[hsl(var(--hairline))] bg-background px-2 text-xs"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.floor(n))));
      }}
    />
  );
}

function EmptyHint(): JSX.Element {
  return (
    <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-[hsl(var(--hairline))] px-6 text-center">
      <Activity className="h-6 w-6 text-muted-foreground" />
      <p className="mt-2 text-xs text-muted-foreground">
        还没有压测记录。点「开始压测」后，主实例与每个副本会被同时加压，
        <br />曲线逐秒生长，结束后给出「谁更快、谁更稳」的对比结论。
      </p>
    </div>
  );
}

/* ── 运行/结果视图：主视觉是生长中的曲线 ── */

function RunView({ run }: { run: LoadTestRunView }): JSX.Element {
  const running = run.status === 'running';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[hsl(var(--hairline))] px-3 py-2">
        <StatusDot status={run.status} />
        <b className="text-xs">{run.phase}</b>
        <span className="text-[11px] text-muted-foreground">{formatEta(run.elapsedSec, run.etaSec, run.status)}</span>
        <span className="text-[11px] font-mono text-muted-foreground">
          {run.config.method} {run.config.path} · 并发 {run.config.concurrency}/落点
        </span>
        <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-[hsl(var(--surface-sunken))]">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ${running ? 'bg-primary' : run.status === 'done' ? 'bg-ok' : 'bg-muted-foreground'}`}
            style={{ width: `${run.progressPct}%` }}
          />
        </div>
      </div>

      {run.message ? (
        <p className={`text-[11px] ${run.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{run.message}</p>
      ) : null}

      <LiveChart run={run} />

      {run.comparison ? <ComparisonCard comparison={run.comparison} /> : null}

      <MetricsTable targets={run.targets} />
    </div>
  );
}

function StatusDot({ status }: { status: LoadTestRunView['status'] }): JSX.Element {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  const cls = status === 'done' ? 'bg-ok' : status === 'error' ? 'bg-destructive' : 'bg-muted-foreground';
  return <span className={`h-2 w-2 rounded-full ${cls}`} />;
}

/**
 * 逐秒生长的 QPS / p95 双图（纯 SVG）。等待期主视觉就是它——每过一秒多一个点，
 * 用户看到的是产物在长，不是一个转圈的图标。
 */
function LiveChart({ run }: { run: LoadTestRunView }): JSX.Element {
  const W = 780;
  const H = 120;
  const measured = run.targets.map((t) => t.series.filter((p) => p.second >= 0));
  const maxQps = Math.max(1, ...measured.flatMap((s) => s.map((p) => p.qps)));
  const maxP95 = Math.max(1, ...measured.flatMap((s) => s.map((p) => p.p95)));
  const hasPoint = measured.some((s) => s.length > 0);
  return (
    <div className="rounded-lg border border-[hsl(var(--hairline))] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <b className="text-[11px] uppercase tracking-wide text-muted-foreground">每秒吞吐 QPS</b>
        {run.targets.map((t, i) => (
          <span key={t.memberId} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="h-0.5 w-3 rounded" style={{ background: lineColor(i) }} />{t.label}
          </span>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">峰值 {maxQps} req/s</span>
      </div>
      <Chart width={W} height={H} series={measured.map((s) => s.map((p) => p.qps))} max={maxQps} empty={!hasPoint} />
      <div className="mt-2 flex items-center gap-3 border-t border-[hsl(var(--hairline))] pt-2">
        <b className="text-[11px] uppercase tracking-wide text-muted-foreground">每秒 p95 延迟（ms）</b>
        <span className="ml-auto text-[11px] text-muted-foreground">峰值 {maxP95} ms</span>
      </div>
      <Chart width={W} height={H} series={measured.map((s) => s.map((p) => p.p95))} max={maxP95} empty={!hasPoint} dashed />
    </div>
  );
}

function Chart({ width, height, series, max, empty, dashed }: {
  width: number; height: number; series: number[][]; max: number; empty: boolean; dashed?: boolean;
}): JSX.Element {
  if (empty) {
    return (
      <div className="mt-1.5 flex items-center justify-center rounded-md border border-dashed border-[hsl(var(--hairline))]" style={{ height }}>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />正在采集第一个秒级采样点…
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ minWidth: 320, width: '100%' }} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((r) => (
          <line key={r} x1={0} y1={height * r} x2={width} y2={height * r}
            stroke="hsl(var(--hairline))" strokeWidth={1} strokeDasharray="3 4" />
        ))}
        {series.map((values, i) => {
          const points = polylinePoints(values, width, height, max);
          if (!points) return null;
          return (
            <polyline key={i} points={points} fill="none" stroke={lineColor(i)} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dashed ? '5 3' : undefined} />
          );
        })}
      </svg>
    </div>
  );
}

function ComparisonCard({ comparison }: { comparison: LoadTestComparisonView }): JSX.Element {
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/[.06] px-3 py-2.5">
      <b className="text-xs text-primary">对比结论</b>
      <p className="mt-1 text-xs">{comparison.summary}</p>
      <div className="mt-2 grid gap-1">
        {comparison.rows.map((row) => (
          <p key={row.memberId} className="text-[11px] text-muted-foreground">
            <span className="font-mono text-foreground">{row.label}</span>
            <span className="mx-1">相对基线 {comparison.baselineLabel}：</span>
            {row.verdict}
          </p>
        ))}
      </div>
    </div>
  );
}

function MetricsTable({ targets }: { targets: LoadTestTargetMetricsView[] }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--hairline))]" style={{ overscrollBehavior: 'contain' }}>
      <table className="w-full text-[11px]" style={{ minWidth: 620 }}>
        <thead>
          <tr className="border-b border-[hsl(var(--hairline))] text-left text-muted-foreground">
            <th className="px-2.5 py-1.5 font-medium">落点</th>
            <th className="px-2.5 py-1.5 font-medium">请求</th>
            <th className="px-2.5 py-1.5 font-medium">成功率</th>
            <th className="px-2.5 py-1.5 font-medium">QPS</th>
            <th className="px-2.5 py-1.5 font-medium">p50</th>
            <th className="px-2.5 py-1.5 font-medium">p90</th>
            <th className="px-2.5 py-1.5 font-medium">p95</th>
            <th className="px-2.5 py-1.5 font-medium">p99</th>
            <th className="px-2.5 py-1.5 font-medium">错误分类</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t, i) => (
            <tr key={t.memberId} className="border-b border-[hsl(var(--hairline))] last:border-0">
              <td className="px-2.5 py-1.5">
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded" style={{ background: lineColor(i) }} />
                  <span className="font-mono">{t.label}</span>
                </span>
              </td>
              <td className="px-2.5 py-1.5 font-mono">{t.requests}</td>
              <td className={`px-2.5 py-1.5 font-mono ${t.successRate < 0.99 ? 'text-destructive' : ''}`}>
                {Math.round(t.successRate * 1000) / 10}%
              </td>
              <td className="px-2.5 py-1.5 font-mono">{t.qps}</td>
              <td className="px-2.5 py-1.5 font-mono">{t.p50}</td>
              <td className="px-2.5 py-1.5 font-mono">{t.p90}</td>
              <td className="px-2.5 py-1.5 font-mono">{t.p95}</td>
              <td className="px-2.5 py-1.5 font-mono">{t.p99}</td>
              <td className="px-2.5 py-1.5 text-muted-foreground">{describeErrors(t.errors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryList({ runs, activeId, onPick }: {
  runs: LoadTestRunView[]; activeId?: string; onPick: (r: LoadTestRunView) => void;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-[hsl(var(--hairline))] px-3 py-2">
      <b className="text-[11px] uppercase tracking-wide text-muted-foreground">历史压测</b>
      <div className="mt-1.5 grid gap-1">
        {runs.slice(0, 8).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(r)}
            className={`flex items-center gap-3 rounded-md px-2 py-1 text-left text-[11px] hover:bg-[hsl(var(--surface-sunken))] ${r.id === activeId ? 'bg-[hsl(var(--surface-sunken))]' : ''}`}
          >
            <StatusDot status={r.status} />
            <span className="font-mono">{r.profileId}</span>
            <span className="text-muted-foreground">并发 {r.config.concurrency} × {r.targets.length} 落点 · {r.config.durationSec}s</span>
            <span className="ml-auto text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
