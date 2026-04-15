import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

// requestIdleCallback 不在标准 Window 类型里（实验性 API），通过全局辅助类型访问
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function getIdleWindow(): IdleWindow {
  return window as IdleWindow;
}

/**
 * NavigationProgressBar — 顶栏路由切换进度条
 *
 * 解决的问题：React 18 concurrent transition 语义下，lazy route 加载时 React 会
 * 故意不渲染 Suspense fallback（"stale content wins"），导致 dev 模式下点击导航
 * 后 URL 变了但屏幕卡 2 秒没反应。GitHub / YouTube / Vercel 都是这种顶栏细条。
 *
 * 工作原理：
 *  · 通过 useLocation() 监听路由变化，**不依赖 Suspense**
 *  · location.pathname 在 navigate() 调用那一刻就变了，早于 lazy import 完成
 *  · useEffect 立刻触发 → 立刻显示进度条 → 用户获得即时反馈
 *  · 爬升曲线：0 → 15% (瞬间) → 40% (200ms) → 60% (500ms) → 80% (1.2s) → 90% (2s) → 卡住
 *  · 完成信号：requestIdleCallback —— 浏览器空闲 ≈ 新页面已经 commit + paint
 *  · Fallback：不支持 requestIdleCallback 的浏览器用 2.5s 固定 timeout
 *
 * 视觉：3px 高渐变条 (/home Hero 同款 青→紫→玫红) + 柔和光晕。
 * 性能：纯 CSS transition，无 rAF 循环，无 setState 风暴。
 * 无障碍：aria-hidden（功能是视觉反馈，不需要播报给 screen reader）。
 */
export function NavigationProgressBar() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const lastPath = useRef(location.pathname);
  const timersRef = useRef<number[]>([]);
  const idleRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (location.pathname === lastPath.current) return;
    lastPath.current = location.pathname;

    // ── 清理上一次导航的所有挂起 timer ──
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
        // 400ms 淡出动画结束后把 progress 归零，下次导航从 0 开始
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

    return () => {
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
  }, [location.pathname]);

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
          // 卡住在 90% 时用极慢 ease，完成到 100% 用短 ease-out，爬升用 ease-out quint
          transition:
            progress === 100
              ? 'width 180ms ease-out'
              : 'width 400ms cubic-bezier(0.19, 1, 0.22, 1)',
        }}
      />
    </div>
  );
}
