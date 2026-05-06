import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Loader2, Pin, PinOff, RefreshCw, Sparkles, X } from 'lucide-react';

/*
 * GlobalUpdateBadge — 浮在屏幕左下角的全局 CDS 更新状态徽章。
 *
 * 用户反馈(2026-05-04):「点更新后看不出真的更新了没」「希望有活动部件告诉我
 * 更新中/完成/失败」「订阅了分支,该分支更新了在任何页面左下角弹出可以点击更新」。
 *
 * 这个组件挂在 AppShell,所有页面共享。原来 30s 一次轮询 /api/self-status 太重
 * (server 端 git fetch 卡顿)。改为事件驱动:订阅 SSE /api/self-status/stream,
 * 后端有事件主动推送;前端只在用户手动点刷新或 SSE 不可用降级时才发请求。
 *
 * 状态机仍是原来的 5 种:
 *
 *   1. ✓ idle       — 正常,徽章隐藏(不打扰)
 *   2. ↑ updateAvail — 该分支 GitHub 远端有 N 个新 commit(订阅意义)
 *                      点击 → 跳 /cds-settings → 维护
 *   3. ⌛ restarting — SSE 断开 / CDS 在重启
 *                      显示 spinner,等 onopen 自动恢复
 *   4. ✓ updated     — headSha 与页面打开时不同(后端真换版本了)
 *                      点击 → 强制 reload 页面加载新 bundle
 *   5. ⚠ bundleStale — 后端 SHA != web bundle SHA(build_web 静默失败的征兆)
 *                      显示 warning,点击查看排错
 *
 * 视觉:64px 圆形徽章,左下角悬浮(z-50),hover 展开成横向 chip 显示文字。
 * 关闭按钮短期 dismiss(sessionStorage,刷新页面再出现)。
 */

interface SelfStatusLite {
  currentBranch?: string;
  headSha?: string;
  remoteAheadCount?: number;
  remoteAheadSubjects?: Array<{ sha: string; subject: string; date: string }>;
  bundleStale?: boolean;
  webBuildSha?: string;
  lastSelfUpdate?: { ts: string; status: string; toSha?: string } | null;
}

type BadgeState =
  | { kind: 'idle' }
  | { kind: 'updated'; fromSha: string; toSha: string }
  | { kind: 'updateAvailable'; count: number; firstSubject?: string }
  | { kind: 'restarting'; sinceMs: number }
  | { kind: 'bundleStale'; backendSha: string; bundleSha: string };

const DISMISS_KEY = 'cds:global-update-badge:dismissed-until';
// SSE 不可用时的降级轮询间隔。比原来的 30s 更长 — 已经是兜底方案,主路径走 SSE。
const FALLBACK_POLL_INTERVAL_MS = 60_000;
// 连续 N 次 onerror 且累积超过 30s 仍未 onopen,判定 SSE 不可用,启动降级。
const SSE_FAIL_THRESHOLD_COUNT = 3;
const SSE_FAIL_THRESHOLD_MS = 30_000;

