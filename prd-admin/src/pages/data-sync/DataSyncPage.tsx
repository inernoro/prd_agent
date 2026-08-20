import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, Database, KeyRound, ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { PageHeader } from '@/components/design/PageHeader';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { useSseStream } from '@/lib/useSseStream';
import { DATA_SYNC_PENDING_KEY } from './DataSyncCallbackPage';

/**
 * 从另一台 MAP 同步数据（目标站视角）。
 *
 * 四步一屏走完：填源站 → 跳过去授权 → 回来看对照表 → 确认执行。对照表那一步不能省，
 * 它是操作者唯一一次看清「要往哪个库写、源站多少条、本地现在多少条」的机会——
 * 分支预览共享同一个数据库，写下去同库的其它分支立刻看得见。
 */

type PlanRow = {
  collection: string;
  group: string | null;
  sourceTotal: number;
  localTotal: number;
  redactFields: string[];
};
type Plan = { runId: string; sourceLabel: string; sourceOrigin: string; targetDatabase: string; rows: PlanRow[] };
type ProgressRow = {
  collection: string;
  sourceTotal: number;
  fetched: number;
  inserted: number;
  skipped: number;
  updated: number;
  done: boolean;
};
type RunView = {
  runId: string;
  status: string;
  sourceLabel: string;
  sourceOrigin: string;
  groups: string[];
  collections: string[];
  dryRun: boolean;
  overwriteExisting: boolean;
  error: string | null;
  pendingSecretFields: Record<string, string[]>;
  progress: ProgressRow[];
};

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export default function DataSyncPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get('run') || '';

  const [sourceOrigin, setSourceOrigin] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const applyRun = useCallback((data: unknown) => {
    setRun(data as RunView);
  }, []);

  const sse = useSseStream({
    url: runId ? `/api/data-sync/runs/${encodeURIComponent(runId)}/stream` : '',
    onEvent: { progress: applyRun, done: applyRun },
    onError: (message) => setError(message),
  });

  // 进来先把这条 Run 的当前状态取回来：SSE 只推「之后的变化」，
  // 刷新页面时没有这一步会先看到一片空白。
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    void apiRequest<RunView>(`/api/data-sync/runs/${encodeURIComponent(runId)}`).then((res) => {
      if (!alive) return;
      if (res.success && res.data) setRun(res.data);
      else setError(res.error?.message || '读取同步记录失败');
    });
    return () => {
      alive = false;
    };
  }, [runId]);

  // pending 阶段拉对照表；已经在跑或跑完就不用了。
  useEffect(() => {
    if (!runId || !run || run.status !== 'pending' || plan) return;
    let alive = true;
    void apiRequest<Plan>(`/api/data-sync/runs/${encodeURIComponent(runId)}/plan`).then((res) => {
      if (!alive) return;
      if (res.success && res.data) setPlan(res.data);
      else setError(res.error?.message || '读取同步对照表失败');
    });
    return () => {
      alive = false;
    };
  }, [runId, run, plan]);

  useEffect(() => {
    if (!runId || !run) return;
    if (run.status === 'running' && !sse.isStreaming) void sse.start();
    // 依赖只放状态与 id：把 sse 整个对象放进来会每次渲染都重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, run?.status]);

  const totals = useMemo(() => {
    if (!run) return { fetched: 0, inserted: 0, skipped: 0, updated: 0, total: 0, doneCount: 0 };
    return run.progress.reduce(
      (acc, row) => ({
        fetched: acc.fetched + row.fetched,
        inserted: acc.inserted + row.inserted,
        skipped: acc.skipped + row.skipped,
        updated: acc.updated + row.updated,
        total: acc.total + row.sourceTotal,
        doneCount: acc.doneCount + (row.done ? 1 : 0),
      }),
      { fetched: 0, inserted: 0, skipped: 0, updated: 0, total: 0, doneCount: 0 },
    );
  }, [run]);

  async function prepare() {
    setPreparing(true);
    setError('');
    const res = await apiRequest<{ authorizeUrl: string; state: string; sourceOrigin: string }>(
      '/api/data-sync/runs/prepare',
      { method: 'POST', body: { sourceOrigin } },
    );
    setPreparing(false);
    if (!res.success || !res.data?.authorizeUrl) {
      setError(res.error?.message || '无法生成授权链接');
      return;
    }
    sessionStorage.setItem(
      DATA_SYNC_PENDING_KEY,
      JSON.stringify({ state: res.data.state, sourceOrigin: res.data.sourceOrigin }),
    );
    window.location.href = res.data.authorizeUrl;
  }

  async function start(dryRun: boolean) {
    setBusy(true);
    setError('');
    const res = await apiRequest<{ runId: string }>(
      `/api/data-sync/runs/${encodeURIComponent(runId)}/start`,
      { method: 'POST', body: { dryRun, overwrite } },
    );
    setBusy(false);
    if (!res.success) {
      setError(res.error?.message || '启动失败');
      return;
    }
    setRun((prev) => (prev ? { ...prev, status: 'running', dryRun, overwriteExisting: overwrite } : prev));
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="数据同步"
        subtitle="从另一台 MAP 实例拉一次数据。授权是一次性的：跳过去、对方同意、执行一次。"
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 sm:px-4" style={{ overscrollBehavior: 'contain' }}>
        {error ? (
          <div
            className="mb-4 flex items-start gap-2 rounded-xl px-4 py-3 text-sm"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--danger)' }}
            role="alert"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!runId ? (
          <StartCard
            sourceOrigin={sourceOrigin}
            setSourceOrigin={setSourceOrigin}
            preparing={preparing}
            onSubmit={() => void prepare()}
          />
        ) : !run ? (
          <MapSectionLoader text="正在读取同步记录…" />
        ) : run.status === 'pending' ? (
          plan ? (
            <PlanCard
              plan={plan}
              overwrite={overwrite}
              setOverwrite={setOverwrite}
              busy={busy}
              onStart={start}
            />
          ) : (
            <MapSectionLoader text="正在向源站清点数据…" />
          )
        ) : (
          <ProgressCard run={run} totals={totals} onBack={() => setSearchParams({})} />
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="rounded-2xl p-5"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
    >
      {children}
    </section>
  );
}

function StartCard({
  sourceOrigin,
  setSourceOrigin,
  preparing,
  onSubmit,
}: {
  sourceOrigin: string;
  setSourceOrigin: (v: string) => void;
  preparing: boolean;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <ArrowRightLeft size={18} style={{ color: 'var(--accent-primary)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>选择源站</h2>
      </div>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        填另一台 MAP 的站点地址。点下面的按钮会跳到那台机器上，由它的管理员当场勾选给哪些数据；
        同意之后浏览器会自己回到这里。对方没有把本站加进允许名单的话，跳过去会被拒绝。
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={sourceOrigin}
          onChange={(e) => setSourceOrigin(e.target.value)}
          placeholder="https://map.example.com"
          className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-secondary)',
            color: 'var(--text-primary)',
          }}
        />
        <button
          type="button"
          disabled={preparing || sourceOrigin.trim().length === 0}
          onClick={onSubmit}
          className="flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
        >
          {preparing ? <MapSpinner size={14} /> : <ExternalLink size={16} />}
          前往源站授权
        </button>
      </div>
    </Card>
  );
}

function PlanCard({
  plan,
  overwrite,
  setOverwrite,
  busy,
  onStart,
}: {
  plan: Plan;
  overwrite: boolean;
  setOverwrite: (v: boolean) => void;
  busy: boolean;
  onStart: (dryRun: boolean) => Promise<void>;
}) {
  const sourceTotal = plan.rows.reduce((s, r) => s + r.sourceTotal, 0);
  const localTotal = plan.rows.reduce((s, r) => s + r.localTotal, 0);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-2">
          <Database size={18} style={{ color: 'var(--accent-primary)' }} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>执行前对照</h2>
        </div>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          源站 <span style={{ color: 'var(--text-primary)' }}>{plan.sourceLabel || plan.sourceOrigin}</span> 共
          {' '}{sourceTotal} 条，本地对应集合现有 {localTotal} 条。数据会写进数据库
          {' '}<span className="font-mono" style={{ color: 'var(--text-primary)' }}>{plan.targetDatabase}</span>
          ——这个库由本项目的所有分支预览共用，写进去同库的其它分支立刻可见。
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="py-2 font-normal">集合</th>
                <th className="py-2 text-right font-normal">源站</th>
                <th className="py-2 text-right font-normal">本地现有</th>
                <th className="py-2 pl-4 font-normal">出口清空的字段</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((row) => (
                <tr key={row.collection} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>{row.collection}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>{row.sourceTotal}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{row.localTotal}</td>
                  <td className="py-1.5 pl-4" style={{ color: 'var(--text-muted)' }}>
                    {row.redactFields.length > 0 ? row.redactFields.join(' / ') : '无'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <label className="flex items-start gap-3 text-sm" style={{ color: 'var(--text-primary)' }}>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span>
            以源站为准覆盖本地同 ID 的记录
            <span className="mt-1 block text-xs" style={{ color: 'var(--text-muted)' }}>
              默认不勾：只新增本地没有的记录，本地已有的原样保留。勾上之后本地对这些记录的改动会被源站版本盖掉。
            </span>
          </span>
        </label>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStart(true)}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          >
            {busy ? <MapSpinner size={14} /> : null}
            先试跑（只统计，不写库）
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStart(false)}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
          >
            {busy ? <MapSpinner size={14} /> : <ArrowRightLeft size={16} />}
            开始同步
          </button>
        </div>
      </Card>
    </div>
  );
}

function ProgressCard({
  run,
  totals,
  onBack,
}: {
  run: RunView;
  totals: { fetched: number; inserted: number; skipped: number; updated: number; total: number; doneCount: number };
  onBack: () => void;
}) {
  const finished = TERMINAL.has(run.status);
  const pendingSecrets = Object.entries(run.pendingSecretFields || {});
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {finished && run.status === 'succeeded' ? (
              <CheckCircle2 size={18} style={{ color: 'var(--success)' }} />
            ) : finished ? (
              <AlertTriangle size={18} style={{ color: 'var(--danger)' }} />
            ) : (
              <MapSpinner size={18} />
            )}
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {run.dryRun ? '试跑' : '同步'}
              {run.status === 'running' ? '进行中' : run.status === 'succeeded' ? '完成' : run.status === 'failed' ? '失败' : run.status}
            </h2>
          </div>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            来自 {run.sourceLabel || run.sourceOrigin} · 已完成 {totals.doneCount}/{run.collections.length} 个集合
          </span>
        </div>

        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          已拉取 {totals.fetched} 条
          {run.dryRun
            ? `，其中 ${totals.skipped} 条本地已存在（试跑不写库）`
            : `，新增 ${totals.inserted} 条、跳过 ${totals.skipped} 条${run.overwriteExisting ? `、覆盖 ${totals.updated} 条` : ''}`}
          。
        </p>
        {run.error ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{run.error}</p>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="py-2 font-normal">集合</th>
                <th className="py-2 text-right font-normal">已拉取</th>
                <th className="py-2 text-right font-normal">新增</th>
                <th className="py-2 text-right font-normal">跳过</th>
                <th className="py-2 text-right font-normal">状态</th>
              </tr>
            </thead>
            <tbody>
              {run.progress.map((row) => (
                <tr key={row.collection} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>{row.collection}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>{row.fetched}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>{row.inserted}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{row.skipped}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                    {row.done ? '完成' : '进行中'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {pendingSecrets.length > 0 ? (
        <Card>
          <div className="flex items-center gap-2">
            <KeyRound size={18} style={{ color: 'var(--accent-primary)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>待补密钥</h2>
          </div>
          <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            下面这些字段在源站出口就被清空了，同步过来是空的，需要在本站手工填一遍才能用。
            没填之前，相关平台的调用会失败而不是静默降级。
          </p>
          <ul className="mt-3 space-y-1 text-xs">
            {pendingSecrets.map(([collection, fields]) => (
              <li key={collection} className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{collection}</span>
                <span style={{ color: 'var(--text-muted)' }}>{fields.join(' / ')}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {finished ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg px-4 py-2 text-sm"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
        >
          再同步一次（需要重新授权）
        </button>
      ) : null}
    </div>
  );
}
