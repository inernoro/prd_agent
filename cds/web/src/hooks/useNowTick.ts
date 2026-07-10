/*
 * useNowTick — 组件内自持的 1s 时钟（2026-07-09 性能重构）。
 *
 * 历史问题：BranchListPage 顶层一个 setInterval 每秒 setState，把 5800 行
 * 页面 + 全部分支卡整树重渲染（构建是分钟级长任务，期间每秒一次
 * O(分支数 × 活动事件数) 的完整 reconcile）。
 *
 * 现行纪律：谁要显示"已用时 mm:ss"，谁自己在组件内部调本 hook——
 * 滴答只重渲染需要它的那个叶子组件，不再穿透整页。`active=false` 时
 * 不起 interval（now 停在最近一次值），忙碌态结束即自动停表。
 */
import { useEffect, useState } from 'react';

export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
