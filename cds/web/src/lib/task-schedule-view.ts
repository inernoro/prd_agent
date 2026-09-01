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

/** 单个任务的健康度：只统计已判定（成功/失败）的样本，跳过不计入成功率。 */
export function computeHealth(list: ScheduledJobRun[]): JobHealth {
  const recent = list.slice(0, 20);
  const decided = recent.filter((run) => run.status === 'success' || run.status === 'failed');
  const ok = decided.filter((run) => run.status === 'success').length;
  const durations = recent
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


export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}


/**
 * 结论条。先给一句带数字的判断，再给统计 —— 而不是让人自己读一排数字去算。
 * 失败归因只在「多条任务撞同一个上游」时才敢下，判据是失败记录里的目标是否同源。
 */
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

  let headline: string;
  let detail: string;
  let tone: 'ok' | 'warn' | 'bad';
  if (failing.length > 0) {
    tone = disabled.length > 0 ? 'bad' : 'warn';
    headline = disabled.length > 0
      ? `${failing.length} 个任务连续失败，其中 ${disabled.length} 个已被自动停用`
      : `${failing.length} 个任务连续失败`;
    detail = `${failing.map((job) => job.name).slice(0, 3).join('、')}${failing.length > 3 ? ' 等' : ''}；其余 ${jobs.length - failing.length} 个任务今日${failed ? '' : '零失败'}${skipped ? `，另有 ${skipped} 次因上一轮未结束而跳过` : ''}。`;
  } else if (jobs.length === 0) {
    tone = 'ok';
    headline = '这个项目还没有定时任务';
    detail = '新建一个任务后，可以每天定时调用接口或执行命令，每次结果都会记在运行流里。';
  } else {
    tone = 'ok';
    headline = `${jobs.length} 个任务在跑，今日无失败`;
    detail = `接下来 6 小时将触发 ${upcoming} 次${skipped ? `；今日有 ${skipped} 次因上一轮未结束而跳过` : ''}。`;
  }

  return {
    tone, headline, detail,
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
  const dayMs = 24 * 60 * 60 * 1000;
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
      if (!Number.isFinite(at) || at <= now || at - dayStart >= dayMs) continue;
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

  return {
    lanes,
    nowRatio: ratio(now),
    nowLabel: new Date(now).toTimeString().slice(0, 5),
    hiddenCount: Math.max(0, pool.length - lanes.length),
  };
}


export interface TimelineEvent { leftPct: number; status: RunStatus | 'pending'; title: string; }


export interface TimelineLane { id: string; name: string; disabled: boolean; selected: boolean; tag: string; dense: boolean; events: TimelineEvent[]; }


export const TIMELINE_LANE_LIMIT = 6;
