/**
 * 任务调度页的派生视图逻辑。
 *
 * 抽出来不是为了复用（只有一个调用方），是为了**可测**：结论句的归因判断、
 * 时间轴的百分比换算、健康度的成功率与 P50，全是算术，写错了页面照样渲染、
 * 类型照样过——只有断言能抓住。见 tests/web/task-schedule-view.test.ts。
 */
import type { RunStatus, ScheduledJob, ScheduledJobRun } from '@/types/task-schedule';


export interface JobHealth {
  total: number;
  successRate: number | null;
  p50Ms: number | null;
  streak: number;
  bars: RunStatus[];
}

/**
 * 单个任务的健康度：只统计已判定（成功/失败）的样本，跳过不计入成功率**也不计入耗时**。
 * 跳过的运行被写成 `durationMs = 0`（任务停用 / 上一轮未结束），混进中位数会把
 * 一个真跑二十分钟的任务显示成 P50 接近 0ms —— 分母必须和成功率同一批样本。
 */
export function computeHealth(list: ScheduledJobRun[]): JobHealth {
  const recent = list.slice(0, 20);
  const decided = recent.filter((run) => run.status === 'success' || run.status === 'failed');
  const ok = decided.filter((run) => run.status === 'success').length;
  const durations = decided
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  let streak = 0;
  for (const run of recent) {
    if (run.status === 'success') streak += 1;
    else if (run.status === 'failed') break;
  }
  return {
    total: recent.length,
    successRate: decided.length ? Math.round((ok / decided.length) * 100) : null,
    p50Ms: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null,
    streak,
    // 越靠右越新，所以倒过来铺。
    bars: recent.slice(0, 10).map((run) => run.status).reverse(),
  };
}

export function statusTone(status: RunStatus | 'not-run'): string {
  if (status === 'success') return 'bg-ok';
  if (status === 'failed') return 'bg-bad';
  if (status === 'skipped') return 'bg-warn';
  return 'bg-[hsl(var(--hairline-strong))]';
}

export function runStatusLabel(status: RunStatus): string {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  if (status === 'skipped') return '已跳过';
  return '排队中';
}

export function scheduleLabel(job: ScheduledJob): string {
  if (job.schedule.type === 'manual') return '仅手动';
  if (job.schedule.type === 'interval') return `每 ${job.schedule.intervalMinutes || 60} 分钟`;
  return `每天 ${job.schedule.timeOfDay || '02:00'} ${job.schedule.timezone || 'Asia/Shanghai'}`;
}

export function formatTime(iso?: string | null): string {
  if (!iso) return '无';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * 运行流那一列时钟只有 5 个字符宽，要的是 `HH:MM`。
 * 曾经写成 `formatTime(iso).slice(-5)` —— `toLocaleString()` 末尾是秒和 AM/PM，
 * 截出来是 `05 AM`：读到的不是想要的那个值，页面照常渲染、类型照常过。
 * 时钟另立一个函数，别再从长日期上截。
 */
export function formatClock(iso?: string | null): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}


export function msUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return at - now;
}


/** HH:MM:SS 倒计时。超过一天只给天数，免得出现 743:12:05 这种读不出来的数。 */
export function countdownTo(iso: string | null | undefined, now: number): string {
  const delta = msUntil(iso, now);
  if (delta === null) return '—';
  if (delta <= 0) return '00:00:00';
  const total = Math.floor(delta / 1000);
  if (total >= 86400) return `${Math.floor(total / 86400)} 天后`;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}


export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}


/**
 * 任务分组。抽出来是为了可断言——判据全是「负数算不算」这类算术，
 * 埋在组件的 useMemo 里写错了页面照样渲染。
 *
 * 已过点还没跑的任务（delta 为负）必须落「需要注意」：它同样满足「<= 2 小时」，
 * 不显式挑出来就会安静地待在「即将触发」里，倒计时停在 00:00:00。
 * 调度器 tick 是逐个 await 的，前一个跑很久就会把后面的顶过点，这不是罕见路径。
 */
export type JobGroupKey = 'attention' | 'soon' | 'normal';

export function groupKeyOf(job: ScheduledJob, now: number): JobGroupKey {
  if (!job.enabled || job.autoDisabledReason || (job.consecutiveFailureCount || 0) > 0) return 'attention';
  const delta = msUntil(job.nextRunAt, now);
  if (delta === null) return 'normal';
  if (delta < 0) return 'attention';
  return delta <= 2 * 60 * 60 * 1000 ? 'soon' : 'normal';
}

