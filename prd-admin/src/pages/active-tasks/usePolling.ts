/**
 * 每隔一阵自己看一眼 —— 三个页面共用。
 *
 * 两条纪律：
 * 1. 标签页不可见就不跑。没人在看的时候还每分钟打一次接口是白烧。
 * 2. 切回可见时立刻拉一次。人回到这一屏，看到的该是现在，不是一分钟前。
 */
import { useEffect } from 'react';

export function useVisiblePolling(fn: () => void, intervalMs = 60_000) {
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') fn(); };
    const t = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [fn, intervalMs]);
}
