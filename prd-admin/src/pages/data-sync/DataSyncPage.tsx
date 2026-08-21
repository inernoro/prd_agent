import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, Database, KeyRound, ExternalLink, AlertTriangle, CheckCircle2, ShieldCheck, X } from 'lucide-react';

import { PageHeader } from '@/components/design/PageHeader';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { useSseStream } from '@/lib/useSseStream';
import { stashPendingAuthorization } from './DataSyncCallbackPage';
import { createSerializedSaver } from './serializedSave';
import { computePlanTotals, describeTotal } from './planTotals';

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
  /** 源站有没有报告这个集合。false = 本站批准了，但源站那边没有它。 */
  sourceReported?: boolean;
  /** 本站白名单认不认识它。false = 源站有、本站版本还不支持，不会同步。 */
  supportedHere?: boolean;
};
type ProviderSettings = {
  /** 生效值（开关为真且名单非空）——界面显示这个。 */
  enabled: boolean;
  /** 库里原样存着的开关——并发比对送这个。两者只在「名单空了」那一格不同。 */
  storedEnabled: boolean;
  origins: string[];
  siteLabel: string;
};
type Plan = { runId: string; sourceLabel: string; sourceOrigin: string; targetDatabase: string; rows: PlanRow[] };
type ProgressRow = {
  collection: string;
  sourceTotal: number;
  fetched: number;
  inserted: number;
  skipped: number;
  updated: number;
  plannedInsert: number;
  plannedUpdate: number;
  done: boolean;
};
type RunView = {
  runId: string;
  status: string;
  sourceLabel: string;
  sourceOrigin: string;
  groups: string[];
  collections: string[];
  plannedCollections?: string[];
  dryRun: boolean;
  overwriteExisting: boolean;
  error: string | null;
  pendingSecretFields: Record<string, string[]>;
  progress: ProgressRow[];
  createdAt?: string;
  finishedAt?: string | null;
};

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export default function DataSyncPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get('run') || '';

  const [sourceOrigin, setSourceOrigin] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [probe, setProbe] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<RunView[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);

  const applyRun = useCallback((data: unknown) => {
    setRun(data as RunView);
  }, []);

  const sse = useSseStream({
    url: runId ? `/api/instance-sync/runs/${encodeURIComponent(runId)}/stream` : '',
    onEvent: { progress: applyRun, done: applyRun },
    onError: (message) => setError(message),
  });

  // 起始屏拉一次历史。两个理由：一是这一屏只有一个输入框，下面整片留白
  //（content-fills-canvas）；二是「上次从哪台机器同步的」本来就是系统知道的事，
  // 不该让操作者自己去记地址再手打一遍（minimal-user-input）。
  useEffect(() => {
    if (runId) return;
    let alive = true;
    void apiRequest<RunView[]>('/api/instance-sync/runs').then((res) => {
      if (!alive) return;
      // 非管理员在这一屏什么也做不了。与其让他填完地址、点了按钮才被拒，
      // 不如进来就说清楚——这一次请求同时充当了权限探针。
      if (!res.success && res.error?.code === 'DATA_SYNC_ADMIN_REQUIRED') {
        setDenied(true);
        setHistory([]);
        return;
      }
      setHistory(res.success && Array.isArray(res.data) ? res.data : []);
    });
    return () => {
      alive = false;
    };
  }, [runId]);

  // 本站作为「源站」的设置。同意页只会往名单里加，这里是唯一能撤销的地方。
  useEffect(() => {
    if (runId) return;
    let alive = true;
    void apiRequest<ProviderSettings>('/api/instance-sync/provider-settings').then((res) => {
      if (!alive) return;
      if (res.success && res.data) setProvider(res.data);
    });
    return () => {
      alive = false;
    };
  }, [runId]);

  // 这张卡的每次改动都是「整份名单覆盖写」，所以两次连点必须串起来算。
  // 原来传的是算好的 next，两个回调都基于同一份没变过的 settings：先移除 A 发出
  // 的清单里还留着 B，再移除 B 发出的清单里又留着 A，后到的那次把已撤销的机器
  // 放了回去——而票据鉴权每次都读这份名单，等于撤销被悄悄取消了。
  // 改成传「怎么改」，由这里对着最新的一份算，并在保存期间禁用输入。
  const providerRef = useRef<ProviderSettings | null>(null);
  useEffect(() => { providerRef.current = provider; }, [provider]);

  // 串行化逻辑抽在 serializedSave.ts，那里有脱开 React 的回归测试钉住
  // 「第二次改动必须看到第一次的结果」这个不变量。
  const savingProviderRef = useRef(false);
  const saveProvider = useMemo(
    () =>
      createSerializedSaver<ProviderSettings>({
        getLatest: () => providerRef.current,
        commit: (value) => {
          setProvider(value);
          providerRef.current = value;
        },
        persist: async (value, base) => {
          // 带上「我看到的那份名单」。串行化只挡住了本页两次连点，挡不住另一个
          // 管理员同时在改——后到的整份覆盖会把对方刚移走的机器放回来，而票据鉴权
          // 每次都读这份活名单，等于一次撤销被悄悄取消。服务端按它做条件更新，
          // 对不上就回 409，这里把最新的那份拉回来让人重看一眼。
          const res = await apiRequest<ProviderSettings>('/api/instance-sync/provider-settings', {
            method: 'PUT',
            body: {
              enabled: value.enabled,
              origins: value.origins,
              expectedOrigins: base.origins,
              expectedEnabled: base.storedEnabled,
            },
          });
          if (!res.success && res.error?.code === 'DATA_SYNC_SETTINGS_STALE') {
            const latest = await apiRequest<ProviderSettings>('/api/instance-sync/provider-settings');
            return {
              ok: false,
              confirmed: latest.success ? latest.data ?? undefined : undefined,
              error: res.error?.message,
            };
          }
          return { ok: res.success, confirmed: res.data ?? undefined, error: res.error?.message };
        },
        setBusy: (busy) => {
          savingProviderRef.current = busy;
          setSavingProvider(busy);
        },
        isBusy: () => savingProviderRef.current,
        onError: setError,
        fallbackErrorMessage: '保存对外同步设置失败',
      }),
    [],
  );

  // 进来先把这条 Run 的当前状态取回来：SSE 只推「之后的变化」，
  // 刷新页面时没有这一步会先看到一片空白。
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    void apiRequest<RunView>(`/api/instance-sync/runs/${encodeURIComponent(runId)}`).then((res) => {
      if (!alive) return;
      if (res.success && res.data) setRun(res.data);
      else setError(res.error?.message || '读取同步记录失败');
    });
    return () => {
      alive = false;
    };
  }, [runId]);

  // 换了一条 Run 就把上一条的对照表丢掉。
  //
  // 这个组件在历史列表与详情之间来回切时是**不卸载**的，plan 会留在上一条 Run 上。
  // 而下面那个 effect 的 `|| plan` 又会因此判定「已经有了，不用拉」——于是屏幕上
  // 显示的是 A 的源站、条数、集合清单，按下开始却是拿 B 去跑。操作者是照着这一屏
  // 做决定的，给他看错的那份比不给更糟。
  useEffect(() => {
    setPlan(null);
  }, [runId]);

  // pending 阶段拉对照表；已经在跑或跑完就不用了。
  useEffect(() => {
    if (!runId || !run || run.status !== 'pending' || plan) return;
    let alive = true;
    void apiRequest<Plan>(`/api/instance-sync/runs/${encodeURIComponent(runId)}/plan`).then((res) => {
      if (!alive) return;
      if (res.success && res.data) setPlan(res.data);
      else setError(res.error?.message || '读取同步对照表失败');
    });
    return () => {
      alive = false;
    };
  }, [runId, run, plan]);

  // 断流重连的退避计数。用 ref 而不是 state：它只影响下一次何时重试，
  // 不该触发渲染，更不该进依赖数组。
  const reconnectAttempt = useRef(0);
  // 快照请求也失败时靠它把 effect 再踢一次——ref 不触发重渲染，单靠它排不了下一轮。
  const [reconnectTick, setReconnectTick] = useState(0);

  useEffect(() => {
    if (!runId || !run) return;
    if (run.status !== 'running') {
      reconnectAttempt.current = 0;
      return;
    }
    if (sse.isStreaming) {
      reconnectAttempt.current = 0;
      return;
    }

    // 走到这里 = 「Run 还在跑，但这条流没了」。原来这个 effect 只依赖 id 与 status，
    // 于是网络或代理抖一下把流掐断之后，status 一直是 running、effect 再也不会重跑，
    // 页面就永久停在最后一帧——而同步其实还在后台推进。服务端那 10 秒心跳只解决了
    // 「不被空闲超时掐断」，掐断之后由谁重连是另一半（server-authority #4）。
    const attempt = reconnectAttempt.current;
    reconnectAttempt.current = attempt + 1;
    const delay = attempt === 0 ? 0 : Math.min(1000 * 2 ** (attempt - 1), 15000);

    const timer = window.setTimeout(() => {
      // 先补一次快照再重连。理由：终态是靠流推过来的，流要是一直连不上，
      // 光重连会在一个早已结束的 Run 上无限重试；这一次 GET 能把终态取回来，
      // 顺带把断流期间攒下的进度补齐。
      void apiRequest<RunView>(`/api/instance-sync/runs/${encodeURIComponent(runId)}`).then((res) => {
        if (!res.success || !res.data) {
          // 这一枪也打空了（网络还没恢复）。必须显式安排下一次——直接 return 的话
          // status / phase 都没变，这个 effect 再也不会跑，页面就永久冻在这里了。
          // 退避计数已经加过，所以下一次会自然拉长间隔。
          setReconnectTick((t) => t + 1);
          return;
        }
        setRun(res.data);
        if (res.data.status === 'running') void sse.start();
      });
    }, delay);

    return () => window.clearTimeout(timer);
    // sse 整个对象每次渲染都是新的，不能进依赖；只取真正会变的那几个标志。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, run?.status, sse.isStreaming, sse.phase, reconnectTick]);

  const totals = useMemo(() => {
    if (!run) return { fetched: 0, inserted: 0, skipped: 0, updated: 0, plannedInsert: 0, plannedUpdate: 0, total: 0, doneCount: 0 };
    return run.progress.reduce(
      (acc, row) => ({
        fetched: acc.fetched + row.fetched,
        inserted: acc.inserted + row.inserted,
        plannedInsert: acc.plannedInsert + row.plannedInsert,
        plannedUpdate: acc.plannedUpdate + row.plannedUpdate,
        skipped: acc.skipped + row.skipped,
        updated: acc.updated + row.updated,
        total: acc.total + row.sourceTotal,
        doneCount: acc.doneCount + (row.done ? 1 : 0),
      }),
      { fetched: 0, inserted: 0, skipped: 0, updated: 0, plannedInsert: 0, plannedUpdate: 0, total: 0, doneCount: 0 },
    );
  }, [run]);

  async function prepare() {
    setPreparing(true);
    setError('');
    setProbe('');
    // 服务端在生成授权链接之前会先跟对方握一次手（站点名 / 协议版本 / 构建号），
    // 版本对不上就直接回错误——所以走到这一步说明版本已经核过了。
    const res = await apiRequest<{
      authorizeUrl: string;
      state: string;
      sourceOrigin: string;
      sourceLabel?: string | null;
      sourceBuild?: string | null;
    }>('/api/instance-sync/runs/prepare', { method: 'POST', body: { sourceOrigin } });
    if (!res.success || !res.data?.authorizeUrl) {
      setPreparing(false);
      setError(res.error?.message || '无法生成授权链接');
      return;
    }
    const label = (res.data.sourceLabel || '').trim() || res.data.sourceOrigin;
    const build = (res.data.sourceBuild || '').trim();
    // 别让跳转是一次无声的闪现：把「握到的是谁、版本对得上」说出来再走。
    setProbe(`已确认对方是 ${label}${build ? `（构建 ${build}）` : ''}，协议版本一致，正在跳转授权…`);
    stashPendingAuthorization(res.data.state, {
      state: res.data.state,
      sourceOrigin: res.data.sourceOrigin,
      sourceLabel: label,
    });
    window.setTimeout(() => { window.location.href = res.data.authorizeUrl; }, 900);
  }

  async function start(dryRun: boolean) {
    setBusy(true);
    setError('');
    const res = await apiRequest<{ runId: string }>(
      `/api/instance-sync/runs/${encodeURIComponent(runId)}/start`,
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

      {/* 外层只负责滚动，内层 min-h-full 让起始屏的历史卡撑满剩余空间（content-fills-canvas）。
          底部留白放在内层：min-h-full 与 padding 同在一个 border-box 里才不会多出 24px 的空滚动。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 sm:px-4" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex min-h-full flex-col gap-4 pb-6">
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

        {denied ? (
          <DeniedCard />
        ) : !runId ? (
          <>
            <StartCard
              sourceOrigin={sourceOrigin}
              setSourceOrigin={setSourceOrigin}
              preparing={preparing}
              probe={probe}
              onSubmit={() => void prepare()}
            />
            <ProviderCard settings={provider} busy={savingProvider} onSave={(mutate) => void saveProvider(mutate)} />
            <HistoryCard
              runs={history}
              onOpen={(id) => setSearchParams({ run: id })}
              onReuse={setSourceOrigin}
            />
          </>
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
  probe,
  onSubmit,
}: {
  sourceOrigin: string;
  setSourceOrigin: (v: string) => void;
  preparing: boolean;
  probe: string;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <ArrowRightLeft size={18} style={{ color: 'var(--accent-primary)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>选择源站</h2>
      </div>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        填另一台 MAP 的站点地址。点下面的按钮会先跟对方核一次版本，再跳到那台机器上，
        由它的管理员登录后当场同意；同意之后浏览器会自己回到这里开始同步。
        本站还不在对方的允许名单里也没关系，对方管理员可以在同意页上当场准入。
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
      {probe && (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {probe}
        </p>
      )}
    </Card>
  );
}

/** 非管理员进到这一屏时的说明。后端每个端点都会 403，这里只是把原因提前讲出来。 */
function DeniedCard() {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <KeyRound size={18} style={{ color: 'var(--accent-primary)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>需要管理员权限</h2>
      </div>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        跨实例同步会把另一台机器上的数据写进本站的数据库，所以只有管理员能发起、也只有管理员能查看同步记录。
        需要同步的话，请找本站管理员操作。
      </p>
    </Card>
  );
}

/**
 * 本站作为「源站」时对外同步的开关与允许名单。
 *
 * 同意页上的「当场准入」只会往名单里加，这里是唯一能把一条拿掉的地方——
 * 一个只能追加的信任名单不是完整的信任管理，撤销比授予更需要看得见。
 */
function ProviderCard({
  settings,
  busy,
  onSave,
}: {
  settings: ProviderSettings | null;
  busy: boolean;
  /** 传「怎么改」而不是「改成什么」——调用方要对着最新的一份算，防连点覆盖。 */
  onSave: (mutate: (prev: ProviderSettings) => ProviderSettings) => void;
}) {
  if (!settings) return null;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} style={{ color: 'var(--accent-primary)' }} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>本站对外同步</h2>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => {
              const enabled = e.target.checked;
              onSave((prev) => ({ ...prev, enabled }));
            }}
            className="h-4 w-4"
          />
          允许别的 MAP 来本站取数据
        </label>
      </div>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        下面是已经允许过的机器。每次取数据仍然要本站管理员在同意页上当场勾选范围并同意，
        这份名单只决定「谁有资格来问」。
      </p>
      {settings.origins.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          名单是空的，等于对外同步关着。第一台机器跳过来时，在同意页上勾一次「我确认这台机器可信」即可加入。
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {settings.origins.map((origin) => (
            <span
              key={origin}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-mono"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-secondary)', color: 'var(--text-secondary)' }}
            >
              {origin}
              <button
                type="button"
                aria-label={`移除 ${origin}`}
                disabled={busy}
                onClick={() => onSave((prev) => ({ ...prev, origins: prev.origins.filter((o) => o !== origin) }))}
                style={{ color: 'var(--text-muted)', opacity: busy ? 0.5 : 1 }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Run 状态 -> 中文。列表和进度卡共用，避免两处各写一份枚举。 */
function statusLabel(status: string): string {
  if (status === 'pending') return '待确认';
  if (status === 'running') return '进行中';
  if (status === 'succeeded') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return status;
}

function formatWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * 历史同步。空着的时候不是「暂无数据」四个字，而是把这条链路的四步讲清楚——
 * 这一屏对第一次来的人是完全陌生的，跳去别人的机器上要授权这件事需要先建立预期。
 */
function HistoryCard({
  runs,
  onOpen,
  onReuse,
}: {
  runs: RunView[] | null;
  onOpen: (runId: string) => void;
  onReuse: (origin: string) => void;
}) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col rounded-2xl p-5"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
    >
      <div className="flex items-center gap-2">
        <Database size={18} style={{ color: 'var(--accent-primary)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>历史同步</h2>
        {runs && runs.length > 0 ? (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>最近 {runs.length} 次</span>
        ) : null}
      </div>

      {runs === null ? (
        <div className="mt-4"><MapSectionLoader text="正在读取历史记录…" /></div>
      ) : runs.length === 0 ? (
        <div className="mt-4 text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
          <p>还没有同步过。这条链路一共四步，每一步都停得下来：</p>
          <ol className="mt-3 space-y-1.5">
            {[
              '在上面填源站地址，点「前往源站授权」——浏览器跳到那台机器上。',
              '源站的管理员看到本站要哪些数据、哪些绝对不会带走，勾选后同意。',
              '跳回这里，先看对照表：往哪个库写、源站多少条、本地现在多少条。',
              '确认后执行。可以先「只试跑」，只统计不写库，看清楚了再来真的。',
            ].map((text, i) => (
              <li key={text} className="flex gap-2">
                <span
                  className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                  style={{ background: 'rgba(var(--accent-primary-rgb), 0.16)', color: 'var(--accent-primary)' }}
                >
                  {i + 1}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          {/*
            这句话必须和同意页的默认行为一致。同意页默认勾着「连登录口令一起给」，
            所以「口令一律留在源站」是假的——第一次用的人正是照着这句话建立预期的。
          */}
          <p className="mt-3" style={{ color: 'var(--text-secondary)' }}>
            各类密钥与访问令牌一律留在源站——同步过来是空的，需要在本站手动补。
            用户的登录口令散列是唯一的例外：源站管理员在同意页上默认勾着「连登录口令一起给」，
            勾着就一并搬过来，那些账号在这里用原密码就能登；他取消勾选的话，账号搬过来但要重设密码。
          </p>
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {runs.map((r) => {
            const rows = r.progress ?? [];
            const fetched = rows.reduce((s, p) => s + p.fetched, 0);
            // 试跑一条都没写库，就不能显示「写入 N 条」——那是把「打算写」说成「写了」。
            const written = r.dryRun
              ? rows.reduce((s, p) => s + p.plannedInsert + p.plannedUpdate, 0)
              : rows.reduce((s, p) => s + p.inserted + p.updated, 0);
            return (
              <div
                key={r.runId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <button
                  type="button"
                  onClick={() => onOpen(r.runId)}
                  className="min-w-0 flex-1 text-left text-sm"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <span className="truncate">{r.sourceLabel || r.sourceOrigin}</span>
                  {r.dryRun ? (
                    <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>试跑</span>
                  ) : null}
                </button>
                <span className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatWhen(r.createdAt)} · 拉取 {fetched} 条 · {r.dryRun ? '预计写入' : '写入'} {written} 条 · {statusLabel(r.status)}
                </span>
                <button
                  type="button"
                  onClick={() => onReuse(r.sourceOrigin)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-secondary)', color: 'var(--text-secondary)' }}
                >
                  再同步一次
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
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
  // 行里用 -1 当「数量未知」，直接求和会把它当成 -1 条真实数据——
  // 合计要么少算，要么在未知多的时候变成负数。判据抽在 planTotals.ts。
  const totals = computePlanTotals(plan.rows);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-2">
          <Database size={18} style={{ color: 'var(--accent-primary)' }} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>执行前对照</h2>
        </div>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          源站 <span style={{ color: 'var(--text-primary)' }}>{plan.sourceLabel || plan.sourceOrigin}</span> 共
          {' '}{describeTotal(totals.sourceTotal, totals.sourceUnknown)}，本地对应集合现有
          {' '}{describeTotal(totals.localTotal, totals.localUnknown)}。数据会写进数据库
          {' '}<span className="font-mono" style={{ color: 'var(--text-primary)' }}>{plan.targetDatabase}</span>
          ——这个库由本项目的所有分支预览共用，写进去同库的其它分支立刻可见。
        </p>

        {/*
          这一段不是免责声明，是把实际的一致性口径说出来。同步是逐页读的，源站在这期间
          仍然可写：中途新增的记录若排在游标前面就永远读不到，中途改过的记录读到的是旧值。
          做不到「一致快照」是当前实现的真实边界（台账 DS23），既然做不到，就不能让这一屏
          暗示它是一份完整快照——操作者有权在按下去之前知道这件事。
        */}
        <p className="mt-2 text-xs leading-6" style={{ color: 'var(--text-muted)' }}>
          这次同步是逐页读取，<span style={{ color: 'var(--text-secondary)' }}>不是一致性快照</span>：
          源站在同步期间仍可写入，中途新增的记录可能读不到、中途改过的记录可能读到旧值。
          需要精确一致时，请在源站空闲时段执行。
        </p>

        {plan.rows.some((r) => r.collection === 'users' && r.supportedHere !== false && r.sourceReported !== false) ? (
          // 账号搬过来时的身份冲突。本仓库 users.Username 上是**非唯一**索引，所以
          // 不会插入失败，而是留下两行同名用户——按用户名找人的地方一律 FirstOrDefault，
          // 拿到哪一个是不确定的。这条链路没有身份归并（见 DS18），所以只能在按下去
          // 之前把它说出来，而不是让人事后撞见。
          <p
            className="mt-3 rounded-lg px-3 py-2 text-xs leading-6"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-secondary)', color: 'var(--text-secondary)' }}
          >
            这次会同步 <span className="font-mono">users</span>。两边如果各自初始化过同名账号（比如都有 admin），
            同步后会出现两行同名用户——它们的用户 ID 不同，按用户名登录时拿到哪一个不确定。
            本站已有的那一行不会被改动；建议同步完先去用户列表确认一遍，把不用的那个改名或停用。
          </p>
        ) : null}

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
              {plan.rows.map((row) => {
                // 两种「列在表上但不会同步」的行，必须当场说清楚是哪一种。
                // 后端早就把这两个标记算出来了，之前没渲染——于是它们和正常行长得
                // 一模一样，只是两列数字变成 -1，看的人根本分不出来。
                const skipReason = row.sourceReported === false
                  ? '源站没有这个集合，不会同步'
                  : row.supportedHere === false
                    ? '本站版本还不认识它，不会同步'
                    : null;
                return (
                  <tr key={row.collection} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="py-1.5 font-mono" style={{ color: skipReason ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                      {row.collection}
                    </td>
                    <td className="py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>
                      {row.sourceTotal < 0 ? '—' : row.sourceTotal}
                    </td>
                    <td className="py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                      {row.localTotal < 0 ? '—' : row.localTotal}
                    </td>
                    <td className="py-1.5 pl-4" style={{ color: 'var(--text-muted)' }}>
                      {skipReason ?? (row.redactFields.length > 0 ? row.redactFields.join(' / ') : '无')}
                    </td>
                  </tr>
                );
              })}
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
  totals: {
    fetched: number; inserted: number; skipped: number; updated: number;
    plannedInsert: number; plannedUpdate: number; total: number; doneCount: number;
  };
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
              {statusLabel(run.status)}
            </h2>
          </div>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            来自 {run.sourceLabel || run.sourceOrigin} · 已完成 {totals.doneCount}/{(run.plannedCollections?.length || run.collections.length)} 个集合
          </span>
        </div>

        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          已拉取 {totals.fetched} 条
          {run.dryRun
            ? `，其中 ${totals.skipped} 条本地已存在；真跑将新增 ${totals.plannedInsert} 条${run.overwriteExisting ? `、覆盖 ${totals.plannedUpdate} 条` : ''}（试跑一条都没写库）`
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
                <th className="py-2 text-right font-normal">{run.dryRun ? '预计新增' : '新增'}</th>
                <th className="py-2 text-right font-normal">跳过</th>
                <th className="py-2 text-right font-normal">状态</th>
              </tr>
            </thead>
            <tbody>
              {run.progress.map((row) => (
                <tr key={row.collection} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>{row.collection}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>{row.fetched}</td>
                  <td className="py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>
                    {run.dryRun ? row.plannedInsert : row.inserted}
                  </td>
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
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {run.dryRun ? '真跑之后要补的密钥' : '待补密钥'}
            </h2>
          </div>
          {/*
            试跑一条都没写库，这些字段此刻在本站根本不存在。原来这段话不分真跑试跑，
            一律写「同步过来是空的，需要现在补」——会把人支去翻一批压根没导进来的记录。
            同「试跑不能把打算写记成写了」是同一条纪律，我上次只改了计数没改这里。
          */}
          <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            {run.dryRun
              ? '这是一次试跑，没有写库。下面这些字段在源站出口会被清空，等真跑之后需要在本站手工填一遍才能用——现在不用动。'
              : '下面这些字段在源站出口就被清空了，同步过来是空的，需要在本站手工填一遍才能用。没填之前，相关平台的调用会失败而不是静默降级。'}
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
