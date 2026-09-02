import { describe, it, expect } from 'vitest';
import {
  buildOverview, buildTimeline, computeHealth, countdownTo, formatClock, formatDuration,
  groupJobs, groupKeyOf, msUntil,
} from '../../web/src/lib/task-schedule-view.js';
import type { ScheduledJob, ScheduledJobRun } from '../../web/src/types/task-schedule.js';

/*
 * 任务调度页第一屏的结论句、24 小时轴的位置换算、健康度的成功率与 P50，
 * 全是算术：写错了页面照样渲染、类型照样过，只有断言能抓住。
 */

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-08-31T14:30:00.000Z');

const job = (over: Partial<ScheduledJob> & { id: string }): ScheduledJob => ({
  projectId: 'demo',
  name: over.id,
  enabled: true,
  schedule: { type: 'daily', timeOfDay: '03:00', timezone: 'UTC' },
  timeoutSeconds: 300,
  retryCount: 0,
  ...over,
} as ScheduledJob);

const run = (over: Partial<ScheduledJobRun> & { id: string; jobId: string }): ScheduledJobRun => ({
  projectId: 'demo',
  trigger: 'schedule',
  status: 'success',
  queuedAt: '2026-08-31T10:00:00.000Z',
  ...over,
} as ScheduledJobRun);