export function groupJobs(jobs: ScheduledJob[], now: number): Record<JobGroupKey, ScheduledJob[]> {
  const out: Record<JobGroupKey, ScheduledJob[]> = { attention: [], soon: [], normal: [] };
  for (const job of jobs) out[groupKeyOf(job, now)].push(job);
  const byNext = (a: ScheduledJob, b: ScheduledJob) =>
    (msUntil(a.nextRunAt, now) ?? Infinity) - (msUntil(b.nextRunAt, now) ?? Infinity);
  out.soon.sort(byNext);
  out.normal.sort(byNext);
  return out;
}


export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}


/**
 * 下一个本地零点。**不是** `startOfToday + 24h`：夏令时切换那两天，一个本地日是
 * 23 或 25 小时（Codex #1471 P2）。写死 24 小时会让当天所有点位相对 00-24 刻度整体
 * 偏移，春季那天还会把次日凌晨的事件放进来，秋季那天会把当天最后一小时的事件丢掉。
 * 用「日期 +1 再归零」让运行时按真实本地日历算。
 */
export function startOfNextDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);  // 跨过 DST 之后再归零一次，防止 setDate 把时间带偏
  return d.getTime();
}


/**
 * 结论条。先给一句带数字的判断，再给统计 —— 而不是让人自己读一排数字去算。
 * 失败归因只在「多条任务撞同一个上游」时才敢下，判据是失败记录里的目标是否同源。
 */
export type OverviewState =
  | 'no-jobs'      // 一个任务都没有
  | 'failing'      // 有任务处于连续失败（最要紧，优先于其它档）
  | 'all-disabled' // 有任务，但没有一个是启用的
  | 'unresolved'   // 今天挂过，计数清零了但没有成功的重跑
  | 'recovered'    // 今天挂过，之后确有成功的重跑
  | 'clean';       // 今天没挂过


