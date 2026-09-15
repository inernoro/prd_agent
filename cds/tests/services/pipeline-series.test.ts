/**
 * 验收流水线日序列的守卫（2026-09-14）。
 *
 * 这段代码的坏法全是静默的：
 *
 * 1. **口径分裂**。总览把重复归档折叠成一版，序列如果不折叠，同一屏上曲线的
 *    合计会比数字大，而两边都「看起来对」。（形状 3）
 * 2. **空白日变成缺项**。没有数据的那天如果不给 0 而是跳过，折线会在 41 个
 *    没人验收的日子之间直接连线，把停摆画成一条平滑的斜坡。（形状 8：
 *    把不成立的证据当证据）
 * 3. **凭空补上部署那条线**。分支只记 lastDeployAt（最后一次），不是历史。
 *    谁按天分桶它，谁就是在编数据。
 */
import { describe, it, expect } from 'vitest';
import { buildPipelineSeries, buildPipelineOverview } from '../../src/services/acceptance-pipeline.js';
import type { AcceptanceReportMeta, BranchEntry, Project } from '../../src/types.js';

const NOW = new Date('2026-09-10T06:00:00.000Z');

function project(id: string, name: string): Project {
  return { id, name, repoUrl: '', createdAt: '2026-06-01T00:00:00.000Z' } as unknown as Project;
}
function branch(id: string, projectId: string, createdAt: string): BranchEntry {
  return { id, projectId, branch: id, createdAt, services: {} } as unknown as BranchEntry;
}
let seq = 0;
function report(p: Partial<AcceptanceReportMeta> & { createdAt: string }): AcceptanceReportMeta {
  seq += 1;
  return {
    id: `r${seq}`,
    title: p.title ?? `功能验收 · 目标${seq} · 2026-09-01`,
    format: 'md',
    projectId: 'p1',
    verdict: 'pass',
    tier: null,
    defectCounts: null,
    branch: `feat/${seq}`,
    ...p,
  } as unknown as AcceptanceReportMeta;
}

describe('日序列：每条数组都与 days 等长，空白日是 0 不是缺项', () => {
  const s = buildPipelineSeries(
    [project('p1', 'MAP')],
    [branch('b1', 'p1', '2026-09-08T01:00:00.000Z')],
    [report({ createdAt: '2026-09-09T02:00:00.000Z', verdict: 'fail' })],
    { days: 30, now: NOW },
  );

  it('days 连续且长度等于请求天数', () => {
    expect(s.days).toHaveLength(30);
    expect(s.days[s.days.length - 1]).toBe('2026-09-10');
    for (let i = 1; i < s.days.length; i += 1) {
      const prev = Date.parse(`${s.days[i - 1]}T00:00:00Z`);
      const cur = Date.parse(`${s.days[i]}T00:00:00Z`);
      expect(cur - prev, `${s.days[i - 1]} 到 ${s.days[i]} 之间跳了天`).toBe(86400000);
    }
  });

  it.each(['changes', 'pass', 'conditional', 'fail', 'undetermined'] as const)(
    '%s 与 days 等长',
    (k) => {
      expect(s[k]).toHaveLength(s.days.length);
      // 缺项会让前端在空白日直接连线；必须是实打实的 0。
      for (const v of s[k]) expect(typeof v).toBe('number');
    },
  );

  it('没有数据的那天是 0，不是 undefined', () => {
    const zeroDays = s.days.filter((_, i) => s.pass[i] === 0 && s.fail[i] === 0);
    expect(zeroDays.length).toBeGreaterThan(20);
    expect(s.fail.filter((v) => v > 0)).toHaveLength(1);
  });

  it('项目序列也与 days 等长', () => {
    for (const p of s.projects) expect(p.counts).toHaveLength(s.days.length);
  });
});

