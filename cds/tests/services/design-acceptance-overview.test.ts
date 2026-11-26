import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureDesignPage, observeDesignRules } from '../../src/services/design-acceptance-observations.js';
import type { DesignRule } from '../../src/shared/design-workspace.js';

const rule: DesignRule = { id: 'A-64', screenId: 'dsn-accept', how: 'measure', priority: 'high',
  slots: ['desktop-light', 'desktop-dark'], rule: '验收总览先给结论，再按顺序展示目标、原因和下一步' };

const causes = [
  { type: 'preview', title: '验收提交已过期', affected: 3, effect: '阻止补证据和签收', who: '实现方', action: '重新运行' },
  { type: 'fail', title: '验收未通过', affected: 1, effect: '阻止签收', who: '实现方', action: '看不通过的项' },
  { type: 'evidence', title: '缺少对照图', affected: 1, effect: '无法完成对照', who: '实现方', action: '补证据' },
];
const methods = ['覆盖', '冒烟', '对照图', '视觉', '回归', '流程', '人工', '验收债务'];

const fixture = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 24px; }
  .dw-ac-hero { display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px; }
</style><main><section class="dw-ac" data-objective="true"><ol class="dw-ac-items">
  <li data-item="verdict"><div class="dw-ac-hero"><strong>暂不能签收</strong><span>目标达成 1/2</span>
    <span>验收项 3</span><span>通过 1</span><span>不通过 1</span><span>缺证据 1</span></div></li>
  <li data-item="goals"><ol class="dw-ac-goals">
    <li data-state="passed"><div><strong>可查看列表</strong><small>列表正常加载</small></div>
      <span><code class="dw-ac-goal-rule" data-state="passed">A-01</code></span><span class="dw-status" data-state="passed">达成</span></li>
    <li data-state="failed"><div><strong>可查看对照</strong><small>对照布局和图片加载都正常</small></div>
      <span><code class="dw-ac-goal-rule" data-state="failed">A-02</code><code class="dw-ac-goal-rule" data-state="unverified">A-03</code></span>
      <span class="dw-status" data-state="failed">未达成</span></li>
  </ol></li>
  <li data-item="causes"><ol class="dw-ac-causes dw-ac-cards">${causes.map(({ type, title, affected, effect, who, action }, index) =>
    `<li data-cause="${type}"><strong><b aria-hidden="true">${index + 1}</b>${title}</strong>
      <span class="dw-ac-arrow" aria-hidden="true">→</span><span class="dw-ac-effect"><small>${who}</small>
      <span class="dw-ac-impact"><span class="dw-ac-affected">${affected} 项</span> · <span class="dw-ac-consequence">${effect}</span></span>
      <details><summary>看清单</summary><p>页头宽 1154.4375 px</p></details></span>
      <span class="dw-ac-cause-act"><button type="button">${action}</button></span></li>`).join('')}</ol></li>
  <li data-item="trace"><div class="dw-ac-trace">
    <button data-stage="need"><small>需求条款</small><strong>1</strong></button>
    <button data-stage="items"><small>验收项</small><strong>3</strong></button>
    <button data-stage="clauses"><small>条款结论</small><strong>0/1</strong></button></div></li>
  <li data-item="by-screen"><ul class="dw-ac-byscreen"><li data-worst="0">
    <button class="dw-ac-byscreen-row"><span class="dw-ac-byscreen-name">对照</span><span class="dw-ac-dots"><i data-status="failed"></i></span></button>
  </li></ul></li>
  <li data-item="methods"><ul class="dw-ac-mcards">${methods.map(name =>
    `<li data-status="enabled"><button><strong>${name}</strong><span>进行中 · 智能体</span><small>完成 1/2</small></button></li>`).join('')}</ul></li>
  <li data-item="videos"><div aria-label="动画：全部验收手段">验收方式演示</div></li>
  <li data-item="steps"><ol class="dw-ac-steps"><li data-state="current"><strong>运行验收</strong><small>先核对预览提交</small></li>
    <li data-state="later"><strong>签收</strong><small>尚缺 1 个画面的复验</small></li></ol></li>
</ol></section></main>`;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }),
  });
});

afterAll(async () => { await browser?.close(); });

async function evaluateOverview(change?: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  try {
    await page.setContent(fixture);
    await change?.(page);
    return observeDesignRules([rule], await measureDesignPage(page))[rule.id];
  } finally {
    await page.close();
  }
}

describe('A-64 overview structural evidence', () => {
  it('measures the visible structure while leaving controls that were not exercised unverified', async () => {
    const result = await evaluateOverview();
    expect(result).toMatchObject({ status: 'unverified' });
    expect(result.actual).toContain('原因卡 3 张');
    expect(result.actual).toContain('验收手段 8 个');
  });

  it('keeps a cause visible when the current viewer cannot run its one action', async () => {
    const result = await evaluateOverview(page => page.locator('[data-cause="preview"] button').evaluate(button => {
      (button as HTMLButtonElement).disabled = true;
    }));
    expect(result).toMatchObject({ status: 'unverified' });
  });

  const deviations: Array<[string, Parameters<typeof evaluateOverview>[0]]> = [
    ['缺少四个计数中的一项', page => page.getByText('缺证据 1', { exact: true }).evaluate(element => element.remove())],
    ['通过、不通过和待补项之和超过验收总数', page => page.getByText('验收项 3', { exact: true }).evaluate(element => {
      element.textContent = '验收项 2';
    })],
    ['结论计数折成两行', page => page.locator('.dw-ac-hero').evaluate(element => { element.style.width = '280px'; })],
    ['缺少需求追溯区', page => page.locator('[data-item="trace"]').evaluate(element => element.remove())],
    ['原因区排到目标区之前', page => page.locator('[data-item="causes"]').evaluate(element => {
      element.parentElement!.querySelector('[data-item="goals"]')!.before(element);
    })],
    ['同一原因出现两张卡', page => page.locator('[data-cause="fail"]').evaluate(element => element.setAttribute('data-cause', 'evidence'))],
    ['旧提交原因没有排首位', page => page.locator('[data-cause="preview"]').evaluate(element => element.parentElement!.append(element))],
    ['影响数量缺失', page => page.locator('[data-cause="preview"] .dw-ac-affected').evaluate(element => element.remove())],
    ['后果被藏入清单', page => page.locator('[data-cause="fail"]').evaluate(element => {
      element.querySelector('details')!.append(element.querySelector('.dw-ac-consequence')!);
    })],
    ['没有写负责方', page => page.locator('[data-cause="fail"] .dw-ac-effect > small').evaluate(element => element.remove())],
    ['有超过一个处理按钮', page => page.locator('[data-cause="fail"] .dw-ac-cause-act button').evaluate(element => element.after(element.cloneNode(true)))],
    ['量值原文出现在卡片可见正文', page => page.locator('[data-cause="evidence"] .dw-ac-effect').evaluate(element => {
      element.insertAdjacentHTML('afterbegin', '<p>页头宽 1154.4375 px</p>');
    })],
    ['量值原文的清单默认展开', page => page.locator('[data-cause="evidence"] details').evaluate(element => element.setAttribute('open', ''))],
  ];

  it.each(deviations)('判定失败，当%s', async (_description, change) => {
    expect(await evaluateOverview(change)).toMatchObject({ status: 'failed' });
  });
});