export function buildOverview(jobs: ScheduledJob[], runs: ScheduledJobRun[], now: number) {
  const dayStart = startOfToday(now);
  const today = runs.filter((run) => Date.parse(run.queuedAt) >= dayStart);
  const ok = today.filter((run) => run.status === 'success').length;
  const failed = today.filter((run) => run.status === 'failed').length;
  const skipped = today.filter((run) => run.status === 'skipped').length;

  const disabled = jobs.filter((job) => job.autoDisabledReason);
  const failing = jobs.filter((job) => (job.consecutiveFailureCount || 0) > 0);

  let nextJob: ScheduledJob | null = null;
  let nextDelta = Infinity;
  for (const job of jobs) {
    if (!job.enabled) continue;
    const delta = msUntil(job.nextRunAt, now);
    if (delta === null || delta < 0) continue;
    if (delta < nextDelta) { nextDelta = delta; nextJob = job; }
  }

  const upcoming = jobs.reduce((sum, job) => sum + (job.nextRuns || []).filter((iso) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) && at > now && at - now <= 6 * 60 * 60 * 1000;
  }).length, 0);

  // 结论状态是有限枚举，不是一串越叠越长的 else if。
  // 前两轮 Review 已经要求往这句话里加过三次条件（今日挂过又恢复 / 被跳过清零 /
  // 停用的任务不算在跑）；再叠下去就是 CLAUDE.md §5.5 说的「同一个产出口反复被加分支」。
  // 现在每一档由一个显式判据决定，文案只是它的渲染。
  const enabled = jobs.filter((job) => job.enabled && !job.autoDisabledReason);
  const disabledCount = jobs.length - enabled.length;

  // 判「有没有复跑成功」只认还存在的任务。删掉一个任务不会删掉它的运行史
  // （StateService.deleteScheduledJob 只删任务本身），而一个已经不存在的任务永远
  // 不可能再跑成功一次——拿它当判据，结论条会一直停在「尚未复跑成功」直到跨零点。
  // 今日统计（执行/成功/失败）仍算全部记录：那一栏说的是「今天系统干了什么」，
  // 任务后来被删不改变它今天真的挂过。两个数字不一致时由 orphanTail 说明差在哪。
  const liveJobIds = new Set(jobs.map((job) => job.id));
  const todayFailures = today.filter((run) => run.status === 'failed');
  const liveFailures = todayFailures.filter((run) => liveJobIds.has(run.jobId));
  const failedLive = liveFailures.length;
  const orphanFailed = todayFailures.length - failedLive;

  // 「恢复」要有证据：该任务今天挂过之后，确实还有一次成功的重跑。
  // 光看 consecutiveFailureCount 清零不够——patchJobAfterRun 对**跳过**也清零，
  // 一次失败的发布后面跟一次「目标忙」的跳过，计数就归零了，但它根本没跑成功过。
  const failedJobIds = new Set(liveFailures.map((run) => run.jobId));
  const unrecovered = [...failedJobIds].filter((jobId) => {
    const lastFail = Math.max(...today.filter((r) => r.jobId === jobId && r.status === 'failed').map((r) => Date.parse(r.queuedAt)));
    return !today.some((r) => r.jobId === jobId && r.status === 'success' && Date.parse(r.queuedAt) > lastFail);
  });

  const state: OverviewState = jobs.length === 0
    ? 'no-jobs'
    : failing.length > 0
      ? 'failing'
      : enabled.length === 0
        ? 'all-disabled'
        : failedLive === 0
          ? 'clean'
          : unrecovered.length > 0
            ? 'unresolved'
            : 'recovered';

  const tail = disabledCount > 0 && state !== 'all-disabled' ? `；另有 ${disabledCount} 个任务已停用` : '';
  const skipTail = skipped ? `；今日有 ${skipped} 次因上一轮未结束而跳过` : '';
  const orphanTail = orphanFailed ? `；另有 ${orphanFailed} 次失败来自已删除的任务` : '';

  let headline: string;
  let detail: string;
  let tone: 'ok' | 'warn' | 'bad';
  if (state === 'no-jobs') {
    tone = 'ok';
    headline = '这个项目还没有定时任务';
    detail = '新建一个任务后，可以每天定时调用接口或执行命令，每次结果都会记在运行流里。';
  } else if (state === 'failing') {
    tone = disabled.length > 0 ? 'bad' : 'warn';
    headline = disabled.length > 0
      ? `${failing.length} 个任务连续失败，其中 ${disabled.length} 个已被自动停用`
      : `${failing.length} 个任务连续失败`;
    // 这句此前写成 `今日${failedLive ? '' : '零失败'}`——有别的失败时三元返回空串，
    // 句子就断在「其余 8 个任务今日。」（2026-09-02 预览域验收时一眼看到）。
    // 有失败就说清剩下那些各挂了几次，没有才说零失败。
    const othersFailed = failedLive - today.filter(
      (run) => run.status === 'failed' && failing.some((job) => job.id === run.jobId),
    ).length;
    const othersTail = othersFailed > 0 ? `今日另有 ${othersFailed} 次失败` : '今日零失败';
    detail = `${failing.map((job) => job.name).slice(0, 3).join('、')}${failing.length > 3 ? ' 等' : ''}；其余 ${jobs.length - failing.length} 个任务${othersTail}${skipTail}${orphanTail}。`;
  } else if (state === 'all-disabled') {
    tone = 'warn';
    headline = `${jobs.length} 个任务全部已停用`;
    detail = '没有任务会被自动触发。启用其中任意一个，或用「立即执行」手动跑一次。';
  } else if (state === 'unresolved') {
    tone = 'warn';
    headline = `${enabled.length} 个任务在跑，今日 ${failedLive} 次失败尚未复跑成功`;
    detail = `${unrecovered.length} 个任务挂过之后没有再成功跑过一次${skipTail}${orphanTail}${tail}。`;
  } else if (state === 'recovered') {
    tone = 'ok';
    headline = `${enabled.length} 个任务在跑，今日 ${failedLive} 次失败均已恢复`;
    detail = `挂过的任务之后都有成功的重跑${skipTail}${orphanTail}${tail}；接下来 6 小时将触发 ${upcoming} 次。`;
  } else {
    tone = 'ok';
    // 有孤儿失败时不能说「今日无失败」——紧挨着的统计段里「失败」那一栏是非零的。
    headline = orphanFailed
      ? `${enabled.length} 个任务在跑，现有任务今日无失败`
      : `${enabled.length} 个任务在跑，今日无失败`;
    detail = `接下来 6 小时将触发 ${upcoming} 次${skipTail}${orphanTail}${tail}。`;
  }

  return {
    state, tone, headline, detail,
    nextCountdown: nextJob ? countdownTo(nextJob.nextRunAt, now) : '—',
    nextName: nextJob ? nextJob.name : '无待触发任务',
    stats: [
      { label: '今日执行', value: String(today.length), tone: 'text-foreground' },
      { label: '成功', value: String(ok), tone: 'text-ok' },
      { label: '失败', value: String(failed), tone: 'text-bad' },
      { label: '跳过', value: String(skipped), tone: 'text-warn' },
      { label: '接下来 6H', value: String(upcoming), tone: 'text-foreground' },
    ],
  };
}


