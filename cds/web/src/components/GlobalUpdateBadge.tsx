import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Loader2, Sparkles, X } from 'lucide-react';

/*
 * GlobalUpdateBadge — 浮在屏幕左下角的全局 CDS 更新状态徽章。
 *
 * 用户反馈(2026-05-04):「点更新后看不出真的更新了没」「希望有活动部件告诉我
 * 更新中/完成/失败」「订阅了分支,该分支更新了在任何页面左下角弹出可以点击更新」。
 *
 * 这个组件挂在 AppShell,所有页面共享。30s 一次轮询 /api/self-status,
 * 根据返回数据 + 与"页面打开时快照"对比,推出 4 种状态:
 *
 *   1. ✓ idle       — 正常,徽章隐藏(不打扰)
 *   2. ↑ updateAvail — 该分支 GitHub 远端有 N 个新 commit(订阅意义)
 *                      点击 → 跳 /cds-settings → 维护
 *   3. ⌛ restarting — 轮询失败 / CDS 在重启
 *                      显示 spinner,等 30s 后自动验证
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

const POLL_INTERVAL_NORMAL_MS = 30_000;
const POLL_INTERVAL_FAST_MS = 5_000; // 在 restarting / 检测到变化后的短窗口
const FAST_POLL_DURATION_MS = 90_000;
const DISMISS_KEY = 'cds:global-update-badge:dismissed-until';

export function GlobalUpdateBadge(): JSX.Element | null {
  const [state, setState] = useState<BadgeState>({ kind: 'idle' });
  const [expanded, setExpanded] = useState(false);
  const initialShaRef = useRef<string>('');
  const fastPollUntilRef = useRef<number>(0);
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

  const poll = useCallback(async (): Promise<void> => {
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 5000);
      // probe=remote 走 branches.ts 完整版,做 git fetch + 算 ahead 数。
      // 顶层轻量版不调 fetch,永远返 remoteAheadCount=0,角标永远不亮。
      // 单用户 dashboard 30s 一次 git fetch(本地 origin)~200-500ms,可接受。
      const r = await fetch('/api/self-status?probe=remote', {
        credentials: 'include',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId);
      if (!r.ok) {
        // 任何 4xx/5xx 都先按 restarting 处理 — 用户感知是"CDS 不太对"
        const since = Date.now();
        fastPollUntilRef.current = Math.max(fastPollUntilRef.current, since + FAST_POLL_DURATION_MS);
        setState({ kind: 'restarting', sinceMs: since });
        return;
      }
      const data = (await r.json()) as SelfStatusLite;
      lastSuccessRef.current = data;

      // 第一次成功:记录初始 SHA,用作"页面打开后是否换版本"的基线
      if (!initialShaRef.current && data.headSha) {
        initialShaRef.current = data.headSha;
      }

      // 优先级判定(高 → 低):
      //   1. SHA 变了 = 后端真换版本(updated)
      //   2. bundleStale = 前端比后端旧(build_web 静默失败)
      //   3. ahead > 0 = 远端有新 commit 可拉
      //   4. else idle
      if (initialShaRef.current && data.headSha && data.headSha !== initialShaRef.current) {
        setState({
          kind: 'updated',
          fromSha: initialShaRef.current,
          toSha: data.headSha,
        });
        return;
      }
      if (data.bundleStale && data.headSha && data.webBuildSha) {
        setState({
          kind: 'bundleStale',
          backendSha: data.headSha,
          bundleSha: data.webBuildSha.slice(0, 7),
        });
        return;
      }
      if ((data.remoteAheadCount || 0) > 0) {
        setState({
          kind: 'updateAvailable',
          count: data.remoteAheadCount || 0,
          firstSubject: data.remoteAheadSubjects?.[0]?.subject,
        });
        return;
      }
      setState({ kind: 'idle' });
    } catch {
      // 网络错误 / abort → 视为 restarting,触发 fast poll
      const since = Date.now();
      fastPollUntilRef.current = Math.max(fastPollUntilRef.current, since + FAST_POLL_DURATION_MS);
      setState({ kind: 'restarting', sinceMs: since });
    }
  }, []);

  useEffect(() => {
    void poll();
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const interval = Date.now() < fastPollUntilRef.current
        ? POLL_INTERVAL_FAST_MS
        : POLL_INTERVAL_NORMAL_MS;
      const timer = window.setTimeout(async () => {
        await poll();
        tick();
      }, interval);
      // store on closure for cleanup
      cleanupRef.current = () => window.clearTimeout(timer);
    };
    const cleanupRef = { current: () => {} };
    tick();
    return () => {
      cancelled = true;
      cleanupRef.current();
    };
  }, [poll]);

  // restarting 状态下 1s 定时刷新让 "CDS 不可达 Ns" 计时秒数跳动。
  // Bugbot PR #524 反馈:elapsed 在 visualForState 里 render 时计算一次,
  // 组件只在 5s 一次 poll 响应或 state 变化时才 re-render —— 用户盯着等恢复时
  // 看到秒数 5s 跳一次,会以为系统卡死。这里 1s 一次轻量 setState 强制重渲染。
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (state.kind !== 'restarting') return;
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [state.kind]);

  // 立即更新(2026-05-04 UX 优化):updateAvailable 状态下角标 hover 直接给
  // "立即更新"按钮,POST /api/self-update 后 Badge 切到 restarting 状态。
  // 之前要跳 /cds-settings 再点一次,多一步,行业(VS Code / Vercel CLI / Linear)
  // 都是 inline。
  const [triggering, setTriggering] = useState(false);
  const triggerSelfUpdate = useCallback(async () => {
    if (triggering) return;
    setTriggering(true);
    try {
      // 这里只发请求,真正的进度看 GlobalUpdateBadge 自己 30s 轮询的
      // restarting 状态推断;失败时显示 toast 不可用所以走 alert(简化)。
      const r = await fetch('/api/self-update', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        // eslint-disable-next-line no-alert
        alert(`触发更新失败 (${r.status})${text ? ': ' + text.slice(0, 200) : ''}`);
      }
      // 成功不弹 alert — 后续 poll 会自动切到 restarting 状态显示进度
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`触发更新失败: ${(err as Error).message}`);
    } finally {
      setTriggering(false);
    }
  }, [triggering]);

  // idle 或被 dismiss → 不渲染
  if (state.kind === 'idle' || isDismissed(state.kind)) return null;

  const visual = visualForState(state);

  return (
    <div
      className="fixed bottom-4 left-4 z-[200] select-none"
      style={{ pointerEvents: 'auto' }}
    >
      <div
        className={`flex items-stretch gap-0 overflow-hidden rounded-full border shadow-2xl transition-all duration-200 ${visual.borderClass} ${visual.bgClass}`}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
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
        title: 'self-status 请求失败。CDS 可能在重启,自动 5 秒一次重连。',
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