export function GlobalUpdateBadge(): JSX.Element | null {
  const [state, setState] = useState<BadgeState>({ kind: 'idle' });
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 同步 ref guard：防 rapid double-click 触发两次 fetch（React setState 是
  // batched，闭包里 `if (refreshing) return` 看到的是上一帧的值，第二次
  // click 进来时 setRefreshing(true) 还没生效，guard 形同虚设。useRef 是
  // mutable 即时生效的，不受 batching 影响。Bugbot Review 2026-05-06 bb22baea。
  const refreshingRef = useRef(false);
  const initialShaRef = useRef<string>('');
  const lastSuccessRef = useRef<SelfStatusLite | null>(null);

  // dismiss 短期:用户主动关掉徽章 → 接下来 1 小时不再显示(各 kind 独立,
  // 真发生新事件会再覆盖)。存 sessionStorage 标签关了就丢。
  const isDismissed = useCallback((kind: BadgeState['kind']): boolean => {
    if (kind === 'idle') return false;
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      const map = JSON.parse(raw) as Record<string, number>;
      return (map[kind] || 0) > Date.now();
    } catch {
      return false;
    }
  }, []);
  const dismiss = useCallback((kind: BadgeState['kind']): void => {
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      const map = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
      map[kind] = Date.now() + 60 * 60 * 1000; // 1h
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(map));
    } catch { /* sessionStorage might be disabled */ }
    setExpanded(false);
    setState({ kind: 'idle' });
  }, []);

  // 把 self-status payload 转成 BadgeState 的统一逻辑。
  // 三个调用方:SSE snapshot 事件 / SSE update 事件 / 手动刷新按钮。
  // 状态机优先级(高 → 低):
  //   1. SHA 变了 = 后端真换版本(updated)
  //   2. bundleStale = 前端比后端旧(build_web 静默失败)
  //   3. ahead > 0 = 远端有新 commit 可拉
  //   4. else idle
  const applyPayload = useCallback((payload: SelfStatusLite, source: 'snapshot' | 'update' | 'manual'): void => {
    lastSuccessRef.current = payload;

    // 第一次成功(snapshot 或 manual 首次):记录初始 SHA,作为"页面打开后是否换版本"的基线
    if (!initialShaRef.current && payload.headSha) {
      initialShaRef.current = payload.headSha;
    }

    if (initialShaRef.current && payload.headSha && payload.headSha !== initialShaRef.current) {
      setState({
        kind: 'updated',
        fromSha: initialShaRef.current,
        toSha: payload.headSha,
      });
      return;
    }
    if (payload.bundleStale && payload.headSha && payload.webBuildSha) {
      setState({
        kind: 'bundleStale',
        backendSha: payload.headSha,
        bundleSha: payload.webBuildSha.slice(0, 7),
      });
      return;
    }
    if ((payload.remoteAheadCount || 0) > 0) {
      setState({
        kind: 'updateAvailable',
        count: payload.remoteAheadCount || 0,
        firstSubject: payload.remoteAheadSubjects?.[0]?.subject,
      });
      return;
    }
    // 手动刷新得到 idle 时不要把已有的 restarting 等异常态盖掉 — 这里直接置 idle 即可,
    // 因为能拿到 200 payload 说明后端是活的。snapshot/update 同理。
    setState({ kind: 'idle' });
    void source; // 当前不需要按 source 分支处理,保留参数以便日后埋点
  }, []);

  // 手动刷新按钮:走老的 /api/self-status?probe=remote&force=1 当作一次 update 事件处理。
  const triggerManualRefresh = useCallback(async (): Promise<void> => {
    // ref guard 即时生效,先于 React batch；setRefreshing 只为驱动 UI 状态
    // (disabled / spin 动画),并发防护看 ref 不看 state。
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const ctrl = new AbortController();
      const timeoutId = window.setTimeout(() => ctrl.abort(), 10_000);
      const r = await fetch('/api/self-status?probe=remote&force=1', {
        credentials: 'include',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      window.clearTimeout(timeoutId);
      if (!r.ok) {
        // 主动刷新失败 → 视为 restarting,让用户感知 CDS 不太行
        setState({ kind: 'restarting', sinceMs: Date.now() });
        return;
      }
      const data = (await r.json()) as SelfStatusLite;
      applyPayload(data, 'manual');
    } catch {
      setState({ kind: 'restarting', sinceMs: Date.now() });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
    // 不再依赖 refreshing state（避免 stale closure 让 guard 失效）
  }, [applyPayload]);

  // SSE 订阅 + 失败降级到轮询。
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let fallbackTimer: number | null = null;
    let firstErrorAt = 0;
    let consecutiveErrors = 0;
    let fallbackActive = false;
    let fallbackSuccessCount = 0;
    // ⚠ Bugbot Review 2026-05-06 0005a515: fallback polling 启动后永远不再尝
    // 试 SSE,即使是临时网络/代理问题恢复了也只能等用户刷新页面。每 N 次成
    // 功 poll 后试着重连一次 SSE;失败会被 onerror 重新拉回 polling。
    const FALLBACK_POLLS_PER_SSE_RETRY = 5; // 5 * 60s = 5min 一次升级尝试

    const startFallbackPolling = (): void => {
      if (fallbackActive || cancelled) return;
      fallbackActive = true;
      fallbackSuccessCount = 0;
      // eslint-disable-next-line no-console
      console.warn('[GlobalUpdateBadge] SSE 不可用,降级到 60s 轮询');
      const tick = async (): Promise<void> => {
        if (cancelled) return;
        try {
          const r = await fetch('/api/self-status?probe=remote', {
            credentials: 'include',
            cache: 'no-store',
          });
          if (r.ok) {
            const data = (await r.json()) as SelfStatusLite;
            if (!cancelled) applyPayload(data, 'update');
            fallbackSuccessCount += 1;
          } else if (!cancelled) {
            setState({ kind: 'restarting', sinceMs: Date.now() });
          }
        } catch {
          if (!cancelled) setState({ kind: 'restarting', sinceMs: Date.now() });
        }
        if (cancelled) return;
        // 每 FALLBACK_POLLS_PER_SSE_RETRY 次成功 poll 后,试着重连 SSE。失败
        // 会触发 onerror,达到阈值后 onerror 内会再调 startFallbackPolling()
        // 把 fallback 重新拉起来 — 形成"polling ↔ SSE"自愈循环。
        if (fallbackSuccessCount >= FALLBACK_POLLS_PER_SSE_RETRY) {
          fallbackSuccessCount = 0;
          fallbackActive = false;
          fallbackTimer = null;
          // ⚠ Bugbot Review 2026-05-06 7eefcba6: 不重置 consecutiveErrors /
          // firstErrorAt 时,新 EventSource 的第一个 onerror 会用旧的(分钟级)
          // firstErrorAt 算 elapsed,瞬间超阈值 → 立刻又回 fallback,升级永远
          // 无效。这里清零让新 SSE 拿到完整的 30s × 3 次试错窗口。
          consecutiveErrors = 0;
          firstErrorAt = 0;
          // eslint-disable-next-line no-console
          console.info('[GlobalUpdateBadge] 尝试升级回 SSE 长连接');
          connect();
          return;
        }
        fallbackTimer = window.setTimeout(() => { void tick(); }, FALLBACK_POLL_INTERVAL_MS);
      };
      void tick();
    };

    const connect = (): void => {
      if (cancelled) return;
      try {
        es = new EventSource('/api/self-status/stream', { withCredentials: true });
      } catch {
        // 浏览器不支持 EventSource(极老 IE 等)→ 直接降级
        startFallbackPolling();
        return;
      }

      es.onopen = (): void => {
        // 连上了:重置失败计数,清掉 restarting(若有)
        consecutiveErrors = 0;
        firstErrorAt = 0;
        // 不直接清掉 state — 让 snapshot 事件来填充。这里只在恢复后给个 hint:
        // 若当前是 restarting,等下一条 snapshot/update 事件即可。
      };

      es.addEventListener('snapshot', (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as SelfStatusLite;
          applyPayload(data, 'snapshot');
        } catch {
          /* malformed payload, ignore */
        }
      });

      es.addEventListener('update', (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as SelfStatusLite;
          applyPayload(data, 'update');
        } catch {
          /* malformed payload, ignore */
        }
      });

      es.addEventListener('keepalive', () => {
        // ⚠ Bugbot Review 2026-05-06 fda43466: keepalive 到达本身证明连接活着,
        // 必须用来"反证"restarting。否则当服务端 computeSelfStatusPayload 异常
        // 被 try/catch 吞掉时,snapshot 事件永远不到,徽章会卡在 "CDS 不可达 Ns"。
        consecutiveErrors = 0;
        firstErrorAt = 0;
        setState((prev) => (prev.kind === 'restarting' ? { kind: 'idle' } : prev));
      });

      es.onerror = (): void => {
        // EventSource 断开 — 浏览器内置 3s 重试,不需要我们手动 reconnect。
        // 但要把 UI 切到 restarting,并累计失败次数判断是否需要降级。
        if (cancelled) return;
        const now = Date.now();
        if (consecutiveErrors === 0) firstErrorAt = now;
        consecutiveErrors += 1;
        setState({ kind: 'restarting', sinceMs: firstErrorAt || now });

        const elapsed = now - firstErrorAt;
        if (consecutiveErrors >= SSE_FAIL_THRESHOLD_COUNT && elapsed > SSE_FAIL_THRESHOLD_MS) {
          // 判定 SSE 不可用 — 关掉 EventSource,降级轮询
          if (es) {
            es.close();
            es = null;
          }
          startFallbackPolling();
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (es) es.close();
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };
  }, [applyPayload]);

  // restarting 状态下 1s 定时刷新让 "CDS 不可达 Ns" 计时秒数跳动。
  // elapsed 在 visualForState 里 render 时计算一次,组件本身不会因时间流逝
  // 自动 re-render — 这里 1s 一次轻量 setState 强制重渲染。
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (state.kind !== 'restarting') return;
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [state.kind]);

  // 立即更新(2026-05-04 UX 优化):updateAvailable 状态下角标 hover 直接给
  // "立即更新"按钮,POST /api/self-update 后 Badge 切到 restarting 状态。
  const [triggering, setTriggering] = useState(false);
  const triggerSelfUpdate = useCallback(async () => {
    if (triggering) return;
    setTriggering(true);
    const ctrl = new AbortController();
    // 5s 兜底:正常情况第一个 event 在毫秒级到达,5s 还没收到就当被中间件吞了
    const abortTimer = window.setTimeout(() => ctrl.abort(), 5000);
    try {
      const response = await fetch('/api/self-update', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        // body 必传 — handler `req.body` 在 json middleware 下,空 body 会被
        // 解析成 undefined,再解构 `const { branch }` 会抛 TypeError。空对象 OK。
        body: '{}',
        signal: ctrl.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // eslint-disable-next-line no-alert
        alert(`触发更新失败 (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
        return;
      }
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const idx = buffer.indexOf('\n\n');
          if (idx >= 0) {
            const block = buffer.slice(0, idx);
            const lines = block.split('\n');
            const eventName = lines.find((l) => l.startsWith('event: '))?.slice(7).trim();
            const dataRaw = lines.find((l) => l.startsWith('data: '))?.slice(6) || '';
            if (eventName === 'error') {
              let msg = '未知错误';
              try {
                const data = JSON.parse(dataRaw) as { message?: string; error?: string };
                msg = data.message || data.error || msg;
              } catch { /* keep default */ }
              // eslint-disable-next-line no-alert
              alert(`更新失败: ${msg}`);
              return;
            }
            // 第一个非 error event(typically 'step' status:'running')→ 触发已接受。
            // 立刻把 state → restarting,让用户当场看到 spinner,SSE 后续会推 update
            // 把状态切回正常。
            setState({ kind: 'restarting', sinceMs: Date.now() });
            ctrl.abort();
            return;
          }
        }
        if (done) break;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // 我们主动 abort,不当错
      // eslint-disable-next-line no-alert
      alert(`触发更新失败: ${(err as Error).message}`);
    } finally {
      window.clearTimeout(abortTimer);
      setTriggering(false);
    }
  }, [triggering]);

  // idle 或被 dismiss → 不渲染
  if (state.kind === 'idle' || isDismissed(state.kind)) return null;

  const visual = visualForState(state);

  // 用户反馈 2026-05-06:hover 离开瞬间徽章就收起,鼠标根本来不及划到
  // "立即更新" / "刷新" / "关闭" 这几个按钮 — 像走钢丝。改 hover-intent:
  // - 进入立即展开
  // - 离开延迟 280ms 才收起,中途再 enter 取消
  // - 已展开 + 点击 chip 主体 = 钉住(pinned),不再受 mouseLeave 影响
  //   (再点一次 unpin)
  const collapseTimerRef = useRef<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const handleEnter = useCallback(() => {
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setExpanded(true);
  }, []);
  const handleLeave = useCallback(() => {
    if (pinned) return;
    if (collapseTimerRef.current) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
      collapseTimerRef.current = null;
    }, 280);
  }, [pinned]);
  useEffect(() => () => {
    if (collapseTimerRef.current) window.clearTimeout(collapseTimerRef.current);
  }, []);

  return (
    <div
      className="fixed bottom-4 left-4 z-[200] select-none"
      style={{ pointerEvents: 'auto' }}
    >
      <div
        className={`flex items-stretch gap-0 overflow-hidden rounded-full border shadow-2xl transition-all duration-200 ${visual.borderClass} ${visual.bgClass} ${pinned ? 'ring-2 ring-amber-400/40' : ''}`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <button
          type="button"
          onClick={visual.onClick}
          className={`flex items-center gap-2 px-3 py-2 text-sm transition-colors ${visual.textClass} hover:bg-black/5 dark:hover:bg-white/5`}
          aria-label={visual.title}
          title={visual.title}
        >
          <span className="shrink-0">{visual.icon}</span>
          {expanded ? (
            <span className="whitespace-nowrap pr-1 text-xs font-medium">{visual.label}</span>
          ) : null}
        </button>
        {expanded && state.kind === 'updateAvailable' ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void triggerSelfUpdate();
            }}
            disabled={triggering}
            className="flex shrink-0 items-center gap-1 border-l border-current/20 bg-amber-500/10 px-3 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
            title="立即更新到最新版本"
          >
            {triggering ? '触发中…' : '立即更新'}
          </button>
        ) : null}
        {expanded ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void triggerManualRefresh();
            }}
            disabled={refreshing}
            className={`flex shrink-0 items-center justify-center px-2 ${visual.textClass} opacity-60 transition-opacity hover:opacity-100 disabled:opacity-40`}
            aria-label="立即检查远端更新"
            title="立即检查远端更新"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        ) : null}
        {expanded ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPinned((p) => !p);
            }}
            className={`flex shrink-0 items-center justify-center px-2 ${visual.textClass} ${pinned ? 'opacity-100' : 'opacity-60'} transition-opacity hover:opacity-100`}
            aria-label={pinned ? '取消钉住' : '钉住面板'}
            title={pinned ? '取消钉住(点击,鼠标移开会自动收起)' : '钉住面板(点击,鼠标移开也不收起)'}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        {expanded ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(state.kind);
            }}
            className={`flex shrink-0 items-center justify-center px-2 ${visual.textClass} opacity-60 transition-opacity hover:opacity-100`}
            aria-label="关闭提示"
            title="1 小时内不再提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function visualForState(state: Exclude<BadgeState, { kind: 'idle' }>): {
  icon: JSX.Element;
  label: string;
  title: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  onClick: () => void;
} {
  switch (state.kind) {
    case 'updated':
      return {
        icon: <CheckCircle2 className="h-4 w-4" />,
        label: `CDS 已更新 (${state.fromSha.slice(0, 7)} → ${state.toSha.slice(0, 7)}) · 点击刷新`,
        title: 'CDS 后端已切换到新版本,刷新页面加载新 UI',
        bgClass: 'bg-emerald-50 dark:bg-emerald-950/30',
        borderClass: 'border-emerald-500/40',
        textClass: 'text-emerald-700 dark:text-emerald-300',
        onClick: () => {
          window.location.reload();
        },
      };
    case 'updateAvailable':
      return {
        icon: <ArrowUpCircle className="h-4 w-4" />,
        label: state.firstSubject
          ? `GitHub 有 ${state.count} 个新 commit · 「${truncate(state.firstSubject, 28)}」`
          : `GitHub 有 ${state.count} 个新 commit · 点击查看`,
        title: '远端比当前部署新,可在 CDS 系统设置 → 维护 触发更新',
        bgClass: 'bg-amber-50 dark:bg-amber-950/30',
        borderClass: 'border-amber-500/40',
        textClass: 'text-amber-700 dark:text-amber-300',
        onClick: () => {
          window.location.href = '/cds-settings';
        },
      };
    case 'restarting': {
      const elapsed = Math.floor((Date.now() - state.sinceMs) / 1000);
      return {
        icon: <Loader2 className="h-4 w-4 animate-spin" />,
        label: `CDS 不可达 ${elapsed}s · 可能正在重启…`,
        title: 'self-status 流断开。CDS 可能在重启,EventSource 自动 3 秒一次重连。',
        bgClass: 'bg-blue-50 dark:bg-blue-950/30',
        borderClass: 'border-blue-500/40',
        textClass: 'text-blue-700 dark:text-blue-300',
        onClick: () => { /* no-op,等自动恢复 */ },
      };
    }
    case 'bundleStale':
      return {
        icon: <AlertTriangle className="h-4 w-4" />,
        label: `前端 bundle 比后端旧 (后端 ${state.backendSha} / 前端 ${state.bundleSha}) · 上次 web 构建可能失败`,
        title: 'web/dist/.build-sha 与 git HEAD 不一致 — exec_cds.sh 的 build_web 可能静默失败,检查日志',
        bgClass: 'bg-red-50 dark:bg-red-950/30',
        borderClass: 'border-red-500/40',
        textClass: 'text-red-700 dark:text-red-300',
        onClick: () => {
          window.location.href = '/cds-settings';
        },
      };
    default: {
      // 类型穷举 fallback(永远走不到 — Sparkles 占位防止 TS 报错)
      return {
        icon: <Sparkles className="h-4 w-4" />,
        label: '',
        title: '',
        bgClass: 'bg-gray-50 dark:bg-gray-900',
        borderClass: 'border-gray-500/40',
        textClass: 'text-gray-700 dark:text-gray-300',
        onClick: () => {},
      };
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
