/**
 * 报告台账的列宽守卫（2026-09-15，用户在真实页面上圈出来的）。
 *
 * 坏法很朴素，也很容易再犯：表是 w-full，**只有一列没写宽度**，于是宽屏下所有富余
 * 全灌进那一列。用户看到的是表格中间空出一大片，而那一列的文字只占三分之一。
 *
 * 判据不是「好不好看」，是**列宽有没有被有意分配过**：table-fixed + 表头百分比之和为 100。
 * 少写一列、或者改回「让某列吃掉富余」，都会红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(__dirname, '../..', 'web/src/pages/ReportsPage.tsx'), 'utf8');
const start = (() => {
  const i = page.indexOf('<table className="w-full');
  expect(i, '找不到台账表').toBeGreaterThan(0);
  return i;
})();
/** 只取 `<table ...>` 这一个开标签。整段 thead 里有中文注释提到 table-fixed，
 *  用整段做 toContain 会命中注释——守卫就在用错误的理由通过（实测：删掉 table-fixed
 *  它照样绿）。判据必须落在标签本身。 */
const tableTag = page.slice(start, page.indexOf('>', start) + 1);
const thead = page.slice(start, page.indexOf('</thead>', start));

describe('台账列宽必须是有意分配的', () => {
  it('走 table-fixed：不许再有「谁没写宽度谁吃掉全部富余」', () => {
    expect(tableTag, '表还是自动列宽，富余会全塞进唯一没写宽度的那列').toContain('table-fixed');
  });

  it('每一列都在表头声明了百分比宽度，一列都不许漏', () => {
    const headers = [...thead.matchAll(/<th className="([^"]*)"/g)].map((m) => m[1]);
    expect(headers.length, '表头列数变了，这条守卫要跟着更新').toBe(7);
    for (const [i, cls] of headers.entries()) {
      expect(cls, `第 ${i + 1} 列没有百分比宽度：${cls}`).toMatch(/\bw-\[\d+%\]/);
    }
  });

  it('百分比之和恰好 100，不多不少', () => {
    const pct = [...thead.matchAll(/w-\[(\d+)%\]/g)].map((m) => Number(m[1]));
    expect(pct).toHaveLength(7);
    expect(pct.reduce((a, b) => a + b, 0), `实际合计 ${pct.reduce((a, b) => a + b, 0)}%`).toBe(100);
  });

  it('行内单元格不再各自写死 rem 宽度（table-fixed 下它们不生效，留着只会误导）', () => {
    const body = page.slice(page.indexOf('</thead>'), page.indexOf('</tbody>'));
    const strays = [...body.matchAll(/<td className="[^"]*\bw-\[[\d.]+rem\]/g)].map((m) => m[0]);
    expect(strays, `这些 td 还写着固定宽度：${strays.join(' / ')}`).toEqual([]);
  });

  it('最小宽度容得下这七列，窄屏走横向滚动而不是压扁', () => {
    // 归档时间那列是 18%，里面是 mono 的完整时间戳，min-w 太小它会被压破。
    const m = tableTag.match(/min-w-\[(\d+)rem\]/);
    expect(m, '表没有 min-w，窄屏会把列压扁').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(72);
  });

  it('标题能断行：table-fixed 下超长标题撑不破列，只能换行', () => {
    expect(page).toMatch(/<div className="break-words font-semibold text-foreground">\{r\.title\}<\/div>/);
  });
});
