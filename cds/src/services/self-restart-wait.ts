/*
 * 自更新 / 自重启的「重启前等待」状态，以及 restartStatus 的唯一判定。
 *
 * 2026-09-16 两次自更新看起来「没换进程」：记录写着 success、cdscli 报 restarted:true、
 * self status 说 incomplete——其实都在等在途部署排空（最多 5 分钟），只是这段等待
 * 对谁都不可见：SSE 没有事件、状态接口没有字段、记录早就写成了 success。
 * 于是人看到的是「成功了但没重启」，去手动再重启一次，结果也在等同一道闸。
 *
 * 这里把等待做成一个显式状态：谁在等、等了多久、最多等多久、在等哪几个 run。
 * restartStatus 的判定只在这一个函数里（形状 3：判据不分裂）：
 *   有 activeSelfUpdate 或正在等待 → pending
 *   上一条记录 success 且需要重启 → 看新进程是否晚于记录时刻 → completed / incomplete
 *   其它 → not_required
 */

export type RestartWaitPhase = 'draining-deploys' | 'flushing' | 'spawning';

export interface RestartWaitState {
  source: string;
  phase: RestartWaitPhase;
  since: number;
  waitedMs: number;
  timeoutMs: number;
  pendingRuns: string[];
}

let current: RestartWaitState | null = null;

export function setRestartWait(state: RestartWaitState | null): void {
  current = state;
}

export function getRestartWait(): RestartWaitState | null {
  return current;
}

export type RestartStatus = 'not_required' | 'pending' | 'completed' | 'incomplete';

export interface RestartStatusInput {
  activeSelfUpdate: unknown;
  restartWait: RestartWaitState | null;
  lastSelfUpdate: { status?: string; updateMode?: string; ts?: string } | null;
  daemonReadyAt: string | null;
  pidStartedAt: string | null;
}

/**
 * 重启「已确认」= 当前正在跑的进程确实是这次更新之后才起来的。两个独立信号任一成立即可：
 *   1) daemonReadyAt：新进程 listen 后盖戳，但偶发不落盘；
 *   2) pidStartedAt：进程模块加载即盖戳，无条件可靠，作为权威兜底。
 * 二者皆早于 / 缺失才判 incomplete（更新成功但进程没换 = 真的没重启）。
 */
export function resolveRestartStatus(input: RestartStatusInput): RestartStatus {
  if (input.activeSelfUpdate || input.restartWait) return 'pending';
  const last = input.lastSelfUpdate;
  if (!last || last.status !== 'success' || last.updateMode === 'web-only') return 'not_required';
  const updateMs = last.ts ? Date.parse(last.ts) : Number.NaN;
  const readyMs = input.daemonReadyAt ? Date.parse(input.daemonReadyAt) : Number.NaN;
  const pidMs = input.pidStartedAt ? Date.parse(input.pidStartedAt) : Number.NaN;
  const confirmedByDaemon = Number.isFinite(readyMs) && Number.isFinite(updateMs) && readyMs >= updateMs;
  const confirmedByPid = Number.isFinite(pidMs) && Number.isFinite(updateMs) && pidMs >= updateMs;
  return confirmedByDaemon || confirmedByPid ? 'completed' : 'incomplete';
}

/** 给人读的一句话：在等谁、等了多久、最多等多久。 */
export function describeRestartWait(w: RestartWaitState): string {
  const waited = Math.round(w.waitedMs / 1000);
  if (w.phase === 'draining-deploys') {
    const max = Math.round(w.timeoutMs / 1000);
    return `重启前等待 ${w.pendingRuns.length} 个在途部署落地（已等 ${waited}s，最多 ${max}s；超时会照常重启，这些部署会被收敛为中断）`;
  }
  if (w.phase === 'flushing') return `在途部署已排空，正在把状态落盘（已等 ${waited}s），随后换进程`;
  return `正在换进程（已等 ${waited}s），几秒内旧进程退出、新进程接手`;
}