describe('口径必须与总览同源：重复归档只算一版', () => {
  // 同一个验收目标归档三次：总览折叠成一版，序列也必须折叠，否则曲线上出现假峰。
  const dup = [
    report({ title: '功能验收 · 同一个目标 · 2026-09-01', branch: 'feat/x', createdAt: '2026-09-05T01:00:00.000Z', verdict: 'fail' }),
    report({ title: '功能验收 · 同一个目标 · 2026-09-01', branch: 'feat/x', createdAt: '2026-09-05T02:00:00.000Z', verdict: 'fail' }),
    report({ title: '功能验收 · 同一个目标 · 2026-09-01', branch: 'feat/x', createdAt: '2026-09-05T03:00:00.000Z', verdict: 'pass' }),
  ];
  const projects = [project('p1', 'MAP')];
  const branches = [branch('feat/x', 'p1', '2026-09-04T00:00:00.000Z')];

  it('三次归档在序列里只留一份', () => {
    const s = buildPipelineSeries(projects, branches, dup, { days: 30, now: NOW });
    const total = s.pass.reduce((a, b) => a + b, 0)
      + s.conditional.reduce((a, b) => a + b, 0)
      + s.fail.reduce((a, b) => a + b, 0)
      + s.undetermined.reduce((a, b) => a + b, 0);
    expect(total, '没折叠：同一个目标的三次归档被当成三份').toBe(1);
  });

  it('序列的结论合计不超过总览的已验收口径来源', () => {
    const s = buildPipelineSeries(projects, branches, dup, { days: 30, now: NOW });
    const o = buildPipelineOverview(projects, branches, [], dup, {});
    const seriesVerdicts = s.pass.reduce((a, b) => a + b, 0)
      + s.conditional.reduce((a, b) => a + b, 0)
      + s.fail.reduce((a, b) => a + b, 0);
    // 两边都走 foldReportVersions，所以序列里的结论数不该超过总览统计到的三档合计。
    expect(seriesVerdicts).toBeLessThanOrEqual(o.total.pass + o.total.conditional + o.total.fail + 1);
  });
});

describe('结论为空不是第四种结论', () => {
  it('verdict 缺失落进 undetermined，不混进三档', () => {
    const s = buildPipelineSeries(
      [project('p1', 'MAP')],
      [],
      [report({ createdAt: '2026-09-09T02:00:00.000Z', verdict: null as never, branch: 'feat/none' })],
      { days: 30, now: NOW },
    );
    expect(s.undetermined.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.pass.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.conditional.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.fail.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('无主报告不丢也不冒充项目', () => {
  it('projectId 缺失的报告单列一行并写明', () => {
    const s = buildPipelineSeries(
      [project('p1', 'MAP')],
      [],
      [report({ createdAt: '2026-09-09T02:00:00.000Z', projectId: null as never, branch: 'feat/orphan' })],
      { days: 30, now: NOW },
    );
    const row = s.projects.find((p) => p.projectId === null);
    expect(row, '无主报告被丢掉了').toBeTruthy();
    expect(row!.projectName).toContain('无主');
    // 「那一行在」是个太松的判据：counts 全零、只有 total 的行照样通过，
    // 而页面上它是一条贴零的直线，等于报告凭空消失。红绿验证时实测过。
    expect(row!.total).toBe(1);
    expect(row!.counts.reduce((a, b) => a + b, 0), '无主那行有 total 没有日值').toBe(row!.total);
  });
});

describe('部署那条线不许出现', () => {
  it('序列里没有任何部署字段，且明着标出原因', () => {
    const s = buildPipelineSeries([project('p1', 'MAP')], [], [], { days: 7, now: NOW });
    // 加一条 deployed/deploys 序列是最容易犯的「补全」——它只可能是编的。
    expect(Object.keys(s)).not.toContain('deployed');
    expect(Object.keys(s)).not.toContain('deploys');
    expect(s.deployNote).toBe('no-deploy-history');
  });

  it('源码里没有按天分桶 lastDeployAt 的地方', () => {
    // 这是形状 6：lastDeployAt 是个真实存在、读得到的值，按天分桶不会报错，
    // 只会得到「最后一次部署时间的分布」，然后被当成部署历史。
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../src/services/acceptance-pipeline.ts'),
      'utf8',
    );
    const seriesBlock = src.slice(src.indexOf('export function buildPipelineSeries'));
    expect(seriesBlock).not.toMatch(/dayKey\([^)]*lastDeployAt/);
  });
});

describe('末格是不是完整一天，必须说得出来', () => {
  it('UTC 零点之后的任何时刻，末格都是不完整的', () => {
    const s = buildPipelineSeries([], [], [], { days: 7, now: new Date('2026-09-10T06:00:00.000Z') });
    expect(s.lastDayPartial).toBe(true);
  });

  it('正好 UTC 零点时末格是完整的', () => {
    const s = buildPipelineSeries([], [], [], { days: 7, now: new Date('2026-09-10T00:00:00.000Z') });
    expect(s.lastDayPartial).toBe(false);
  });
});

describe('窗口外的数据不进序列', () => {
  it('早于窗口起点的分支与报告都不计入', () => {
    const s = buildPipelineSeries(
      [project('p1', 'MAP')],
      [branch('old', 'p1', '2026-01-01T00:00:00.000Z')],
      [report({ createdAt: '2026-01-02T00:00:00.000Z', branch: 'feat/old' })],
      { days: 7, now: NOW },
    );
    expect(s.changes.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.pass.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
