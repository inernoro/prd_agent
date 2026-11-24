/**
 * Codex 第十七轮（PR #1532，reviewed commit 45a2076c7f）里判为 A 类的一条。
 *
 * 根因卡上的「N 份」是一个承诺：点进去要能看到那 N 份。openCluster 放开了类型页签、
 * 被取代版本与页码，却漏了文件夹与系统视图——读者在「不通过」视图里点开一张原则性
 * 通过的根因卡，台账会是空的，而链接刚写着有几份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PAGE = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/src/pages/ReportsPage.tsx'), 'utf8');
const openCluster = (() => {
  const start = PAGE.indexOf('const openCluster = useCallback(');
  expect(start, '找不到 openCluster').toBeGreaterThan(0);
  const end = PAGE.indexOf('const filterMenu', start);
  expect(end).toBeGreaterThan(start);
  return PAGE.slice(start, end);
})();

describe('根因下钻要放开全部会挡住行的筛选', () => {
  it('四道筛选一个不漏：搜索、文件夹与系统视图、类型页签、被取代版本', () => {
    expect(openCluster, '没设搜索词').toContain('onSearchChange(cluster.target)');
    expect(openCluster, '文件夹与系统视图没放开，从「不通过」视图点开会是空台账')
      .toContain("onFilterSelect('all')");
    expect(openCluster, '类型页签没放开').toContain("setKindFilter('all')");
    expect(openCluster, '被取代的版本没放出来，「全部报告」就不全').toContain('setShowSuperseded(true)');
    expect(openCluster, '没回到第一页').toContain('setPage(0)');
  });

  it('依赖数组带上 onFilterSelect，不会拿到过期的闭包', () => {
    expect(openCluster).toMatch(/\}, \[[^\]]*onFilterSelect[^\]]*\]\);/);
  });
});
