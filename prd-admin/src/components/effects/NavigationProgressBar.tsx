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
 *   在 React 18 concurrent transition 语义下 —— 调用 navigate() 时，新 location
 *   会被 hold 住，直到整棵树（包含 lazy import 完成）准备好才 commit。这意味着：
 *     · useLocation() 读到的 pathname 不会立刻变
 *     · useEffect([location.pathname]) 不会立刻 fire
 *     · 进度条在 t=0 收不到任何信号
 *
 *   唯一不被 React 管控的是浏览器原生 history.pushState —— 它是同步调用的
 *   DOM API，React Router 内部调用它时必然早于 React 任何 render 逻辑。
 *   所以我们在模块加载时 monkey-patch history.pushState / replaceState，
 *   在原函数调用前 dispatch 一个 window 级自定义事件 'map:navstart'。
 *   NavigationProgressBar 监听这个事件，就能在 t=0 立刻获得信号。
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
 * 通过 history.pushState 拦截直接获取导航开始信号，**不依赖 React state / useLocation**。
 * 设计依据见 patchHistoryOnce 的 JSDoc。
 *
 * 视觉：3px 高渐变条 (/home Hero 同款 青→紫→玫红) + 光晕。
 * 爬升曲线：0 → 15% (瞬间) → 40% (200ms) → 60% (500ms) → 80% (1.2s) → 90% (2s stall)
 * 完成信号：requestIdleCallback (浏览器空闲 ≈ 新页面 commit + paint) + 4s 兜底
 */
export function NavigationProgressBar() {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const timersRef = useRef<number[]>([]);
  const idleRef = useRef<number | null>(null);
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
      if (idleRef.current !== null) {
        const w = getIdleWindow();
        if (typeof w.cancelIdleCallback === 'function') {
          w.cancelIdleCallback(idleRef.current);
        } else {
          window.clearTimeout(idleRef.current);
        }
        idleRef.current = null;
      }
    };

    const handleNavStart = (evt: Event) => {
      const custom = evt as CustomEvent<{ path: string }>;
      const nextPath = custom.detail?.path || window.location.pathname;
      // 相同路径不触发（比如 replaceState 到同一个 path）
      if (nextPath === lastPathRef.current) return;
      lastPathRef.current = nextPath;

      // 清掉上一次导航还没完成的 timer
      clearAllTimers();

      // ── 立刻显示、立刻从 0% 开始 ──
      setVisible(true);
      setProgress(0);

      // 下一帧跳到 15%，让用户看到"条子从左边弹出来"
      rafRef.current = requestAnimationFrame(() => {
        setProgress(15);
      });

      // ── 缓慢爬升曲线（总计 2 秒爬到 90%）──
      timersRef.current.push(
        window.setTimeout(() => setProgress(40), 200),
        window.setTimeout(() => setProgress(60), 500),
        window.setTimeout(() => setProgress(80), 1200),
        window.setTimeout(() => setProgress(90), 2000),
      );

      // ── 完成信号：浏览器空闲 = 新页面已 commit + paint ──
      const finish = () => {
        setProgress(100);
        // 200ms 后淡出
        const fadeId = window.setTimeout(() => {
          setVisible(false);
          // 400ms 淡出动画结束后把 progress 归零
          const resetId = window.setTimeout(() => setProgress(0), 400);
          timersRef.current.push(resetId);
        }, 200);
        timersRef.current.push(fadeId);
      };

      const w = getIdleWindow();
      if (typeof w.requestIdleCallback === 'function') {
        idleRef.current = w.requestIdleCallback(finish, { timeout: 4000 });
      } else {
        idleRef.current = window.setTimeout(finish, 2500);
      }
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
          transition:
            progress === 100
              ? 'width 180ms ease-out'
              : 'width 400ms cubic-bezier(0.19, 1, 0.22, 1)',
        }}
      />
    </div>
  );
}