/**
 * 今日调度轴。左边是已发生（来自运行记录），右边是待触发（来自服务端投影的 nextRuns）。
 * 密到看不清就不画点：间隔 ≤15 分钟的任务画成一条连续运行带，只把失败标出来。
 */
export function buildTimeline(
  jobs: ScheduledJob[],
  runsByJob: Map<string, ScheduledJobRun[]>,
  now: number,
  selectedId: string,
  options: { onlyJobId?: string } = {},
) {
  const dayStart = startOfToday(now);
  // 本地日长度按真实日历算，不是写死 24 小时——DST 那两天是 23 / 25 小时。
  const dayEnd = startOfNextDay(now);
  const dayMs = dayEnd - dayStart;
  const ratio = (at: number) => Math.max(0, Math.min(100, ((at - dayStart) / dayMs) * 100));

  // onlyJobId：选中态的 44px 细带只画这一条。走「先筛后取前 N」而不是「取前 N 再筛」，
  // 因为排名只留 6 条，选中的任务排在第 7 位时后者会得到空数组——细带静默消失，
  // 页面照常渲染、测试照常绿。
  const pool = options.onlyJobId ? jobs.filter((job) => job.id === options.onlyJobId) : jobs;
  const ranked = [...pool].sort((a, b) => {
    const weight = (job: ScheduledJob) => (job.autoDisabledReason ? 0 : (job.consecutiveFailureCount || 0) > 0 ? 1 : job.id === selectedId ? 2 : 3);
    return weight(a) - weight(b);
  });

  const lanes: TimelineLane[] = ranked.slice(0, TIMELINE_LANE_LIMIT).map((job) => {
    const todays = (runsByJob.get(job.id) || []).filter((run) => Date.parse(run.queuedAt) >= dayStart);
    const dense = job.schedule.type === 'interval' && (job.schedule.intervalMinutes || 0) > 0 && (job.schedule.intervalMinutes || 0) <= 15;
    const events: TimelineEvent[] = [];
    for (const run of todays) {
      // 连续带模式下只标失败，成功由带本身表达，否则 288 个点糊成一片。
      if (dense && run.status !== 'failed') continue;
      events.push({
        leftPct: ratio(Date.parse(run.queuedAt)),
        status: run.status,
        title: `${formatTime(run.queuedAt)} · ${runStatusLabel(run.status)}`,
      });
    }
    for (const iso of job.nextRuns || []) {
      const at = Date.parse(iso);
      if (!Number.isFinite(at) || at <= now || at >= dayEnd) continue;
      events.push({ leftPct: ratio(at), status: 'pending', title: `${formatTime(iso)} · 待触发` });
    }
    return {
      id: job.id,
      name: job.name,
      disabled: Boolean(job.autoDisabledReason) || !job.enabled,
      selected: job.id === selectedId,
      tag: job.autoDisabledReason ? '已停用' : scheduleLabel(job),
      dense,
      events,
    };
  });

  // 刻度也要走同一套时间基准。此前刻度写死 hour/24，而事件与「现在」游标已经改成
  // 按真实本地日长度换算——DST 那两天两者就对不上了：点位挪了，03 的刻度还钉在 12.5%
  // （Codex #1471 P2）。这是上一轮那个修复只做了一半。
  // 取当天该整点的**本地时刻**再用同一个 ratio 换算；春季不存在的那一小时由
  // setHours 自然落到跳变之后，刻度正好落在时钟跳过去的位置。
  const hourTicks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => {
    if (hour === 24) return { hour, leftPct: 100 };
    const at = new Date(dayStart);
    at.setHours(hour, 0, 0, 0);
    return { hour, leftPct: ratio(at.getTime()) };
  });

  return {
    lanes,
    hourTicks,
    nowRatio: ratio(now),
    nowLabel: new Date(now).toTimeString().slice(0, 5),
    hiddenCount: Math.max(0, pool.length - lanes.length),
  };
}


export interface TimelineHourTick { hour: number; leftPct: number; }


export interface TimelineEvent { leftPct: number; status: RunStatus | 'pending'; title: string; }


export interface TimelineLane { id: string; name: string; disabled: boolean; selected: boolean; tag: string; dense: boolean; events: TimelineEvent[]; }


export const TIMELINE_LANE_LIMIT = 6;
