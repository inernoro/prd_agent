/**
 * Codex review（PR #1532）第九轮的前端一条：换档失败时按钮在撒谎。
 *
 * 第三轮我把换档改成静默刷新（不让一屏读得懂的图凭空消失）。副作用是：换档请求失败
 * 时也静默保留——按钮已经跳到「近 7 天」，屏幕上还是 30 天那份数据，既没报错也没有
 * 陈旧提示。保留是对的，但只对**同一档**的刷新成立。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(__dirname, '../..', 'web/src/pages/ReportsPage.tsx'), 'utf8');
const loadPipeline = (() => {
  const start = page.indexOf('const loadPipeline = useCallback(');
  const end = page.indexOf('useEffect(() => { void loadPipeline', start);
  expect(start, '找不到 loadPipeline').toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
})();

describe('静默保留只对同一档成立', () => {
  it('保留条件里带上了档位比较，不是只看 quiet', () => {
    expect(loadPipeline, '换档失败仍然静默保留，按钮与数据对不上')
      .toMatch(/prev\.pipeline\.recentDays \?\? null\) === \(wantDays \?\? null\)/);
    expect(loadPipeline).toMatch(/quiet && sameWindow\(prev\)/);
    expect(loadPipeline, '又退回了只看 quiet 的旧条件')
      .not.toMatch(/quiet && prev\.status === 'ok'\s*\n?\s*\?/);
  });

  it('比较的是这次请求要的档位，不是渲染时刻的档位', () => {
    // wantDays 在请求发出前抓取。直接读 overviewDays 的话，快速连点两次时
    // 比较的是最新那一档，判断又会错——而且错得更难查。
    expect(loadPipeline).toMatch(/const wantDays = overviewDays;/);
  });

  it('同一档的刷新（报告增删后重算）仍然静默，不退回 loading', () => {
    expect(page).toMatch(/useEffect\(\(\) => \{ void loadPipeline\(true\); \}, \[loadPipeline\]\);/);
    expect(page).toMatch(/void loadPipeline\(true\);/);
  });

  it('后端确实回传了这个档位，前端不是拿自己记的值自证', () => {
    const api = readFileSync(resolve(__dirname, '../..', 'web/src/lib/api.ts'), 'utf8');
    const block = api.slice(api.indexOf('export interface PipelineOverview'), api.indexOf('export interface PipelineSeries'));
    expect(block, 'PipelineOverview 没有 recentDays，上面的比较就是自说自话')
      .toMatch(/recentDays/);
  });
});

/**
 * Codex review 第十轮：上一轮那个修复只修了失败路径，成功路径原样直写。
 * 连点两下档位时两个请求在飞，慢的那个后回来会把新结果盖掉——按钮停在 30 天、
 * 数字却是 7 天的，而且不报错、没有陈旧提示。
 */
describe('后发的请求让先发的作废', () => {
  it('成功路径带了代次判断，不再无条件直写', () => {
    expect(loadPipeline, '成功路径仍然无条件 setPipelineState，慢响应会盖掉新结果')
      .toMatch(/if \(superseded\(\)\) return;\s*\n\s*setPipelineState\(\{ status: 'ok'/);
  });

  it('失败路径也丢弃过期响应（早已无关的报错不许盖掉新数据）', () => {
    const catchBody = loadPipeline.slice(loadPipeline.indexOf('} catch (err) {'));
    expect(catchBody).toMatch(/if \(superseded\(\)\) return;/);
  });

  it('代次来自 ref 且每次请求自增，不是拿档位当身份', () => {
    // 两次都选同一档时（删报告触发的重算恰好与一次换档并发），按档位分不出先后，
    // 仍会用旧数据盖新数据。所以身份必须是单调自增的代次。
    expect(page).toMatch(/const pipelineReqRef = useRef\(0\);/);
    expect(loadPipeline).toMatch(/const gen = \(pipelineReqRef\.current \+= 1\);/);
    expect(loadPipeline).toMatch(/pipelineReqRef\.current !== gen/);
  });

  it('请求用的是这一次抓下来的档位，不是渲染时刻的闭包值', () => {
    expect(loadPipeline).toMatch(/fetchReportsPipeline\(\{ recentDays: wantDays \}\)/);
  });
});
