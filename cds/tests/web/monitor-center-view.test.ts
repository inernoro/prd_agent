/**
 * 监控中心视图纯函数（lib/monitorCenter）真值断言。
 *
 * 这些函数决定第一屏说什么、列表怎么筛怎么排、默认点开谁、数字怎么读——
 * 全是「看起来对、编译过、通读也挑不出」的判据，只能拿真值锁。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  availabilityOfBuckets,
  buildMonitorHeadline,
  mergeBuckets,
  filterBranches,
  groupBranchesByProject,
  mainSiteTargets,
  sortBranchesAliveFirst,
  describeStatusSince,
  filterTargets,
  formatDuration,
  formatPercent,
  latencySeries,
  overallAvailability24h,
  pickDefaultTargetId,
  type UptimeBucket,
  type UptimeIncidentView,
  type UptimeTargetSummary,
} from '../../web/src/lib/monitorCenter.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

const NOW = Date.parse('2026-09-08T10:00:00.000Z');
const MIN = 60_000;

function target(over: Partial<UptimeTargetSummary>): UptimeTargetSummary {
  return {
    id: over.name || 'x', source: 'branch', name: 'x', branchId: '', projectId: '', profileId: '', probeKind: 'http',
    status: 'up', lastSample: null, availability24h: 1, availability7d: 1, avgLatencyMs24h: 100, sampleCount24h: 10,
    buckets: [], openIncidentSince: null, statusSince: null, incidentCount: 0, probeDescription: '',
    intervalSeconds: 60, timeoutMs: 5000, measured: true, ...over,
  };
}

function summaryOf(targets: UptimeTargetSummary[], enabled = true) {
  const tally = { total: targets.length, up: 0, down: 0, paused: 0, unknown: 0, excluded: 0, ok: true };
  for (const t of targets) {
    if (t.excluded) tally.excluded += 1;
    else if (t.status === 'up') tally.up += 1;
    else if (t.status === 'down') tally.down += 1;
    else if (t.status === 'paused') tally.paused += 1;
    else tally.unknown += 1;
  }
  tally.ok = tally.down === 0;
  return { enabled, overall: tally, targets };
}

function incident(over: Partial<UptimeIncidentView>): UptimeIncidentView {
  return {
    id: 'i', targetId: 'x', targetName: 'x', source: 'branch', branchId: '', projectId: '',
    startedAt: NOW - 3 * MIN, endedAt: NOW - MIN, durationMs: 2 * MIN, cause: 'HTTP 503', ongoing: false, ...over,
  };
}

describe('buildMonitorHeadline 第一屏结论', () => {
  it('有故障：点名目标、说明是否波及生产、最长持续多久', () => {
    const h = buildMonitorHeadline(summaryOf([
      target({ name: '官网', source: 'release', status: 'down', openIncidentSince: NOW - 42 * MIN }),
      target({ name: 'main / api', status: 'down', openIncidentSince: NOW - 5 * MIN }),
      target({ name: 'main / web' }),
    ]), [], NOW);
    expect(h.tone).toBe('danger');
    expect(h.title).toBe('2 个目标故障，生产受影响');
    expect(h.detail).toContain('官网');
    expect(h.detail).toContain('其中 1 个是生产目标');
    expect(h.detail).toContain('最长已持续 42 分钟');
  });

  it('待确认优先于全绿：有 unknown 时不许说全部正常', () => {
    const h = buildMonitorHeadline(summaryOf([target({ name: 'a' }), target({ name: 'b', status: 'unknown' })]), [], NOW);
    expect(h.tone).toBe('warn');
    expect(h.title).toBe('1 个目标状态确认中');
  });

  it('全绿：给整体可用率、平均响应与 24h 内恢复过的故障', () => {
    const h = buildMonitorHeadline(
      summaryOf([target({ name: 'a', availability24h: 0.99, sampleCount24h: 100 }), target({ name: 'b', availability24h: 1, sampleCount24h: 100 })]),
      [incident({ targetName: 'a', durationMs: 2 * MIN })],
      NOW,
    );
    expect(h.tone).toBe('ok');
    expect(h.title).toBe('2 个实测目标全部正常');
    expect(h.detail).toContain('99.50%');
    expect(h.detail).toContain('恢复了 1 次故障');
    expect(h.detail).toContain('a（持续 2 分钟）');
  });

  it('「24h 内恢复」按恢复时刻算：30 小时前开始、1 小时前才恢复的故障也算，且最近恢复的排前面', () => {
    const HOUR = 60 * MIN;
    const h = buildMonitorHeadline(
      summaryOf([target({ name: 'a' }), target({ name: 'b' })]),
      [
        // 后端按开始时刻倒序给：新开始的在前
        incident({ id: 'newer', targetName: 'b', startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR, durationMs: HOUR }),
        incident({ id: 'long', targetName: 'a', startedAt: NOW - 30 * HOUR, endedAt: NOW - HOUR, durationMs: 29 * HOUR }),
        incident({ id: 'old', targetName: 'a', startedAt: NOW - 40 * HOUR, endedAt: NOW - 30 * HOUR, durationMs: 10 * HOUR }),
        incident({ id: 'open', targetName: 'b', startedAt: NOW - 2 * HOUR, endedAt: null, durationMs: 2 * HOUR, ongoing: true }),
      ],
      NOW,
    );
    expect(h.detail).toContain('恢复了 2 次故障');
    expect(h.detail).toContain('最近一次是 a（持续 1 天 5 小时）');
    expect(h.detail).not.toContain('24 小时内没有故障');
  });

  it('未实测不算正常：全绿句子里单独点出来；探测器停了先说这个', () => {
    const s = summaryOf([target({ name: 'a' }), target({ name: 'w', measured: false })]);
    s.overall.up = 1; s.overall.unmeasured = 1;
    const h = buildMonitorHeadline(s, [], NOW);
    expect(h.title).toBe('1 个实测目标全部正常');
    expect(h.detail).toContain('另有 1 个只按容器状态判定、未实测');
    const stalled = buildMonitorHeadline({ ...s, prober: { lastCycleAt: NOW - 10 * MIN, lastCycleDurationMs: 1000, lastCycleProbed: 2, lastCycleTargets: 2, stalled: true, userViewEnabled: true } }, [], NOW);
    expect(stalled.tone).toBe('warn');
    expect(stalled.title).toBe('监测本身停了');
  });

  it('没有目标 / 监控关闭：直说，不凑句子', () => {
    expect(buildMonitorHeadline(summaryOf([]), [], NOW).title).toBe('还没有可监控的目标');
    expect(buildMonitorHeadline(summaryOf([target({ name: 'a' })], false), [], NOW).title).toBe('存活监控已关闭');
    // 只有排除名单里的目标 = 没有在探的，算作没有目标而不是全绿
    expect(buildMonitorHeadline(summaryOf([target({ name: 'a', excluded: true })]), [], NOW).tone).toBe('neutral');
  });
});

describe('overallAvailability24h 按采样加权', () => {
  it('排除的目标与无采样目标不拉平均', () => {
    const ratio = overallAvailability24h([
      target({ availability24h: 0.5, sampleCount24h: 100 }),
      target({ availability24h: 1, sampleCount24h: 300 }),
      target({ availability24h: 0, sampleCount24h: 100, excluded: true }),
      target({ availability24h: 0, sampleCount24h: 0 }),
    ]);
    expect(ratio).toBeCloseTo(0.875, 5);
    expect(overallAvailability24h([])).toBeNull();
  });
});

describe('filterTargets 搜索与筛选', () => {
  const list = [
    target({ name: '官网', source: 'release', status: 'down', probeUrl: 'https://www.example.test/health' }),
    target({ name: 'main / api', branchId: 'proj-main', tags: ['核心'] }),
    target({ name: 'grpc', status: 'paused' }),
    target({ name: 'legacy', excluded: true }),
  ];
  it('按名称 / 地址 / 分支 / 标签模糊搜，大小写不敏感', () => {
    expect(filterTargets(list, { query: 'EXAMPLE', status: 'all', source: 'all' }).map((t) => t.name)).toEqual(['官网']);
    expect(filterTargets(list, { query: '核心', status: 'all', source: 'all' }).map((t) => t.name)).toEqual(['main / api']);
    expect(filterTargets(list, { query: 'proj-main', status: 'all', source: 'all' }).map((t) => t.name)).toEqual(['main / api']);
  });
  it('状态筛选：暂停一档把「未纳入监控」也收进来；故障一档不含排除的', () => {
    expect(filterTargets(list, { query: '', status: 'paused', source: 'all' }).map((t) => t.name)).toEqual(['grpc', 'legacy']);
    expect(filterTargets(list, { query: '', status: 'down', source: 'all' }).map((t) => t.name)).toEqual(['官网']);
  });
  it('来源筛选', () => {
    expect(filterTargets(list, { query: '', status: 'all', source: 'release' }).map((t) => t.name)).toEqual(['官网']);
  });
});

describe('pickDefaultTargetId 默认选中', () => {
  const list = [target({ name: 'a' }), target({ name: 'b', status: 'unknown' }), target({ name: 'c', status: 'down' }), target({ name: 'd', status: 'down', excluded: true })];
  it('保留仍存在的当前选中；否则故障优先、其次待确认、最后第一条', () => {
    expect(pickDefaultTargetId(list, 'a')).toBe('a');
    expect(pickDefaultTargetId(list, 'gone')).toBe('c');
    expect(pickDefaultTargetId(list.filter((t) => t.status !== 'down'), null)).toBe('b');
    expect(pickDefaultTargetId([target({ name: 'only' })], null)).toBe('only');
    expect(pickDefaultTargetId([], null)).toBeNull();
  });
});

describe('响应时间曲线与可用率', () => {
  const bucket = (i: number, ms: number | null, status: UptimeBucket['status'], up = 1, down = 0): UptimeBucket => ({
    from: NOW + i * MIN, to: NOW + (i + 1) * MIN, up, down, avgLatencyMs: ms, status,
  });
  it('latencySeries 跳过空桶，给 min / avg / max', () => {
    const s = latencySeries([bucket(0, 100, 'up'), bucket(1, null, 'none', 0, 0), bucket(2, 300, 'partial', 1, 1), bucket(3, 200, 'up')]);
    expect(s.points).toHaveLength(3);
    expect(s.min).toBe(100);
    expect(s.max).toBe(300);
    expect(s.avg).toBe(200);
    expect(latencySeries([])).toEqual({ points: [], min: null, avg: null, max: null });
  });
  it('availabilityOfBuckets 按成功 / 总数', () => {
    expect(availabilityOfBuckets([bucket(0, 1, 'up', 9, 1), bucket(1, 1, 'up', 10, 0)])).toBeCloseTo(0.95, 5);
    expect(availabilityOfBuckets([bucket(0, null, 'none', 0, 0)])).toBeNull();
  });
});

describe('格式化：量纲随大小切换，不输出「0 小时」', () => {
  it('formatDuration', () => {
    expect(formatDuration(30_000)).toBe('30 秒');
    expect(formatDuration(5 * MIN)).toBe('5 分钟');
    expect(formatDuration(90 * MIN)).toBe('1 小时 30 分');
    expect(formatDuration(3 * 60 * MIN)).toBe('3 小时');
    expect(formatDuration(49 * 60 * MIN)).toBe('2 天 1 小时');
  });
  it('formatPercent 与 describeStatusSince', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.9995)).toBe('100%');
    expect(formatPercent(0.98765)).toBe('98.77%');
    expect(formatPercent(null)).toBe('暂无数据');
    expect(describeStatusSince('down', NOW - 12 * MIN, NOW)).toBe('故障已持续 12 分钟');
    expect(describeStatusSince('up', NOW - 3 * 24 * 60 * MIN, NOW)).toBe('已连续正常 3 天');
    expect(describeStatusSince('paused', null, NOW)).toBe('探测已暂停');
    expect(describeStatusSince('unknown', null, NOW)).toBe('状态确认中');
  });
});

describe('分支按项目汇总（主列表只放主站，分支折成汇总行）', () => {
  const br = (branchId: string, branchName: string, profileId: string, over: Partial<UptimeTargetSummary> = {}) => target({
    id: `${branchId}::${profileId}`, source: 'branch', name: `${branchName} / ${profileId}`, branchId, branchName, profileId,
    projectId: 'proj', projectName: 'MAP 平台', branchStatus: 'running', statusSince: NOW - 2 * 60 * MIN, ...over,
  });
  const list = [
    target({ name: '官网', source: 'release' }),
    br('p-main', 'main', 'api'), br('p-main', 'main', 'web'),
    br('p-pay', 'feat/payment-v2', 'api'), br('p-pay', 'feat/payment-v2', 'worker', { measured: false }),
    br('p-search', 'feat/search-index', 'api', { status: 'down', openIncidentSince: NOW - 12 * MIN, lastSample: { t: NOW, up: false, ms: 0, err: 'connect ECONNREFUSED' } }), br('p-search', 'feat/search-index', 'web'),
    br('p-grpc', 'feat/grpc', 'grpc', { measured: false }),
    br('p-old', 'feat/old', 'api', { status: 'paused', branchStatus: 'idle', branchLastActiveAt: new Date(NOW - 3 * 24 * 60 * MIN).toISOString() }),
    br('p-older', 'feat/older', 'api', { status: 'paused', branchStatus: 'idle', branchLastActiveAt: new Date(NOW - 7 * 24 * 60 * MIN).toISOString() }),
  ];

  it('mainSiteTargets 只留生产与自定义', () => {
    expect(mainSiteTargets(list).map((t) => t.name)).toEqual(['官网']);
  });

  it('每个项目一条汇总：运行中 / 正常 / 故障 / 未实测 / 已降温 计数', () => {
    const groups = groupBranchesByProject(list, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ projectId: 'proj', projectName: 'MAP 平台', total: 6, running: 4, ok: 2, bad: 1, unmeasured: 1, idle: 2 });
  });

  it('存活的排前面：运行中（故障优先）→ 未实测 → 已降温（最近活跃在前）', () => {
    const names = groupBranchesByProject(list, NOW)[0].branches.map((b) => [b.branchName, b.bucket, b.tone]);
    expect(names).toEqual([
      ['feat/search-index', 'running', 'bad'],
      ['feat/payment-v2', 'running', 'ok'],
      ['main', 'running', 'ok'],
      ['feat/grpc', 'unmeasured', 'warn'],
      ['feat/old', 'idle', 'muted'],
      ['feat/older', 'idle', 'muted'],
    ]);
  });

  it('分支视图带服务点、代表目标、状态文案与备注', () => {
    const [search, pay] = groupBranchesByProject(list, NOW)[0].branches;
    expect(search.services.map((s) => [s.profileId, s.tone])).toEqual([['api', 'bad'], ['web', 'ok']]);
    expect(search.primary.profileId).toBe('api');
    expect(search.statusText).toBe('故障已持续 12 分钟');
    expect(search.note).toContain('ECONNREFUSED');
    expect(pay.note).toContain('worker 未实测');
    expect(pay.statusText).toContain('已连续正常');
  });

  it('filterBranches 与 sortBranchesAliveFirst', () => {
    const branches = groupBranchesByProject(list, NOW)[0].branches;
    expect(filterBranches(branches, 'bad', '').map((b) => b.branchName)).toEqual(['feat/search-index']);
    expect(filterBranches(branches, 'idle', '').map((b) => b.branchName)).toEqual(['feat/old', 'feat/older']);
    expect(filterBranches(branches, 'all', 'pay').map((b) => b.branchName)).toEqual(['feat/payment-v2']);
    expect(sortBranchesAliveFirst([...branches].reverse()).map((b) => b.branchName)).toEqual(branches.map((b) => b.branchName));
  });
});

describe('mergeBuckets 分支迷你条按各服务合并', () => {
  const bucket = (status: 'up' | 'down' | 'partial' | 'none', up: number, down: number, i: number) => ({ from: i, to: i + 1, up, down, avgLatencyMs: up + down > 0 ? 100 : null, status });

  it('同一段里任一服务失败就不再全绿：一个全绿 + 一个时断时续 → partial', () => {
    const a = [bucket('up', 5, 0, 0), bucket('up', 5, 0, 1), bucket('up', 5, 0, 2)];
    const b = [bucket('up', 5, 0, 0), bucket('partial', 3, 2, 1), bucket('down', 0, 5, 2)];
    expect(mergeBuckets([a, b]).map((x) => x.status)).toEqual(['up', 'partial', 'partial']);
    expect(mergeBuckets([a, b])[2]).toMatchObject({ up: 5, down: 5 });
    expect(mergeBuckets([a, b])[0].avgLatencyMs).toBe(100);
  });

  it('空序列与长度不一致：取公共前缀，全空给空数组', () => {
    expect(mergeBuckets([])).toEqual([]);
    expect(mergeBuckets([[], [bucket('up', 1, 0, 0)]])).toHaveLength(1);
    expect(mergeBuckets([[bucket('none', 0, 0, 0)], [bucket('none', 0, 0, 0), bucket('up', 1, 0, 1)]]).map((x) => x.status)).toEqual(['none']);
  });

  it('BranchModal 用分支合并后的桶，而不是代表目标的桶', () => {
    const src = fs.readFileSync(path.join(REPO, 'web/src/pages/status/BranchModal.tsx'), 'utf8');
    expect(src).toContain('buckets={branch.buckets}');
    expect(src).not.toContain('branch.primary.buckets');
  });
});
