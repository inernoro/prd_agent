/**
 * 发布控制台的两个展示判据（纯函数，可单测）。
 *
 * 1. **步骤要带真实命令和真实耗时**。「更重视脚本化」的意思是用户得看见这一步到底跑了
 *    什么，而不是「执行发布命令」五个字。命令在 `ReleasePlan.steps[].command` 里，
 *    运行快照 `run.progress.steps` 只有状态和起止时间——两边靠 `step.id` 对上
 *    （后端注释写明：step.id 同时是该步日志的 phase，是这条链路的连接键）。
 *    对不上就**不显示命令**，绝不拿别的步骤的命令顶上。
 *
 * 2. **卡住要判出来**。用户的原话是「点击之后就卡住没后续了，到底是否成功，我们不清楚」。
 *    判据只有一个：还在跑，但已经多久没有新输出了。没有日志时用发布开始时间当基准——
 *    「一条都还没吐」本身就是最该报的那种卡住。
 */

export interface ConsolePlanStepLike {
  id: string;
  title?: string;
  command?: string;
}

export interface ConsolePlanLike {
  id: string;
  steps?: ConsolePlanStepLike[];
}

export interface ConsoleRunStepLike {
  id: string;
  title: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
}

export interface ConsoleRunLike {
  progress?: { planId?: string; steps?: ConsoleRunStepLike[] };
}

export interface ConsoleStepDetail {
  id: string;
  /** 这一步实际跑的命令。计划里没有、或步骤 id 对不上就是空串（不猜）。 */
  command: string;
  /** 已结束的步骤给毫秒耗时；未开始或还在跑给 undefined，UI 显示短横。 */
  durationMs?: number;
}

/**
 * 把「计划里的命令」与「本次运行的起止时间」按 step.id 对齐。
 *
 * 返回 Map 而不是改写步骤数组：步骤条本身的 SSOT 是 resolveReleaseSteps，
 * 这里只做旁挂的补充信息，避免出现第二份「步骤该长什么样」的判据。
 */
export function resolveStepDetails(
  run: ConsoleRunLike | null | undefined,
  plans: ReadonlyArray<ConsolePlanLike> | undefined,
): Map<string, ConsoleStepDetail> {
  const out = new Map<string, ConsoleStepDetail>();
  const runSteps = run?.progress?.steps || [];
  if (runSteps.length === 0) return out;

  const planId = run?.progress?.planId;
  // planId 对不上就不认：拿另一份计划的命令贴上去，比不显示命令危险得多。
  const plan = planId ? (plans || []).find((item) => item.id === planId) : undefined;
  const commandById = new Map<string, string>();
  (plan?.steps || []).forEach((step) => {
    if (step.id && step.command) commandById.set(step.id, step.command);
  });

  runSteps.forEach((step) => {
    const start = step.startedAt ? Date.parse(step.startedAt) : NaN;
    const end = step.finishedAt ? Date.parse(step.finishedAt) : NaN;
    const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
    out.set(step.id, { id: step.id, command: commandById.get(step.id) || '', durationMs });
  });
  return out;
}

/** 多久没有新输出就算卡住。45s 与设计稿一致，也够长到不会误报正常的慢步骤。 */
export const STALL_THRESHOLD_MS = 45_000;

export interface StallVerdict {
  stalled: boolean;
  /** 距离最后一条输出（没有输出则距离发布开始）过了多久。 */
  silentMs: number;
}

export function detectStall(input: {
  running: boolean;
  /** 最后一条日志的时间戳，没有日志时传 undefined。 */
  lastLogAt?: string;
  /** 本次发布开始时间，用作「一条都还没吐」时的基准。 */
  startedAt?: string;
  nowMs: number;
  thresholdMs?: number;
}): StallVerdict {
  if (!input.running) return { stalled: false, silentMs: 0 };
  const base = input.lastLogAt ? Date.parse(input.lastLogAt)
    : input.startedAt ? Date.parse(input.startedAt)
    : NaN;
  // 时间戳解析不出来时不报卡住：宁可不提示，也不要给一个凭空算出来的秒数。
  if (!Number.isFinite(base)) return { stalled: false, silentMs: 0 };
  const silentMs = Math.max(0, input.nowMs - base);
  return { stalled: silentMs >= (input.thresholdMs ?? STALL_THRESHOLD_MS), silentMs };
}
