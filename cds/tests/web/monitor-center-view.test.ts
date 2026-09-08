/**
 * 监控中心视图纯函数（lib/monitorCenter）真值断言。
 *
 * 这些函数决定第一屏说什么、列表怎么筛怎么排、默认点开谁、数字怎么读——
 * 全是「看起来对、编译过、通读也挑不出」的判据，只能拿真值锁。
 */

import { describe, it, expect } from 'vitest';
import {
  availabilityOfBuckets,
  buildMonitorHeadline,
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

const NOW = Date.parse('2026-09-08T10:00:00.000Z');
const MIN = 60_000;

function target(over: Partial<UptimeTargetSummary>): UptimeTargetSummary {
  return {
    id: over.name || 'x', source: 'branch', name: 'x', branchId: '', projectId: '', profileId: '', probeKind: 'http',
    status: 'up', lastSample: null, availability24h: 1, availability7d: 1, avgLatencyMs24h: 100, sampleCount24h: 10,
    buckets: [], openIncidentSince: null, statusSince: null, incidentCount: 0, probeDescription: '',
    intervalSeconds: 60, timeoutMs: 5000, ...over,
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
    expect(h.title).toBe('全部 2 个目标正常');
    expect(h.detail).toContain('99.50%');
    expect(h.detail).toContain('恢复了 1 次故障');
    expect(h.detail).toContain('a（持续 2 分钟）');
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
