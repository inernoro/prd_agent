/**
 * 缺陷归因简报纯计算层的判据测试。
 *
 * 这里锁的是**行为**，不是实现字面量（predicate-and-wiring-discipline 形状 4a）：
 * 每条用例都描述一个「换个等价写法就该给同样答案」或「口径搞错就会静默算错」的场景。
 *
 * 红绿闭环记录（2026-08-02，每条都实测过）：
 *   - 把 normalizeSeverity 的正则去掉 `i` 标志 → 「大小写与写法归一化」套件变红
 *   - 把「有 defectRows 就忽略 defectCounts」改成两者相加 → 「不重复计数」用例变红
 *   - 把 normalizeModuleKey 的 toLowerCase / 分隔符规范化删掉 → 「同一模块不分裂」变红
 */
import { describe, it, expect } from 'vitest';
import {
  buildDefectDigest,
  normalizeDefectCounts,
  normalizeModuleKey,
  normalizeSeverity,
  UNLABELLED_MODULE,
  type DigestReportInput,
} from '../../src/services/acceptance-defect-digest.js';

function report(overrides: Partial<DigestReportInput> & { id: string }): DigestReportInput {
  return {
    title: `报告 ${overrides.id}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeSeverity — 严重度写法归一化', () => {
  // 生产端的写法是自由的：cdscli 写小写、报告正文写大写、markdown 表格里可能带星号。
  // 只认一种写法的判据会静默永不命中，且日志里看不出任何异常。
  const equivalent: Array<[unknown, string]> = [
    ['P0', 'P0'],
    ['p0', 'P0'],
    [' P1 ', 'P1'],
    ['**P2**', 'P2'],
    ['`p3`', 'P3'],
    ['　p1　', 'P1'],       // 全角空格
    ['P 1', 'P1'],          // 中间有空格
    ['P3 视觉瑕疵', 'P3'],  // 夹在长文本里
  ];
  for (const [input, expected] of equivalent) {
    it(`把 ${JSON.stringify(input)} 认成 ${expected}`, () => {
      expect(normalizeSeverity(input)).toBe(expected);
    });
  }

  const rejected: unknown[] = ['', 'P4', 'blocker', 'PP0', null, undefined, 42, 'P10'];
  for (const input of rejected) {
    it(`不把 ${JSON.stringify(input)} 误认成任何等级`, () => {
      expect(normalizeSeverity(input)).toBeNull();
    });
  }
});

describe('normalizeDefectCounts — 聚合计数归一化', () => {
  it('大小写不同的同一个桶要相加，而不是分裂成两个键', () => {
    const out = normalizeDefectCounts({ p0: 1, P0: 2, P1: 3 });
    expect(out.counts.P0).toBe(3);
    expect(out.counts.P1).toBe(3);
    expect(out.hasAny).toBe(true);
  });

  it('归一化不出 P0-P3 的键计入 unclassified，而不是被静默吞掉', () => {
    const out = normalizeDefectCounts({ blocker: 2, P1: 1 });
    expect(out.counts.P1).toBe(1);
    expect(out.unclassified).toBe(2);
  });

  it('零值 / 负数 / 非数字不计入', () => {
    const out = normalizeDefectCounts({ P0: 0, P1: -3, P2: 'abc', P3: '2' });
    expect(out.counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 2 });
  });

  it('非对象输入安全降级', () => {
    expect(normalizeDefectCounts(null).hasAny).toBe(false);
    expect(normalizeDefectCounts([1, 2]).hasAny).toBe(false);
    expect(normalizeDefectCounts('P0=1').hasAny).toBe(false);
  });
});

describe('normalizeModuleKey — 模块聚类键', () => {
  it('大小写 / 空白 / 分隔符差异不该把同一个模块分裂成两簇', () => {
    const keys = new Set([
      normalizeModuleKey('视觉创作/编辑器'),
      normalizeModuleKey('视觉创作 / 编辑器'),
      normalizeModuleKey('视觉创作／编辑器'),
      normalizeModuleKey('**视觉创作/编辑器**'),
      normalizeModuleKey('  视觉创作/编辑器  '),
    ]);
    expect(keys.size).toBe(1);
  });

  it('英文大小写归一', () => {
    expect(normalizeModuleKey('Reports/Viewer')).toBe(normalizeModuleKey('reports/viewer'));
  });

  it('空值返回空串，交由调用方决定落到哪一簇', () => {
    expect(normalizeModuleKey('')).toBe('');
    expect(normalizeModuleKey(null)).toBe('');
  });
});

describe('buildDefectDigest — 简报聚合', () => {
  it('按模块聚类，缺陷数降序，且每簇带得回报告 id', () => {
    const digest = buildDefectDigest([
      report({
        id: 'r1',
        verdict: 'fail',
        defectRows: [
          { severity: 'P0', symptom: '预览空白', module: '视觉创作/编辑器' },
          { severity: 'p1', symptom: '缩略图错位', module: '视觉创作 / 编辑器' },
        ],
      }),
      report({
        id: 'r2',
        verdict: 'conditional',
        defectRows: [
          { severity: 'P2', symptom: '按钮偏移', module: '视觉创作/编辑器' },
          { severity: 'P3', symptom: '文案错别字', module: '报告中心' },
        ],
      }),
    ]);

    expect(digest.reportCount).toBe(2);
    expect(digest.reportsWithDefectRows).toBe(2);
    expect(digest.severityTotals).toEqual({ P0: 1, P1: 1, P2: 1, P3: 1 });
    expect(digest.verdictTotals).toEqual({ pass: 0, conditional: 1, fail: 1, unknown: 0 });

    expect(digest.clusters).toHaveLength(2);
    const [top, second] = digest.clusters;
    expect(top.defectCount).toBe(3);
    // 同一模块的两种写法必须合并到一簇，且两份报告都追溯得到
    expect(top.reportIds).toEqual(['r1', 'r2']);
    expect(top.worstSeverity).toBe('P0');
    expect(second.defectCount).toBe(1);
    expect(second.reportIds).toEqual(['r2']);
  });

  it('有逐行证据时忽略聚合计数，不重复计数', () => {
    // 同一份报告两个来源都在（归档脚本会同时上传），相加就会把 2 条缺陷算成 4 条，
    // 而两个字段都真实存在，日志里看不出任何异常。
    const digest = buildDefectDigest([
      report({
        id: 'r1',
        defectCounts: { P0: 1, P1: 1 },
        defectRows: [
          { severity: 'P0', module: 'A' },
          { severity: 'P1', module: 'A' },
        ],
      }),
    ]);
    expect(digest.severityTotals).toEqual({ P0: 1, P1: 1, P2: 0, P3: 0 });
    expect(digest.reportsWithDefectRows).toBe(1);
    expect(digest.reportsWithCountsOnly).toBe(0);
  });

  it('只有聚合计数时用它兜底，但不参与模块聚类', () => {
    const digest = buildDefectDigest([
      report({ id: 'r1', defectCounts: { p1: 2, blocker: 1 } }),
    ]);
    expect(digest.severityTotals.P1).toBe(2);
    expect(digest.unclassifiedDefectCount).toBe(1);
    expect(digest.reportsWithCountsOnly).toBe(1);
    // 聚合数字里没有模块信息，硬塞进「未标注模块」会让那一簇虚高到没法看
    expect(digest.clusters).toHaveLength(0);
  });

  it('缺陷行没写模块时落到「未标注模块」，不凭空消失', () => {
    const digest = buildDefectDigest([
      report({ id: 'r1', defectRows: [{ severity: 'P1', symptom: '未知' }] }),
    ]);
    expect(digest.clusters).toHaveLength(1);
    expect(digest.clusters[0].label).toBe(UNLABELLED_MODULE);
    expect(digest.severityTotals.P1).toBe(1);
  });

  it('严重度认不出的缺陷行不计入，也不撑出空簇', () => {
    const digest = buildDefectDigest([
      report({ id: 'r1', defectRows: [{ severity: '待定', symptom: 'x', module: 'A' }] }),
    ]);
    expect(digest.severityTotals).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
    expect(digest.clusters).toHaveLength(0);
    expect(digest.reportsWithDefectRows).toBe(0);
  });

  it('since 窗口把更早的报告排除在外', () => {
    const digest = buildDefectDigest([
      report({ id: 'old', createdAt: '2026-07-01T00:00:00.000Z', defectRows: [{ severity: 'P0', module: 'A' }] }),
      report({ id: 'new', createdAt: '2026-08-01T00:00:00.000Z', defectRows: [{ severity: 'P1', module: 'A' }] }),
    ], { since: '2026-07-15T00:00:00.000Z' });
    expect(digest.reportCount).toBe(1);
    expect(digest.severityTotals).toEqual({ P0: 0, P1: 1, P2: 0, P3: 0 });
    expect(digest.clusters[0].reportIds).toEqual(['new']);
  });

  it('根因结论按次数降序统计并保留报告 id', () => {
    const digest = buildDefectDigest([
      report({ id: 'r1', rootCauseRows: [{ conclusion: '覆盖缺口' }, { conclusion: '产品失败' }] }),
      report({ id: 'r2', rootCauseRows: [{ conclusion: '覆盖缺口' }] }),
    ]);
    expect(digest.rootCauses[0]).toMatchObject({ conclusion: '覆盖缺口', count: 2 });
    expect(digest.rootCauses[0].reportIds).toEqual(['r1', 'r2']);
    expect(digest.rootCauses[1]).toMatchObject({ conclusion: '产品失败', count: 1 });
  });

  it('未判定 verdict 归入 unknown，不静默丢弃', () => {
    const digest = buildDefectDigest([report({ id: 'r1' }), report({ id: 'r2', verdict: 'pass' })]);
    expect(digest.verdictTotals).toEqual({ pass: 1, conditional: 0, fail: 0, unknown: 1 });
  });

  it('每簇最多 3 条样例，避免弹窗被单簇刷屏', () => {
    const digest = buildDefectDigest([
      report({
        id: 'r1',
        defectRows: Array.from({ length: 6 }, (_, i) => ({ severity: 'P2', symptom: `问题${i}`, module: 'A' })),
      }),
    ]);
    expect(digest.clusters[0].defectCount).toBe(6);
    expect(digest.clusters[0].samples).toHaveLength(3);
  });

  it('空输入返回结构完整的零值简报（前端不必判空）', () => {
    const digest = buildDefectDigest([]);
    expect(digest.reportCount).toBe(0);
    expect(digest.severityTotals).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
    expect(digest.clusters).toEqual([]);
    expect(digest.rootCauses).toEqual([]);
  });
});
