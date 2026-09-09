/**
 * 簇标签的 ×N 必须数「被命名的那一类」（2026-09-09）。
 *
 * 事故：「昨日全部改动」是 1 份未通过 + 2 份有条件，簇标签写死用 c.count，
 * 渲染成「未通过 ×3」——把两份有条件也说成了未通过。这页存在的意义就是不让
 * 口径这样糊，源码里因此钉一条守卫：标签只许引 failCount / conditionalCount。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../../web/src/pages/reports/ReportsOverview.tsx', import.meta.url)),
  'utf-8',
);

describe('未通过与待决的簇标签', () => {
  it('未通过 / 有条件的 ×N 引的是分类计数，不是簇的总份数', () => {
    expect(source).toContain('`未通过 ×${c.failCount}`');
    expect(source).toContain('`有条件 ×${c.conditionalCount}`');
    expect(source).not.toContain('`未通过 ×${c.count}`');
    expect(source).not.toContain('`有条件 ×${c.count}`');
  });

  it('未通过簇里夹着有条件时，行内要把那几份单独说出来', () => {
    expect(source).toContain("c.verdict === 'fail' && c.conditionalCount > 0");
    expect(source).toContain('另有条件 ×');
  });
});
