import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Pin, PinOff, RefreshCw, Sparkles, X } from 'lucide-react';
import { CdsLogoLoader } from '@/components/brand/CdsMetallicLogo';
import { apiUrl } from '@/lib/api';
import { useCdsEvents, type SelfStatusSnapshot } from '@/hooks/useCdsEvents';

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
  /** 后端落盘标记(.cds/active-update.json):别 session/webhook 触发的
   *  self-update 进行中。SSE 透传到这里后,window dispatch
   *  'cds:active-self-update' 让 MaintenanceTab 实时跨 tab 同步。
   *  2026-05-07 新增 pid/lastTickAt/logTail/interrupted —
   *  Phase 1 状态落盘,前端能识别失联 / 已中断态。 */
  activeSelfUpdate?: {
    startedAt: string;
    branch: string;
    trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
    actor?: string;
    step?: string;
    pid?: number;
    lastTickAt?: string;
    logTail?: Array<{ ts: string; level: 'info' | 'warning' | 'error'; text: string }>;
    interrupted?: boolean;
  } | null;
}

type BadgeState =
  | { kind: 'idle' }
  | { kind: 'updated'; fromSha: string; toSha: string }
  | { kind: 'updateAvailable'; count: number; firstSubject?: string }
  | { kind: 'activeUpdating'; sinceMs: number; trigger?: string; step?: string; title?: string; staleSeconds?: number }
  | { kind: 'restarting'; sinceMs: number }
  | { kind: 'bundleStale'; backendSha: string; bundleSha: string };

const DISMISS_KEY = 'cds:global-update-badge:dismissed-until';
// 2026-05-28 后:SSE 失败回退、重试、阈值都由 useCdsEvents 单例统一处理,
// 本组件不再独立维护;原 FALLBACK_POLL_INTERVAL_MS / SSE_FAIL_THRESHOLD_* 常量已删除。

