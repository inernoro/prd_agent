/**
 * Codex review（PR #1532）第三轮的前端一条：时间窗按钮在首页是个哑巴。
 *
 * 首页（跨项目）渲染的是 PipelinePanel，不是 ReportsOverviewPanel。
 * 而「近 7 / 14 / 30 天」只改 overviewDays，overviewDays 只喂给 fetchReportsOverview——
 * 于是在首页按它只会换个选中底色，屏幕上一个数都不动。
 * 这类坏法不报错、不变红，通读任一侧代码也挑不出来
 * （predicate-and-wiring-discipline 形状 2：链路只建一半）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(__dirname, '../..', 'web/src/pages/ReportsPage.tsx'), 'utf8');

/** loadPipeline 那个 useCallback 的完整函数体（含依赖数组）。 */
const loadPipeline = (() => {
  const start = page.indexOf('const loadPipeline = useCallback(');
  expect(start, '找不到 loadPipeline').toBeGreaterThan(0);
  const end = page.indexOf('useEffect(() => { void loadPipeline', start);
  expect(end, '找不到 loadPipeline 的副作用').toBeGreaterThan(start);
  return page.slice(start, end);
})();

describe('时间窗按钮必须真的改变首页看到的数', () => {
  it('按钮改的那个值（overviewDays）进了流水线请求', () => {
    expect(loadPipeline, 'fetchReportsPipeline 还是空参数，按钮在首页什么都不改')
      .toMatch(/fetchReportsPipeline\(\{\s*recentDays:\s*overviewDays\s*\}\)/);
  });

  it('依赖数组带上它，换档才会重新请求', () => {
    // 只改调用不改依赖的话，useCallback 会一直捕获首挂那一档，
    // 按钮照样是哑巴——而且更难查，因为代码里明明写着 recentDays。
    expect(loadPipeline).toMatch(/\}, \[overviewDays\]\);/);
  });

  it('换档时不把已经读得懂的一屏图打回 loading', () => {
    // 首挂时 pipelineState 本来就是 loading，骨架照常显示；
    // 之后换档走 quiet，图表不会凭空消失一下再回来。
    expect(page).toMatch(/useEffect\(\(\) => \{ void loadPipeline\(true\); \}, \[loadPipeline\]\);/);
  });

  it('按钮本身仍然只在没选中报告时出现，且三档不变', () => {
    expect(page).toMatch(/const OVERVIEW_WINDOWS = \[7, 14, 30\] as const;/);
    expect(page).toMatch(/aria-label="结论时间窗"/);
  });

  it('走向图是独立的 90 天层，不跟着时间窗缩', () => {
    // 7 天窗 + 7 日滚动 = 一个点，图就没了。各卡片在自己那一行印出真实区间。
    expect(loadPipeline).not.toMatch(/seriesDays/);
  });
});