describe('倒计时与耗时格式', () => {
  it('倒计时按秒走，超过一天换量纲而不是给 743:12:05', () => {
    expect(countdownTo('2026-08-31T14:30:10.000Z', NOW)).toBe('00:00:10');
    expect(countdownTo('2026-08-31T15:31:05.000Z', NOW)).toBe('01:01:05');
    // 已经过去的时刻不给负数
    expect(countdownTo('2026-08-31T14:00:00.000Z', NOW)).toBe('00:00:00');
    expect(countdownTo('2026-09-03T14:30:00.000Z', NOW)).toBe('3 天后');
    expect(countdownTo(null, NOW)).toBe('—');
    expect(countdownTo('不是时间', NOW)).toBe('—');
    expect(msUntil(undefined, NOW)).toBeNull();
  });

  it('耗时在毫秒 / 秒 / 分三段各自换量纲', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(940)).toBe('940ms');
    expect(formatDuration(1240)).toBe('1.2s');
    expect(formatDuration(252_000)).toBe('4m12s');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('运行流的时钟列', () => {
  /*
   * 红绿闭环：把 RunRow 改回 `formatTime(iso).slice(-5)`，或让 formatClock 走
   * toLocaleString 再截尾，本用例立刻红 —— 截出来的是秒和 AM/PM（`05 AM`），不是 `HH:MM`。
   * 这不是样式问题：读到的值和想要的值不是同一个，页面照常渲染、类型照常过。
   */
  it('只给 HH:MM 两位补零，不带秒也不带 AM/PM', () => {
    const at = (h: number, m: number) => {
      const d = new Date(2026, 7, 31, h, m, 19);
      return d.toISOString();
    };
    expect(formatClock(at(9, 5))).toBe('09:05');
    expect(formatClock(at(0, 0))).toBe('00:00');
    expect(formatClock(at(23, 59))).toBe('23:59');
    // 午后必须是 24 小时制的 13:07，不是 01:07，更不是 `07 PM`
    expect(formatClock(at(13, 7))).toBe('13:07');
    for (const bad of [null, undefined, '不是时间']) {
      expect(formatClock(bad)).toBe('--:--');
    }
  });
});

describe('健康度', () => {
  it('成功率只统计已判定样本，跳过既不算成功也不算失败', () => {
    const list: ScheduledJobRun[] = [
      run({ id: 'r1', jobId: 'j', status: 'success', durationMs: 1000 }),
      run({ id: 'r2', jobId: 'j', status: 'skipped' }),
      run({ id: 'r3', jobId: 'j', status: 'failed', durationMs: 3000 }),
      run({ id: 'r4', jobId: 'j', status: 'success', durationMs: 2000 }),
    ];
    const health = computeHealth(list);
    // 已判定 3 条（跳过不计），成功 2 → 67%
    expect(health.successRate).toBe(67);
    expect(health.total).toBe(4);
    // P50 取中位：1000 / 2000 / 3000 → 2000
    expect(health.p50Ms).toBe(2000);
    // 连续成功从最新往回数，遇到 failed 才断；skipped 不算断也不加分
    expect(health.streak).toBe(1);
    // 条形图越靠右越新，所以是输入的倒序
    expect(health.bars).toEqual(['success', 'failed', 'skipped', 'success']);
  });

  /*
   * Codex #1471 第三轮 P2。跳过的运行被写成 durationMs = 0（任务停用 / 上一轮未结束），
   * 混进中位数会把一个真跑二十分钟的任务显示成 P50 接近 0ms。
   * 红绿闭环：把 durations 的来源换回 recent，本条报 `expected 0 to be 600000`。
   */
  it('P50 只看真的跑过的样本，跳过写的 durationMs=0 不许压低中位数', () => {
    // 一个每 5 分钟触发、实际跑 10 分钟的任务：大部分调度被并发策略跳过。
    const list: ScheduledJobRun[] = [
      run({ id: 'r1', jobId: 'j', status: 'skipped', durationMs: 0 }),
      run({ id: 'r2', jobId: 'j', status: 'skipped', durationMs: 0 }),
      run({ id: 'r3', jobId: 'j', status: 'success', durationMs: 600_000 }),
      run({ id: 'r4', jobId: 'j', status: 'skipped', durationMs: 0 }),
      run({ id: 'r5', jobId: 'j', status: 'skipped', durationMs: 0 }),
    ];
    expect(computeHealth(list).p50Ms).toBe(600_000);
  });

  it('没有已判定样本时成功率是 null，不是 0% —— 别把「没数据」画成「全挂」', () => {
    const health = computeHealth([run({ id: 'r1', jobId: 'j', status: 'queued' })]);
    expect(health.successRate).toBeNull();
    expect(health.p50Ms).toBeNull();
    expect(computeHealth([]).total).toBe(0);
  });
});

describe('结论条', () => {
  it('有任务自动停用时给出停用数，并把统计分成功 / 失败 / 跳过三档', () => {
    const jobs = [
      job({ id: 'a', consecutiveFailureCount: 3, autoDisabledReason: '连续 3 次失败', enabled: false }),
      job({ id: 'b', consecutiveFailureCount: 2 }),
      job({ id: 'c', nextRunAt: '2026-08-31T14:35:00.000Z' }),
    ];
    const runs = [
      run({ id: 'r1', jobId: 'c', status: 'success', queuedAt: '2026-08-31T09:00:00.000Z' }),
      run({ id: 'r2', jobId: 'a', status: 'failed', queuedAt: '2026-08-31T09:10:00.000Z' }),
      run({ id: 'r3', jobId: 'b', status: 'skipped', queuedAt: '2026-08-31T09:20:00.000Z' }),
    ];
    const overview = buildOverview(jobs, runs, NOW);
    expect(overview.tone).toBe('bad');
    expect(overview.headline).toContain('2 个任务连续失败');
    expect(overview.headline).toContain('1 个已被自动停用');
    const byLabel = Object.fromEntries(overview.stats.map((s) => [s.label, s.value]));
    expect(byLabel['成功']).toBe('1');
    expect(byLabel['失败']).toBe('1');
    expect(byLabel['跳过']).toBe('1');
    // 停用的任务不该被当成「下一次触发」
    expect(overview.nextName).toBe('c');
  });

  it('一个任务都没有时不硬凑判断句', () => {
    const overview = buildOverview([], [], NOW);
    expect(overview.tone).toBe('ok');
    expect(overview.headline).toContain('还没有定时任务');
    expect(overview.nextCountdown).toBe('—');
  });

  it('全绿时报「接下来 6 小时触发几次」，且只数 6 小时窗口内的', () => {
    const jobs = [job({
      id: 'ok',
      nextRunAt: '2026-08-31T15:00:00.000Z',
      nextRuns: [
        '2026-08-31T15:00:00.000Z', // 窗口内
        '2026-08-31T19:00:00.000Z', // 窗口内（4.5h）
        '2026-08-31T23:00:00.000Z', // 窗口外（8.5h）
        '2026-08-31T13:00:00.000Z', // 已过去
      ],
    })];
    const overview = buildOverview(jobs, [], NOW);
    expect(overview.tone).toBe('ok');
    const byLabel = Object.fromEntries(overview.stats.map((s) => [s.label, s.value]));
    expect(byLabel['接下来 6H']).toBe('2');
  });
});

describe('今日调度轴', () => {
  const dayStart = new Date(NOW);
  dayStart.setHours(0, 0, 0, 0);
  const at = (h: number, m = 0) => new Date(dayStart.getTime() + (h * 60 + m) * 60_000).toISOString();

  it('已发生的来自运行记录、待触发的来自服务端投影，且都换算成当天的百分比', () => {
    const jobs = [job({ id: 'daily', schedule: { type: 'daily', timeOfDay: '06:00' }, nextRuns: [at(18)] })];
    const runsByJob = new Map([[ 'daily', [run({ id: 'r1', jobId: 'daily', status: 'success', queuedAt: at(6) })] ]]);
    const timeline = buildTimeline(jobs, runsByJob, NOW, '');

    expect(timeline.lanes).toHaveLength(1);
    const events = timeline.lanes[0].events;
    expect(events).toHaveLength(2);
    // 06:00 → 25%，18:00 → 75%
    expect(Math.round(events[0].leftPct)).toBe(25);
    expect(events[0].status).toBe('success');
    expect(Math.round(events[1].leftPct)).toBe(75);
    expect(events[1].status).toBe('pending');
    expect(timeline.lanes[0].dense).toBe(false);
  });

  it('间隔 ≤15 分钟的任务画成连续带，只保留失败标记，不把 288 个点糊成一片', () => {
    const jobs = [job({ id: 'hot', schedule: { type: 'interval', intervalMinutes: 5 } })];
    const runsByJob = new Map([[ 'hot', [
      run({ id: 'r1', jobId: 'hot', status: 'success', queuedAt: at(1) }),
      run({ id: 'r2', jobId: 'hot', status: 'success', queuedAt: at(2) }),
      run({ id: 'r3', jobId: 'hot', status: 'failed', queuedAt: at(3) }),
    ] ]]);
    const timeline = buildTimeline(jobs, runsByJob, NOW, '');
    expect(timeline.lanes[0].dense).toBe(true);
    expect(timeline.lanes[0].events).toHaveLength(1);
    expect(timeline.lanes[0].events[0].status).toBe('failed');
  });

  it('泳道有上限，出问题的任务排在前面，其余计入未展开数', () => {
    const jobs = [
      ...Array.from({ length: 8 }, (_, i) => job({ id: `n${i}` })),
      job({ id: 'broken', autoDisabledReason: '连续失败已停用', enabled: false }),
    ];
    const timeline = buildTimeline(jobs, new Map(), NOW, '');
    expect(timeline.lanes).toHaveLength(6);
    expect(timeline.lanes[0].id).toBe('broken');
    expect(timeline.lanes[0].disabled).toBe(true);
    expect(timeline.lanes[0].tag).toBe('已停用');
    expect(timeline.hiddenCount).toBe(3);
  });

  it('越界的投影时刻不画：昨天的、明天的、已经过去的都不进轴', () => {
    const jobs = [job({
      id: 'x',
      nextRuns: [
        at(20),                                   // 今天，画
        at(30),                                   // 明天，不画
        at(2),                                    // 已过去，不画
      ],
    })];
    const timeline = buildTimeline(jobs, new Map(), NOW, '');
    expect(timeline.lanes[0].events).toHaveLength(1);
    expect(Math.round(timeline.lanes[0].events[0].leftPct)).toBe(83);
  });

  it('现在这条线的位置就是当前时刻在当天的占比', () => {
    const timeline = buildTimeline([job({ id: 'x' })], new Map(), NOW, '');
    const expected = ((NOW - dayStart.getTime()) / (24 * 3600_000)) * 100;
    expect(timeline.nowRatio).toBeCloseTo(expected, 5);
  });
});


describe('选中态的单泳道细带', () => {
  /*
   * 红绿闭环：把 buildTimeline 里的 onlyJobId 改成「先取前 6 再按 id 过滤」
   * （或直接在页面里写 lanes.filter(l => l.selected)），第一条断言立刻红 ——
   * 排名第 7 的任务过滤后是空数组，细带在页面上静默消失、其余部分照常渲染。
   * 这正是 predicate-and-wiring 形状 2：删掉不会红的链路必须有守卫。
   */
  // 排名把「连续失败」排在「选中」前面，所以只要失败的任务够多，
  // 选中的那个就会被挤出展示上限——这不是构造的极端值，而是这一页最常见的一天：
  // 一批任务在报错，你点开的偏偏是一个正常的。
  const many = [
    ...Array.from({ length: 6 }, (_, i) => job({ id: `sjob_bad_${i}`, name: `失败任务 ${i}`, consecutiveFailureCount: 3 })),
    job({ id: 'sjob_ok', name: '正常任务' }),
  ];
  const empty = new Map<string, ScheduledJobRun[]>();

  it('选中的任务排在展示上限之外时，细带仍然只有它这一条', () => {
    const all = buildTimeline(many, empty, NOW, 'sjob_ok');
    // 前提成立：不加 onlyJobId 时它确实不在被展示的 6 条里
    expect(all.lanes.some((lane) => lane.id === 'sjob_ok')).toBe(false);

    const strip = buildTimeline(many, empty, NOW, 'sjob_ok', { onlyJobId: 'sjob_ok' });
    expect(strip.lanes.map((lane) => lane.id)).toEqual(['sjob_ok']);
    expect(strip.lanes[0].selected).toBe(true);
    // 只画一条时不该再说「另有 N 个任务未展开」——那是概览态的文案
    expect(strip.hiddenCount).toBe(0);
  });

  it('不传 onlyJobId 时行为不变：按排名取前 6 条并给出未展开计数', () => {
    const all = buildTimeline(many, empty, NOW, 'sjob_ok');
    expect(all.lanes).toHaveLength(6);
    expect(all.hiddenCount).toBe(1);
  });
});


describe('任务分组', () => {
  const j = (id: string, over: Partial<ScheduledJob> = {}) => job({ id, name: id, ...over });

  /*
   * Codex #1471 P2。已过点还没跑的任务 msUntil 返回负数，它同样满足
   * 「<= 2 小时」，于是被归进「即将触发」——而它恰恰最该被看见。
   * 调度器 tick 是逐个 await 的，前面一个跑很久就会把后面的顶过点。
   * 红绿闭环：去掉 `delta < 0 → attention` 那一支，本用例报
   * `expected 'soon' to be 'attention'`。
   */
  it('已过点还没跑的任务归「需要注意」，不是「即将触发」', () => {
    const jobs = [
      j('overdue', { nextRunAt: '2026-08-31T14:00:00.000Z' }),  // NOW 是 14:30，已过点 30 分钟
      j('soon', { nextRunAt: '2026-08-31T15:00:00.000Z' }),     // 30 分钟后
      j('later', { nextRunAt: '2026-08-31T20:00:00.000Z' }),    // 5.5 小时后
    ];
    const g = groupJobs(jobs, NOW);
    expect(g.attention.map((x) => x.id)).toEqual(['overdue']);
    expect(g.soon.map((x) => x.id)).toEqual(['soon']);
    expect(g.normal.map((x) => x.id)).toEqual(['later']);
    // 停用 / 连续失败仍然优先落「需要注意」，不被时间判据抢走
    expect(groupKeyOf(job({ id: 'off', enabled: false, nextRunAt: '2026-08-31T15:00:00.000Z' }), NOW)).toBe('attention');
    // 没有 nextRunAt（仅手动）落「正常运行」，不许被当成过期
    expect(groupKeyOf(job({ id: 'manual', nextRunAt: undefined }), NOW)).toBe('normal');
  });
});

describe('结论条的状态是有限枚举，不是越叠越长的条件链', () => {
  /*
   * Codex #1471 连着两轮往这句话里加条件（今日挂过又恢复 / 被跳过清零算恢复 /
   * 停用的任务算在跑）。第三次再叠 else if 就是 CLAUDE.md §5.5 说的
   * 「同一个产出口反复被加分支」，所以改成显式枚举，每档一个判据。
   * 红绿闭环见各条注释。
   */
  const j = (id: string, over: Partial<ScheduledJob> = {}) => job({ id, name: id, nextRunAt: '2026-08-31T23:00:00.000Z', ...over });
  const r = (id: string, jobId: string, status: 'success' | 'failed' | 'skipped', at: string) =>
    run({ id, jobId, status, queuedAt: at });

  it('一个任务都没有 → no-jobs', () => {
    expect(buildOverview([], [], NOW).state).toBe('no-jobs');
  });

  /*
   * 2026-09-02 预览域验收时一眼看到的：结论条 detail 断成
   * 「证书到期检查；其余 8 个任务今日。」——原写法是 `今日${failedLive ? '' : '零失败'}`，
   * 有失败时三元返回空串，句子就没了下半截。类型和渲染都不会报。
   * 红绿闭环：把 othersTail 换回那个三元，本用例报断言失败（detail 以「今日。」收尾）。
   */
  it('failing 档的 detail 是完整句子，不会断在「今日。」', () => {
    const o = buildOverview(
      [j('a', { consecutiveFailureCount: 2 }), j('b'), j('c')],
      [
        r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
        r('r2', 'b', 'failed', '2026-08-31T09:30:00.000Z'),
      ],
      NOW,
    );
    expect(o.state).toBe('failing');
    expect(o.detail).not.toContain('今日。');
    expect(o.detail).toContain('其余 2 个任务今日另有 1 次失败');
  });

  it('连续失败的任务之外没人挂 → 说「零失败」', () => {
    const o = buildOverview(
      [j('a', { consecutiveFailureCount: 2 }), j('b')],
      [r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z')],
      NOW,
    );
    expect(o.detail).toContain('其余 1 个任务今日零失败');
  });

  it('有任务在连续失败 → failing，优先于其它档', () => {
    const o = buildOverview([j('a', { consecutiveFailureCount: 2 })], [r('r1', 'a', 'failed', '2026-08-31T10:00:00.000Z')], NOW);
    expect(o.state).toBe('failing');
    expect(o.tone).toBe('warn');
  });

  it('任务全被停用 → all-disabled，不许说「N 个任务在跑」', () => {
    // 手动停用（没有 autoDisabledReason）此前不在 failing 里，于是走到 clean 分支，
    // 五个全停的项目会显示「5 个任务在跑，今日无失败」。
    // 红绿闭环：把 enabled 换回 jobs.length，本条与下一条同时红。
    const jobs = [j('a', { enabled: false }), j('b', { enabled: false })];
    const o = buildOverview(jobs, [], NOW);
    expect(o.state).toBe('all-disabled');
    expect(o.headline).toBe('2 个任务全部已停用');
    expect(o.headline).not.toContain('在跑');
    expect(o.tone).toBe('warn');
  });

  it('部分停用时，「在跑」只数启用的那些', () => {
    const jobs = [j('a'), j('b', { enabled: false })];
    const o = buildOverview(jobs, [], NOW);
    expect(o.state).toBe('clean');
    expect(o.headline).toBe('1 个任务在跑，今日无失败');
    expect(o.detail).toContain('另有 1 个任务已停用');
  });

  it('挂过之后确有成功的重跑 → recovered', () => {
    const o = buildOverview([j('a')], [
      r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
      r('r2', 'a', 'success', '2026-08-31T10:00:00.000Z'),
    ], NOW);
    expect(o.state).toBe('recovered');
    expect(o.headline).toContain('1 次失败均已恢复');
    expect(o.tone).toBe('ok');
  });

  it('挂过之后只是被跳过、没有成功重跑 → unresolved，不许说「已恢复」', () => {
    // patchJobAfterRun 对「跳过」也清零 consecutiveFailureCount，
    // 于是 failing 为空而任务其实一次都没跑成功过。
    // 红绿闭环：把判据换回「只看 consecutiveFailureCount」，本条立刻红。
    const o = buildOverview([j('a')], [
      r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
      r('r2', 'a', 'skipped', '2026-08-31T10:00:00.000Z'),
    ], NOW);
    expect(o.state).toBe('unresolved');
    expect(o.headline).toContain('尚未复跑成功');
    expect(o.headline).not.toContain('已恢复');
    expect(o.tone).toBe('warn');
  });

  it('成功的重跑必须发生在最后一次失败之后，不是当天随便一次成功', () => {
    const o = buildOverview([j('a')], [
      r('r1', 'a', 'success', '2026-08-31T08:00:00.000Z'),
      r('r2', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
    ], NOW);
    expect(o.state).toBe('unresolved');
  });

  it('今天一次都没挂 → clean', () => {
    const o = buildOverview([j('a')], [r('r1', 'a', 'success', '2026-08-31T10:00:00.000Z')], NOW);
    expect(o.state).toBe('clean');
    expect(o.headline).toContain('今日无失败');
  });

  it('结论与统计段永远指同一件事：说了 N 次失败，统计段就是 N', () => {
    const o = buildOverview([j('a')], [
      r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
      r('r2', 'a', 'success', '2026-08-31T10:00:00.000Z'),
    ], NOW);
    expect(o.headline).toContain('1 次失败');
    expect(o.stats.find((x) => x.label === '失败')?.value).toBe('1');
  });

  /*
   * Codex #1471 第三轮 P2。deleteScheduledJob 只删任务、留下运行史，
   * 而一个已经不存在的任务永远不可能再跑成功一次——拿它判「有没有复跑成功」，
   * 结论条会一直停在 unresolved 直到跨零点。
   * 红绿闭环：把 failedJobIds 的来源换回 today 全部失败记录，本条报
   * `expected 'unresolved' to be 'clean'`。
   */
  it('已删除任务的失败不参与「复跑成功」判定，但仍计入今日统计', () => {
    const o = buildOverview([j('a')], [
      r('gone', 'deleted-job', 'failed', '2026-08-31T09:00:00.000Z'),
      r('r1', 'a', 'success', '2026-08-31T10:00:00.000Z'),
    ], NOW);
    expect(o.state).toBe('clean');
    // 统计段说的是「今天系统干了什么」，任务后来被删不改变它今天真的挂过。
    expect(o.stats.find((x) => x.label === '失败')?.value).toBe('1');
    // 两个数字不一致时必须当场说明差在哪，否则又是结论与支撑数据打架。
    expect(o.detail).toContain('另有 1 次失败来自已删除的任务');
    // 统计段「失败」非零时不许说「今日无失败」。
    expect(o.headline).toBe('1 个任务在跑，现有任务今日无失败');
  });

  /*
   * 上一条只证明了 failedLive 那道闸，证不了 failedJobIds 的过滤——它在
   * failedLive === 0 时根本走不到。这一条才是判据本身：现存任务挂过又恢复了，
   * 同一天还有一个已删除任务的失败悬着。
   * 红绿闭环：failedJobIds 换回 todayFailures，本条报
   * `expected 'unresolved' to be 'recovered'`。
   */
  it('现存任务已恢复时，已删除任务的旧失败不许把结论压在 unresolved', () => {
    const o = buildOverview([j('a')], [
      r('gone', 'deleted-job', 'failed', '2026-08-31T08:00:00.000Z'),
      r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
      r('r2', 'a', 'success', '2026-08-31T10:00:00.000Z'),
    ], NOW);
    expect(o.state).toBe('recovered');
    expect(o.headline).toContain('今日 1 次失败均已恢复');
    expect(o.detail).toContain('另有 1 次失败来自已删除的任务');
  });

  it('删掉挂掉的那个任务之后，剩下任务自己的未复跑仍要报出来', () => {
    const o = buildOverview([j('a')], [
      r('gone', 'deleted-job', 'failed', '2026-08-31T08:00:00.000Z'),
      r('r1', 'a', 'failed', '2026-08-31T09:00:00.000Z'),
    ], NOW);
    expect(o.state).toBe('unresolved');
    // 结论条的数字只数现存任务的失败，孤儿那次由 detail 单列。
    expect(o.headline).toContain('今日 1 次失败尚未复跑成功');
    expect(o.detail).toContain('另有 1 次失败来自已删除的任务');
    expect(o.stats.find((x) => x.label === '失败')?.value).toBe('2');
  });
});
