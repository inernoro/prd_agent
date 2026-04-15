import { useEffect, useRef, useState } from 'react';

// requestIdleCallback 不在标准 Window 类型里（实验性 API），通过全局辅助类型访问
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function getIdleWindow(): IdleWindow {
  return window as IdleWindow;
}

/**
 * 全局 history.pushState / replaceState 拦截器
 *
 * 为什么必须这么做：
 *   React Router v6 (非 data router 模式) 把 location 更新包在 React state 里，
 *   在 React 18 concurrent transition 语义下 —— 调用 navigate() 时新 location
 *   会被 hold 住，直到整棵树（包含 lazy import 完成）准备好才 commit。
 *   这意味着 useLocation() / useEffect([location]) 在 t=0 都拿不到信号。
 *
 *   唯一不被 React 管控的是浏览器原生 history.pushState —— 它是同步调用的
 *   DOM API，React Router 内部调用它时必然早于 React 任何 render 逻辑。
 *   所以模块加载时 monkey-patch history.pushState / replaceState，在原函数
 *   调用前 dispatch 'map:navstart' 自定义事件。进度条监听这个事件，就能在
 *   t=0 立刻获得信号 —— 早于 React 的一切。
 */
const NAV_START_EVENT = 'map:navstart';

let historyPatched = false;
function patchHistoryOnce() {
  if (historyPatched || typeof window === 'undefined') return;
  historyPatched = true;

  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  const emitNavStart = (url: string | URL | null | undefined) => {
    let path = '';
    if (typeof url === 'string') path = url;
    else if (url instanceof URL) path = url.pathname;
    window.dispatchEvent(
      new CustomEvent<{ path: string }>(NAV_START_EVENT, { detail: { path } }),
    );
  };

  window.history.pushState = function patchedPushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    emitNavStart(url);
    return originalPushState(data, unused, url);
  };

  window.history.replaceState = function patchedReplaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    emitNavStart(url);
    return originalReplaceState(data, unused, url);
  };

  // 浏览器后退/前进按钮走 popstate，不经过 pushState
  window.addEventListener('popstate', () => {
    window.dispatchEvent(
      new CustomEvent<{ path: string }>(NAV_START_EVENT, {
        detail: { path: window.location.pathname },
      }),
    );
  });
}

/**
 * NavigationProgressBar — 顶栏路由切换进度条
 *
 * ══ 两个容易踩的坑（已修复） ══
 *
 * 坑 1: requestIdleCallback 触发太早
 *   React 在 hold transition 期间浏览器实际上是空闲的（没在渲染），
 *   requestIdleCallback 会在 ~50ms 内立刻 fire，导致 finish() 几乎瞬间
 *   执行 —— 用户看到进度条"一闪而过"。
 *   修复：增加 MIN_DURATION 硬下限（1500ms），即使 idle 信号到得再早，
 *   也必须等到最小时长才能完成。
 *
 * 坑 2: 完成后 setProgress(0) 重置触发反向动画
 *   完成后如果直接 setProgress(100) → setVisible(false) → setProgress(0)，
 *   width 会走 400ms cubic-bezier 从 100% 反向缩到 0%，在 opacity 淡出
 *   350ms 期间可见 —— 用户看到"退回来"的诡异动画。
 *   修复：完成后永远不动 progress，停在 100%。下次导航开始时用
 *   animating=false 的 "transition: none" 瞬时 snap 到 0%（在 opacity 还是
 *   0 时发生，不可见）。
 *
 * ══ 工作原理 ══
 *
 * 1. 通过 patchHistoryOnce 在 history.pushState 层拦截导航，dispatch 事件，
 *    完全绕过 React transition
 * 2. 进度条监听 'map:navstart' 事件，立刻显示
 * 3. 爬升曲线：0 → 15% (下一帧) → 40% (200ms) → 60% (500ms) → 80% (1.2s)
 *    → 90% (1.8s, stall)
 * 4. 完成信号：requestIdleCallback + MIN_DURATION(1500ms) 硬下限 + 5s 超时兜底
 * 5. 完成动画：progress → 100, 300ms 后 opacity 淡出（不反向动画 width）
 */
const MIN_DURATION_MS = 1500; // 最小显示时长，防止"一闪而过"
const IDLE_TIMEOUT_MS = 5000; // requestIdleCallback 超时兜底