export function GlobalUpdateBadge(): JSX.Element | null {
  const navigate = useNavigate();
  const [state, setState] = useState<BadgeState>({ kind: 'idle' });
  // 2026-05-06 用户反馈"我要的是常开":徽章默认就展开显示完整状态,鼠标移开
  // 也不主动收。要让它收只能点 X 关闭(dismiss 1h)。Pin 按钮变成"自动收起切换"
  // (点击切到 hover-intent 模式,鼠标移开 280ms 收)。默认 pinned=true 实现常开。
  const [expanded, setExpanded] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // 同步 ref guard：防 rapid double-click 触发两次 fetch（React setState 是
  // batched，闭包里 `if (refreshing) return` 看到的是上一帧的值，第二次
  // click 进来时 setRefreshing(true) 还没生效，guard 形同虚设。useRef 是
  // mutable 即时生效的，不受 batching 影响。Bugbot Review 2026-05-06 bb22baea。
  const refreshingRef = useRef(false);
  const initialShaRef = useRef<string>('');
  const lastSuccessRef = useRef<SelfStatusLite | null>(null);
  // 用户反馈 2026-05-06:hover 离开瞬间徽章就收起,鼠标根本来不及划到
  // "立即更新" / "刷新" / "关闭" 这几个按钮 — 像走钢丝。改 hover-intent:
  // - 进入立即展开
  // - 离开延迟 280ms 才收起,中途再 enter 取消
  // - 钉住按钮(Pin/PinOff):pinned 时鼠标移开也不收
  // ⚠ Bugbot 2026-05-06 286deafc(High):这几个 hook **必须在** if (state.kind=='idle') return null
  // **之前**声明,否则 idle ↔ 非 idle 切换时 hook 调用顺序变化,React 直接 crash。
  const collapseTimerRef = useRef<number | null>(null);
  // 默认 pinned=true 实现"常开"。Pin 按钮点击切换:pinned=false → 进入 hover-intent
  // 模式(鼠标移开 280ms 收);再点又切回常开。
  const [pinned, setPinned] = useState(true);
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
  // 2026-05-06 用户反馈"我要常开":state.kind 切换时**保持** pinned + expanded,
  // 不再强制收。新出现的 kind(restart→idle→updateAvailable 等)继续可见,
  // 用户主动点 X 才 dismiss。

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

    // ⚠ Bugbot 59568cb0:把 activeSelfUpdate 通过 window CustomEvent 广播,
    // MaintenanceTab 监听后立刻同步显示"正在重启",不再等 30s 轮询。
    // SSE 30s ack 不够 — webhook 触发的 self-update 平均 70s 跑完,30s 轮询
    // 只能看到 "正在结束" 那一帧,完全错过中间进度。
    try {
      window.dispatchEvent(new CustomEvent('cds:active-self-update', {
        detail: payload.activeSelfUpdate ?? null,
      }));
    } catch { /* tolerate — older browsers */ }

    // 第一次成功(snapshot 或 manual 首次):记录初始 SHA,作为"页面打开后是否换版本"的基线
    if (!initialShaRef.current && payload.headSha) {
      initialShaRef.current = payload.headSha;
    }

    if (payload.activeSelfUpdate && !payload.activeSelfUpdate.interrupted) {
      const startedMs = Date.parse(payload.activeSelfUpdate.startedAt);
      const lastTickMs = payload.activeSelfUpdate.lastTickAt ? Date.parse(payload.activeSelfUpdate.lastTickAt) : Number.NaN;
      const staleSeconds = Number.isFinite(lastTickMs)
        ? Math.max(0, Math.floor((Date.now() - lastTickMs) / 1000))
        : undefined;
      setState({
        kind: 'activeUpdating',
        sinceMs: Number.isFinite(startedMs) ? startedMs : Date.now(),
        trigger: payload.activeSelfUpdate.trigger,
        step: payload.activeSelfUpdate.step,
        title: payload.activeSelfUpdate.logTail?.[payload.activeSelfUpdate.logTail.length - 1]?.text,
        staleSeconds: staleSeconds && staleSeconds >= 10 ? staleSeconds : undefined,
      });
      return;
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

  // 2026-05-28 重构:手动刷新走 POST /api/self-refresh(任务化,202 + jobId)。
  // 实际进度由 useCdsEvents 订阅的 self.refresh.started/done/failed 事件接管,
  // 这里只发起请求 + 让按钮 spin 一会儿。
  const events = useCdsEvents();
  const triggerManualRefresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await events.requestRefresh('manual');
    } catch {
      // 失败由 effectiveConnection / lastError 反映 — 不再翻 restarting
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [events]);

  // 2026-05-28 重构:订阅 useCdsEvents store。它本身是全局单例 EventSource,
  // 维护 snapshot / connection state / refreshing / updating;本组件只负责把
  // snapshot 映射成 BadgeState,大幅简化 SSE / 重试 / 降级逻辑。
  useEffect(() => {
    if (events.snapshot) {
      applyPayload(events.snapshot as SelfStatusSnapshot & SelfStatusLite, 'update');
    }
    // useCdsEvents 的 disconnected 状态 ⇒ 显示 restarting(原逻辑兜底)
    if (events.effectiveConnection === 'disconnected') {
      setState({ kind: 'restarting', sinceMs: Date.now() });
    }
  }, [events.snapshot, events.effectiveConnection, applyPayload]);

  // restarting / activeUpdating 状态下 1s 定时刷新让计时秒数跳动。
  // elapsed 在 visualForState 里 render 时计算一次,组件本身不会因时间流逝
  // 自动 re-render — 这里 1s 一次轻量 setState 强制重渲染。
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (state.kind !== 'restarting' && state.kind !== 'activeUpdating') return;
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [state.kind]);

  // 旧的 probe-recovered 轮询(每 2-3s 调一次 /api/self-status 反证恢复)已删除。
  // 2026-05-28: useCdsEvents 的 SSE 通道断了浏览器内置重连;恢复后 self.status
  // 事件会立刻把 snapshot 推过来,本组件 useEffect 监听 events.snapshot 自动更新。
  // 不再需要前端主动短周期探测。

  // 立即更新(2026-05-04 UX 优化):updateAvailable 状态下角标 hover 直接给
  // "立即更新"按钮,POST /api/self-update 后 Badge 切到 restarting 状态。
  // 2026-05-08 Phase A:零停机路径(mode=web-only/doc-only/noOp)daemon 不重启,
  // 不进 restarting 态,直接 triggerManualRefresh 拉一次新 self-status。
  const [triggering, setTriggering] = useState(false);
  const triggerSelfUpdate = useCallback(async () => {
    if (triggering) return;
    setTriggering(true);
    const ctrl = new AbortController();
    // 5s 兜底:正常情况第一个 event 在毫秒级到达,5s 还没收到就当被中间件吞了
    const abortTimer = window.setTimeout(() => ctrl.abort(), 5000);
    let acceptedFirstEvent = false;
    try {
      const response = await fetch(apiUrl('/api/self-update'), {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: lastSuccessRef.current?.currentBranch || 'main' }),
        signal: ctrl.signal,
      });
      window.clearTimeout(abortTimer);
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
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
            // 一次可能收到多条 event,循环切完
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              acceptedFirstEvent = true;
              const lines = block.split('\n');
              const eventName = lines.find((l) => l.startsWith('event: '))?.slice(7).trim();
              const dataRaw = lines.find((l) => l.startsWith('data: '))?.slice(6) || '';
              if (eventName === 'error') {
                let msg = '未知错误';
                let activeSelfUpdate: SelfStatusLite['activeSelfUpdate'] | undefined;
                try {
                  const data = JSON.parse(dataRaw) as { message?: string; error?: string; activeSelfUpdate?: SelfStatusLite['activeSelfUpdate'] };
                  msg = data.message || data.error || msg;
                  activeSelfUpdate = data.activeSelfUpdate;
                } catch { /* keep default */ }
                if (activeSelfUpdate && !activeSelfUpdate.interrupted) {
                  applyPayload({ activeSelfUpdate }, 'update');
                  ctrl.abort();
                  return;
                }
                // eslint-disable-next-line no-alert
                alert(`更新失败: ${msg}`);
                ctrl.abort();
                return;
              }
              if (eventName === 'step') {
                try {
                  const data = JSON.parse(dataRaw) as { step?: string; title?: string };
                  setState({
                    kind: 'activeUpdating',
                    sinceMs: Date.now(),
                    trigger: 'manual',
                    step: data.step,
                    title: data.title,
                  });
                } catch { /* ignore malformed step */ }
              }
              if (eventName === 'done') {
                let mode: string | undefined;
                try {
                  const data = JSON.parse(dataRaw) as { mode?: string };
                  mode = data.mode;
                } catch { /* fallthrough → 视为完整重启 */ }
                // 零停机档:daemon 不重启,直接拉一次 self-status 让 banner 切回 idle。
                if (mode === 'web-only') {
                  ctrl.abort();
                  window.setTimeout(() => {
                    window.location.reload();
                  }, 800);
                  return;
                }
                if (mode === 'doc-only' || mode === 'noOp') {
                  ctrl.abort();
                  void triggerManualRefresh();
                  return;
                }
                // 其它(hot-reload / restart / undefined)→ daemon 即将重启,进 restarting。
                setState({ kind: 'restarting', sinceMs: Date.now() });
                ctrl.abort();
                return;
              }
              // 普通 step event 累积,等待 done 决定走哪条路径。
            }
          }
          if (done) break;
        }
      } finally { /* stream finished or was intentionally aborted */ }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // 我们主动 abort,不当错
      // eslint-disable-next-line no-alert
      alert(`触发更新失败: ${(err as Error).message}`);
    } finally {
      window.clearTimeout(abortTimer);
      setTriggering(false);
      // 收到了 event 但没拿到 done(stream 提前结束 / fallback 切到 restarting):
      // 已经在 fallbackToRestarting 里设过 state,这里不重复处理。
      void acceptedFirstEvent;
    }
  }, [triggering, triggerManualRefresh]);

  // idle 或被 dismiss → 不渲染
  const visible = state.kind !== 'idle' && !isDismissed(state.kind);
  useEffect(() => {
    document.documentElement.dataset.cdsGlobalUpdateBadgeVisible = visible ? 'true' : 'false';
    window.dispatchEvent(new CustomEvent('cds:global-update-badge-visible', {
      detail: { visible },
    }));
    return () => {
      document.documentElement.dataset.cdsGlobalUpdateBadgeVisible = 'false';
      window.dispatchEvent(new CustomEvent('cds:global-update-badge-visible', {
        detail: { visible: false },
      }));
    };
  }, [visible]);

  if (!visible) return null;

  const visual = visualForState(state, {
    onRetry: () => { void triggerManualRefresh(); },
    onNavigate: navigate,
  });

  // 2026-05-07 wave 3.2:重启 overlay — restarting 状态超过 5s 时显示全屏
  // 半透明 backdrop,让用户更明确感知"等几秒"。<5s 时只 banner,避免抖动。
  // 点 backdrop 直接调 retry,跟 banner 主体行为一致。
  const restartingElapsed = state.kind === 'restarting' ? Math.floor((Date.now() - state.sinceMs) / 1000) : 0;
  const showOverlay = state.kind === 'restarting' && restartingElapsed >= 5;

  return (
    <>
      {showOverlay ? (
        <div
          className="fixed inset-0 z-[150] flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm cursor-pointer"
          onClick={() => { void triggerManualRefresh(); }}
          role="button"
          aria-label="点击立即重试"
          title="点击立即重试 self-status"
        >
          <CdsLogoLoader size="xl" className="text-white" />
          <div className="mt-4 text-base font-semibold text-white">CDS 重启中 · {restartingElapsed}s</div>
          <div className="mt-1 text-xs text-white/70">点击立即重试 / 等待自动恢复</div>
        </div>
      ) : null}
    <div
      className="fixed bottom-4 left-4 z-[200] max-w-[calc(100vw-2rem)] select-none"
      style={{ pointerEvents: 'auto' }}
    >
      <div
        className={`flex min-w-0 items-stretch gap-0 overflow-hidden rounded-full border shadow-2xl transition-all duration-200 ${visual.borderClass} ${visual.bgClass} ${pinned ? 'ring-2 ring-amber-400/40' : ''}`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <button
          type="button"
          onClick={visual.onClick}
          className={`flex min-w-0 items-center gap-2 px-3 py-2 text-sm transition-colors ${visual.textClass} hover:bg-black/5 dark:hover:bg-white/5`}
          aria-label={visual.title}
          title={visual.title}
        >
          <span className="shrink-0">{visual.icon}</span>
          {expanded ? (
            /* truncate (not whitespace-nowrap) so a long commit subject shrinks
               instead of pushing the action buttons off a phone screen. The
               min-w-0 chain above lets this flex child actually collapse. */
            <span className="truncate pr-1 text-xs font-medium">{visual.label}</span>
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
        {/* 2026-05-06 用户反馈"我要常开":Pin 按钮始终显示(包括 restart 状态),
            默认常开(pinned=true)。点 Pin 切到 hover-intent 模式(鼠标移开自动收)。
            再点切回常开。 */}
        {expanded ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPinned((p) => !p);
            }}
            className={`flex shrink-0 items-center justify-center px-2 ${visual.textClass} ${pinned ? 'opacity-100' : 'opacity-60'} transition-opacity hover:opacity-100`}
            aria-label={pinned ? '取消钉住(切换到鼠标移开自动收起)' : '钉住面板(始终展开)'}
            title={pinned ? '已钉住 — 点击切换到自动收起模式(鼠标移开 280ms 收)' : '已自动收起模式 — 点击切回常开'}
          >
            {pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
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
    </>
  );
}

function visualForState(
  state: Exclude<BadgeState, { kind: 'idle' }>,
  opts: { onRetry: () => void; onNavigate: (to: string) => void } = {
    onRetry: () => {},
    onNavigate: (to) => { window.location.href = to; },
  },
): {
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
          opts.onNavigate('/cds-settings');
        },
      };
    case 'activeUpdating': {
      const elapsed = Math.floor((Date.now() - state.sinceMs) / 1000);
      const triggerLabel = state.trigger === 'force-sync' ? '强制更新'
        : state.trigger === 'webhook' ? 'Webhook 更新'
        : state.trigger === 'auto-poll' ? '自动更新'
        : '更新';
      const stepText = state.title || state.step || '等待后端返回进度';
      const staleText = state.staleSeconds ? ` · ${state.staleSeconds}s 无新心跳` : '';
      return {
        icon: <CdsLogoLoader size="sm" />,
        label: `${triggerLabel}进行中 ${elapsed}s · ${truncate(stepText, 42)}${staleText}`,
        title: 'CDS 正在执行 self-update。点击打开更新与重启查看完整流水。',
        bgClass: 'bg-amber-50 dark:bg-amber-950/30',
        borderClass: 'border-amber-500/40',
        textClass: 'text-amber-700 dark:text-amber-300',
        onClick: () => {
          opts.onNavigate('/cds-settings#maintenance');
        },
      };
    }
    case 'restarting': {
      const elapsed = Math.floor((Date.now() - state.sinceMs) / 1000);
      return {
        icon: <CdsLogoLoader size="sm" />,
        label: `CDS 不可达 ${elapsed}s · 可能正在重启…`,
        title: 'self-status 流断开。点击主动重试一次(SSE 也在自动 3 秒一次重连)。',
        bgClass: 'bg-blue-50 dark:bg-blue-950/30',
        borderClass: 'border-blue-500/40',
        textClass: 'text-blue-700 dark:text-blue-300',
        // 2026-05-07 用户反馈"banner 308s 一直在,daemon 已活但状态卡住":
        // 点击主体 → 主动 fetch /api/self-status,成功就 reset 到 idle。
        // 解决 SSE fallback polling 卡死时,用户看到其他 API 正常但 banner
        // 不消除的死循环。
        onClick: opts.onRetry,
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
          opts.onNavigate('/cds-settings');
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
