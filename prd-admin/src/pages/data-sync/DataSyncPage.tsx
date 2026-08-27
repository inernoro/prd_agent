import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, Database, KeyRound, ExternalLink, AlertTriangle, CheckCircle2, ImageOff, PlayCircle, ShieldCheck, X } from 'lucide-react';

import { PageHeader } from '@/components/design/PageHeader';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { useSseStream } from '@/lib/useSseStream';
import { stashPendingAuthorization } from './DataSyncCallbackPage';
import { createSerializedSaver } from './serializedSave';
import { computePlanTotals, describeTotal } from './planTotals';
import { shouldApplyRun } from './staleRunGuard';

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
  assetUrlsRebased?: number;
  assetUrlsUnresolved?: number;
  assetUrlsRelative?: number;
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
  promotedToRunId?: string | null;
  promotedFromRunId?: string | null;
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

  // 地址栏里当前那条 Run。用 ref 而不是闭包捕获：applyRun 要保持稳定
  //（它进了 useSseStream 的依赖），但又必须拿到**此刻**的 runId 来判断该不该收。
  const currentRunIdRef = useRef(runId);
  currentRunIdRef.current = runId;

  const applyRun = useCallback((data: unknown) => {
    const incoming = data as RunView;
    // 只收当前这条 Run 的事件。上一条流被 reset 断掉之后仍可能有一帧已经在管道里，
    // 收下它就是把 A 的进度画到 B 的地址下——比不更新更糟。判据在 staleRunGuard.ts，
    // 那里有脱开 React 的用例。
    if (!shouldApplyRun(incoming?.runId, currentRunIdRef.current)) return;
    setRun(incoming);
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

  // 换了一条 Run 就把上一条的运行态整组丢掉：对照表、Run 本身、覆盖开关、错误条。
  //
  // 这个组件在历史列表与详情之间来回切时是**不卸载**的，这几个 state 都会留在上一条
  // Run 上。上一版只清了 plan，剩下三个照样是 A 的：
  //   - `run` 没清 → B 的详情拉回来之前整屏显示 A 的状态与进度，B 的 GET 要是失败，
  //     就一直挂着 A 的那一屏，地址栏却是 B；
  //   - `overwrite` 没清 → 为 A 勾的「覆盖已存在的记录」原样留给 B，一按开始就是
  //     一次没人打算做的破坏性写入；
  //   - `error` 没清 → A 的报错挂在 B 头上。
  // 一次清一个是治不完的，因为漏掉哪个都不会红——所以这里按「运行态」整组清。
  //
  // 光清 state 还不够，A 那条 SSE 请求本身还连着：useSseStream 只在**组件卸载**时
  // abort，而这个页面在列表与详情之间来回切时一直挂着，url 变了它不会自己断。
  // 于是 A 的 progress 事件继续回调（把 A 画到 B 的地址下）、phase 一直是 streaming
  // （isStreaming 恒真 → 下面那个重连 effect 认为「已经在流了」，B 的流永远起不来）。
  // 所以这里用 reset() 而不是 abort()：abort 只断请求、phase 留在 streaming，
  // isStreaming 照样卡住；reset() 断请求**并**把 phase 归 idle。
  //
  // 为什么不去改 useSseStream 让它随 url 自动重连：那是七八个页面共用的 hook，
  // 改它的生命周期语义会波及全部调用方，超出本 PR 的边界。
  useEffect(() => {
    sse.reset();
    setPlan(null);
    setRun(null);
    setOverwrite(false);
    setError('');
    // sse 整个对象每次渲染都是新的，进依赖会每帧重置；reset 自身是稳定的 useCallback([])。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // 这一枪是替**哪条** Run 打的。请求一旦发出就收不回来（换 Run 时的 reset 只断 SSE，
    // 断不了这条 GET），所以回来时先认一认还是不是当前那条：
    //   - 不认的话 A 的快照会无条件盖掉 B 的 state；
    //   - 更糟的是下面那句 `sse.start()` 是**这次渲染的闭包**，url 里烤的是 A，
    //     一调就把 hook 拉回去流 A，B 的流从此起不来（和上一轮那个 reset 同一个病根）。
    const scheduledFor = runId;
    const timer = window.setTimeout(() => {
      // 先补一次快照再重连。理由：终态是靠流推过来的，流要是一直连不上，
      // 光重连会在一个早已结束的 Run 上无限重试；这一次 GET 能把终态取回来，
      // 顺带把断流期间攒下的进度补齐。
      void apiRequest<RunView>(`/api/instance-sync/runs/${encodeURIComponent(runId)}`).then((res) => {
        // 走掉了就整个丢掉：不 setRun、不排下一轮、更不 start 那条属于 A 的流。
        if (!shouldApplyRun(scheduledFor, currentRunIdRef.current)) return;
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

  /**
   * 试跑确认无误之后，就地转正成一次真跑。
   *
   * 原来这一步要人再跑一遍「跳过去让对方同意」——而试跑什么都没写，
   * 让它吃掉一次批准是没道理的。转正跑的是刚才那一屏冻结下来的**范围**，
   * 用的是同一张票，至多一次。**数据不冻结**：worker 会重新去源站拉，
   * 界面上那两段话如实说明了这一点，改这里记得一起改。
   */
  async function promote() {
    setBusy(true);
    setError('');
    const res = await apiRequest<{ runId: string }>(
      `/api/instance-sync/runs/${encodeURIComponent(runId)}/promote`,
      // 送**冻结的那个值**，不是页面上当前的勾选状态：转正执行的必须是刚才
      // 预览过的那一份。后端也会拒不一致的请求，这里对齐是为了别让用户撞那个错。
      { method: 'POST', body: { overwrite: run?.overwriteExisting ?? false } },
    );
    setBusy(false);
    if (!res.success) {
      setError(res.error?.message || '开始真的搬失败');
      return;
    }
    // 换到那条真跑上去看进度。
    setSearchParams({ run: res.data.runId });
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
          <ProgressCard
            run={run}
            totals={totals}
            busy={busy}
            onPromote={promote}
            onBack={() => setSearchParams({})}
          />
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
  busy,
  onPromote,
  onBack,
}: {
  run: RunView;
  totals: {
    fetched: number; inserted: number; skipped: number; updated: number;
    plannedInsert: number; plannedUpdate: number; total: number; doneCount: number;
  };
  busy: boolean;
  onPromote: () => void;
  onBack: () => void;
}) {
  const finished = TERMINAL.has(run.status);
  // 试跑跑完且成功、还没转正过 —— 这时候才该出现「开始真的搬」。
  const canPromote = finished && run.status === 'succeeded' && run.dryRun && !run.promotedToRunId;
  const pendingSecrets = Object.entries(run.pendingSecretFields || {});
  // 资产地址：改写了几条、几条认不出、几条本来就是相对路径。
  // 三个数字一起看才说得清「附件能不能打开」——少看第三个的后果是**整张卡不出现**：
  // 源站用本地磁盘存附件时，地址全是 `/local-assets/...`，前两个数恒为 0（DS30）。
  const assetsRebased = run.progress.reduce((n, row) => n + (row.assetUrlsRebased || 0), 0);
  const assetsUnresolved = run.progress.reduce((n, row) => n + (row.assetUrlsUnresolved || 0), 0);
  const assetsRelative = run.progress.reduce((n, row) => n + (row.assetUrlsRelative || 0), 0);
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

      {assetsRebased + assetsUnresolved + assetsRelative > 0 ? (
        <Card>
          <div className="flex items-center gap-2">
            <ImageOff size={18} style={{ color: 'var(--accent-primary)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              附件地址
            </h2>
          </div>
          {/*
            这一段必须同时说三件事，缺一件就变成误导：
            这次到底写没写库、地址改成了本站的（否则图片会指回源站）、**文件本身没有搬过来**。
            两站不共用同一个对象存储时，改完地址只是从「指回别人家」变成「指向自己家的空位」。

            **试跑必须用将来时。** 改写发生在入库之前、计数也在那时累加，但真正的写入整段
            包在 `if (!run.DryRun)` 里——试跑一条都没落库。原来这段话不分试跑真跑，一律写
            「已把 N 条改写成本站地址」「这次只搬了记录」，于是运维会以为附件此刻已经指向本站、
            点开就能看（Codex review P2）。这和上一轮修的密钥卡是同一条纪律的同一处漏网：
            打算做的事不能记成做过的事。
          */}
          <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            {/*
              「改写了 N 条」这一句要 N>0 才说。源站用本地磁盘存附件时 N 恒为 0，
              照说会得到「已把 0 条地址改写成本站地址…附件现在就能打开」——
              一句既没信息量又把人往反方向带的话（DS30）。
            */}
            {run.dryRun ? (
              <>
                这是一次试跑，<span style={{ color: 'var(--text-primary)' }}>一条记录都没有写进来</span>。
                {assetsRebased > 0 ? `真跑时会把 ${assetsRebased} 条附件地址改写成本站地址` : '真跑时不会有任何一条附件地址能改写成本站地址'}
                {assetsUnresolved > 0 ? `，另有 ${assetsUnresolved} 条认不出对象位置、会保留源站地址` : ''}
                。到时候也<span style={{ color: 'var(--text-primary)' }}>只搬记录，不搬文件本身</span>——
                两站用的是同一个对象存储时附件才打得开；不是同一个的话，需要另外把文件搬过来
                （或让两站指向同一个桶），否则会看到图片裂开。
              </>
            ) : (
              <>
                {assetsRebased > 0 ? `已把 ${assetsRebased} 条附件地址改写成本站地址` : '没有任何一条附件地址能改写成本站地址'}
                {assetsUnresolved > 0 ? `，另有 ${assetsUnresolved} 条认不出对象位置、保留了源站地址` : ''}
                。注意：<span style={{ color: 'var(--text-primary)' }}>这次只搬了记录，没有搬文件本身</span>。
                两站用的是同一个对象存储时，附件现在就能打开；不是同一个的话，需要另外把文件搬过来
                （或让两站指向同一个桶），否则会看到图片裂开。
              </>
            )}
          </p>
          {assetsUnresolved > 0 ? (
            <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
              那 {assetsUnresolved} 条多半是更早期、不带对象位置信息的旧附件——
              {run.dryRun ? '真跑之后它们的地址会仍然指向源站' : '它们的地址仍然指向源站'}，
              源站一旦下线就打不开。
            </p>
          ) : null}
          {/*
            相对地址这一档单独说，而且必须说得比另外两档更重。

            早先的判据把「已经是相对路径」读成「天然可移植」直接放行：既不改写、也不计数。
            可这两件事只在两站共享同一份磁盘时才等价，而跨实例同步的前提恰恰是两台不同的
            机器。源站用本地磁盘存附件的部署里，每一个附件链接都指向本站不存在的文件，
            而附件卡因为三个数全是 0 整个不出现——**一句提示都没有**（DS30）。

            这里不改写是因为确实无从改起：key 不在地址里，文件也没搬。能做的是别再静默。
          */}
          {assetsRelative > 0 ? (
            <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
              另有 <span style={{ color: 'var(--text-primary)' }}>{assetsRelative} 条是相对地址、
              而且没有记下对象位置</span>（形如 <code className="font-mono text-xs">/local-assets/…</code>），
              说明源站把附件存在<span style={{ color: 'var(--text-primary)' }}>它自己那台机器的磁盘上</span>，
              而这几条又是更早期、没留下位置信息的旧记录。
              这种地址改不了也用不了：本站磁盘上没有这些文件，
              {run.dryRun ? '真跑之后' : '现在'}点开就是 404。
              要让它们打开，得把源站那个目录里的文件复制到本站对应目录，
              或者两站都改用同一个对象存储再重新同步。
              （同样存在本地磁盘、但<span style={{ color: 'var(--text-primary)' }}>记下了</span>
              对象位置的那些，已经算进上面的「已改写」里了。）
            </p>
          ) : null}
        </Card>
      ) : null}

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

      {canPromote ? (
        <Card>
          <div className="flex items-center gap-2">
            <PlayCircle size={18} style={{ color: 'var(--accent-primary)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              试跑完了，要真的搬吗
            </h2>
          </div>
          {/*
            这一步以前要人再去源站点一次同意——而试跑什么都没写，让它吃掉一次批准
            是没道理的，真实迁移两次卡死在这里。现在同一次同意里就能接着搬。

            这段话原来写的是「真的搬只会照着它执行，不会重新去源站取一份新的」，
            **那是假的**：真跑复用的是试跑冻结下来的**范围**（哪些集合、多少条），
            数据本身由 worker 重新调源站的 /export 取，游标从头开始。试跑到转正之间
            源站改了的记录，搬过来的是改之后的值。系统没有存快照，也就给不出那个承诺
            （Codex review P1 第四轮）。

            改法是把话说回事实：承诺范围不变、授权不用再来一次，但明说数据是现取的。
            要做到「真的冻结」得给导出加快照或版本边界，那是另一件事，记在
            doc/debt.platform.cross-instance-data-sync.md。
          */}
          <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            上面这份定的是<span style={{ color: 'var(--text-primary)' }}>搬哪些内容</span>
            ——真的搬只按这个范围执行，不会多搬别的，用的还是刚才那次授权，不需要再跳过去同意一遍，
            这次授权只能这么用一次。
          </p>
          <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            但<span style={{ color: 'var(--text-primary)' }}>数据是现取的</span>：
            真的搬会重新去源站拉一遍这些集合。刚才到现在源站要是改过某条记录，搬过来的就是改之后的值，
            上面那些条数也可能对不上。要求两边完全一致的话，请确认这段时间源站没人在写。
          </p>
          {/*
            **这里不再给可改的勾选框。** 上面那些「预计新增 / 预计更新」和跳过数，
            全是按试跑那次的策略算出来的。转正时换成覆盖，那批「本来会跳过」的记录
            会被真的写掉，而这些写入一次都没被预览过——「确认无误再搬」就落了空
            （Codex review P1）。所以这里只把冻结的那个策略读出来，要改就重新试跑。
          */}
          <p className="mt-3 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            这次会沿用试跑时的策略：
            <span style={{ color: 'var(--text-primary)' }}>
              {run.overwriteExisting
                ? '本地已有的同一条记录，用源站的覆盖掉'
                : '本地已有的同一条记录跳过，只补新的'}
            </span>
            。上面的预计条数就是按它算的；要换策略，请带着新策略重新试跑一次，看过新的对照表再来。
          </p>
          <button
            type="button"
            onClick={onPromote}
            disabled={busy}
            className="mt-4 rounded-lg px-4 py-2 text-sm font-medium"
            // 主按钮走 button-primary 这对 token，不要拿 accent 底自己配前景色。
            // 原来写的是 `--accent-primary` 配 `var(--accent-on-primary, #fff)`：
            // 那个 fallback 的 `#fff` 是写死的浅色，accent 底上对比度只有 3.12:1，
            // 而且一旦这块翻成浅色主题，字直接消失——双皮肤棘轮拦下的就是这个。
            style={{
              background: 'var(--button-primary-bg)',
              color: 'var(--button-primary-fg)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? '正在开始…' : '确认无误，开始真的搬'}
          </button>
        </Card>
      ) : null}

      {run.promotedToRunId ? (
        <Card>
          <p className="text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            这次试跑已经转正成一次真的搬。
          </p>
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