export function NavigationProgressBar() {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  // animating=false 时 width 无 transition（用于导航开始时瞬时 snap 到 0%）
  const [animating, setAnimating] = useState(true);

  const timersRef = useRef<number[]>([]);
  const idleCbRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastPathRef = useRef<string>(
    typeof window !== 'undefined' ? window.location.pathname : '',
  );

  useEffect(() => {
    patchHistoryOnce();

    const clearAllTimers = () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (idleCbRef.current !== null) {
        const w = getIdleWindow();
        if (typeof w.cancelIdleCallback === 'function') {
          w.cancelIdleCallback(idleCbRef.current);
        } else {
          window.clearTimeout(idleCbRef.current);
        }
        idleCbRef.current = null;
      }
    };

    const handleNavStart = (evt: Event) => {
      const custom = evt as CustomEvent<{ path: string }>;
      const nextPath = custom.detail?.path || window.location.pathname;
      if (nextPath === lastPathRef.current) return;
      lastPathRef.current = nextPath;

      clearAllTimers();

      const navStart = performance.now();

      // ── Step 1: 瞬时 snap 到 0% ──
      // animating=false → width 无 transition，瞬时生效
      // （上一次如果停在 100%，此时 opacity 还是 0，用户看不到 snap）
      setAnimating(false);
      setProgress(0);
      setVisible(true);

      // ── Step 2: 下一帧启用动画并开始爬升 ──
      rafRef.current = requestAnimationFrame(() => {
        // 双 rAF 确保 CSS 已经应用了 width:0，再切到 animating=true
        rafRef.current = requestAnimationFrame(() => {
          setAnimating(true);
          setProgress(15);
        });
      });

      // ── Step 3: 缓慢爬升（总计 1.8s 爬到 90%）──
      timersRef.current.push(
        window.setTimeout(() => setProgress(40), 200),
        window.setTimeout(() => setProgress(60), 500),
        window.setTimeout(() => setProgress(80), 1200),
        window.setTimeout(() => setProgress(90), 1800),
      );

      // ── Step 4: 完成逻辑 ──
      // 闭包变量跟踪"最小时长已过" + "idle 信号已到"
      // 只有两个都满足才真正 finish
      let minReached = false;
      let idleReceived = false;

      const realFinish = () => {
        // 硬跳到 100%，300ms 后 opacity 淡出（永不反向动 width）
        setProgress(100);
        const fadeTimerId = window.setTimeout(() => {
          setVisible(false);
        }, 300);
        timersRef.current.push(fadeTimerId);
      };

      const maybeFinish = () => {
        if (minReached && idleReceived) realFinish();
      };

      // 最小时长 timer
      const minTimerId = window.setTimeout(() => {
        minReached = true;
        maybeFinish();
      }, MIN_DURATION_MS);
      timersRef.current.push(minTimerId);

      // Idle 信号（浏览器真正空闲 = 新页面已 commit）+ 超时兜底
      const handleIdle = () => {
        idleReceived = true;
        idleCbRef.current = null;
        maybeFinish();
      };

      const w = getIdleWindow();
      if (typeof w.requestIdleCallback === 'function') {
        idleCbRef.current = w.requestIdleCallback(handleIdle, { timeout: IDLE_TIMEOUT_MS });
      } else {
        idleCbRef.current = window.setTimeout(handleIdle, 2500);
      }

      // 兜底：过了 performance.now() + 4000ms 无论如何也要 finish
      // 防止 idle 信号永远不到导致进度条永远卡在 90%
      const fallbackId = window.setTimeout(() => {
        const elapsed = performance.now() - navStart;
        if (elapsed >= 4000) {
          // 直接强制完成
          minReached = true;
          idleReceived = true;
          realFinish();
        }
      }, 4000);
      timersRef.current.push(fallbackId);
    };

    window.addEventListener(NAV_START_EVENT, handleNavStart);
    return () => {
      window.removeEventListener(NAV_START_EVENT, handleNavStart);
      clearAllTimers();
    };
  }, []);

  return (
    <div
      aria-hidden
      className="fixed top-0 inset-x-0 pointer-events-none"
      style={{
        height: 3,
        zIndex: 9999,
        opacity: visible ? 1 : 0,
        // 永远只动 opacity，不动 width（width 由 animating 控制）
        transition: visible ? 'opacity 120ms ease-out' : 'opacity 350ms ease-out',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${progress}%`,
          background: 'linear-gradient(90deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
          boxShadow:
            '0 0 12px rgba(124, 58, 237, 0.7), 0 0 6px rgba(0, 240, 255, 0.5), 0 1px 4px rgba(244, 63, 94, 0.4)',
          // 核心：animating=false 时完全禁用 width transition（用于瞬时 snap 到 0%）
          transition: animating
            ? progress === 100
              ? 'width 180ms ease-out'
              : 'width 400ms cubic-bezier(0.19, 1, 0.22, 1)'
            : 'none',
        }}
      />
    </div>
  );
}
