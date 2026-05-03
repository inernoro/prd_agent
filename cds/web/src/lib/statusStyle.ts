/**
 * Status chip styling — 共享 SSOT for branch / service / deployment status。
 *
 * Bugbot fix(2026-05-04 PR #523):
 * 之前 BranchListPage.tsx + BranchDetailDrawer.tsx 各自维护一份 statusClass +
 * statusRailClass,Bug B「运行中 vs 未运行 视觉差别不明显」修复时要同步两份。
 * 抽到本文件后,所有 status chip 共享样式,未来调色只需改一处。
 *
 * 状态语义对齐 cds/src/types.ts 的 ServiceState['status'] +
 * BranchSummary['status'] 全集 + 部分外延(building / starting / restarting /
 * stopping / stopped / idle / error / running)。
 */

/** 任意 string,我们做 best-effort 匹配 — 未知状态走默认弱样式。 */
export type StatusLike = string;

/**
 * 返回 chip 容器的 Tailwind className(border + bg + text + 字重)。
 *
 * - running: 高饱和绿 + bold(强信号)
 * - building/starting/restarting: sky 蓝(过渡态)
 * - error: 红 + bold(高优先关注)
 * - stopping: amber(中间态)
 * - stopped: 灰 + opacity-70(明确停止)
 * - idle / 未知: 灰 + opacity-60(最弱,与 running 形成强对比)
 */
export function statusClass(status: StatusLike): string {
  if (status === 'running') {
    return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold';
  }
  if (status === 'building' || status === 'starting' || status === 'restarting') {
    return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  }
  if (status === 'error') {
    return 'border-destructive/40 bg-destructive/15 text-destructive font-semibold';
  }
  if (status === 'stopping') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  if (status === 'stopped') {
    return 'border-border bg-muted/60 text-muted-foreground opacity-70';
  }
  // idle / unknown — 默认更弱,与 running 强烈对比
  return 'border-border bg-muted/40 text-muted-foreground opacity-60';
}

/**
 * 返回 chip 内 dot prefix 的 Tailwind className(纯色背景 / 微光 / 空心圈)。
 *
 * - running: 实心绿 + 微光环(扫一眼就锁定关注)
 * - building/starting/restarting: 蓝 + animate-pulse(进行中视觉)
 * - error: 红
 * - stopping: amber
 * - 其它(idle / stopped / unknown): 空心灰圈(明确"非运行"信号)
 *
 * 配合 statusClass 在同一 chip 内使用,互相强化辨识度。
 */
export function statusRailClass(status: StatusLike): string {
  if (status === 'running') {
    return 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]';
  }
  if (status === 'building' || status === 'starting' || status === 'restarting') {
    return 'bg-sky-500 animate-pulse';
  }
  if (status === 'error') return 'bg-destructive';
  if (status === 'stopping') return 'bg-amber-500';
  // idle / stopped / unknown — 空心圈,与 running 实心绿点形成强对比
  return 'bg-transparent border border-muted-foreground/50';
}
