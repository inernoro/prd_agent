/**
 * 就地 diff 渲染链取证：在真实部署的 /_mockup/selection-diff-probe 上跑，无需登录。
 * 断言的是「浏览器里真的算出了什么」——ins/del 的计算样式、块级结构、双主题——
 * 不是源码里写没写（predicate-and-wiring-discipline.md 形状 6）。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL;
const OUT = process.env.OUT_DIR || '/tmp/kb-probe';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const result = {};

try {
  await page.goto(`${BASE}/_mockup/selection-diff-probe?autorun=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="probe-run"]', { timeout: 30_000 });

  // 流式：正文里必须真的长出新内容（不是 spinner）
  await page.waitForSelector('.doc-inline-diff ins', { timeout: 30_000 });
  const mid = await page.evaluate(() => ({
    phase: document.querySelector('[data-testid="probe-phase"]')?.textContent ?? '',
    ins: document.querySelectorAll('.doc-inline-diff ins').length,
    caret: (document.querySelector('.doc-inline-diff')?.textContent ?? '').includes('▌'),
  }));
  result.streamingPhase = mid.phase.includes('streaming');
  result.streamingIns = mid.ins;
  result.caretVisible = mid.caret;
  await page.screenshot({ path: `${OUT}/01-streaming-dark.png` });
  log('streaming:', JSON.stringify(mid));

  // 闭环：等到真的写完（phase=review + 出现「采纳」）才截图
  await page.waitForFunction(
    () => document.querySelector('[data-testid="probe-phase"]')?.textContent?.includes('review'),
    null,
    { timeout: 60_000 },
  );
  await page.locator('button', { hasText: '采纳' }).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(600);

  const styles = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor, decoration: cs.textDecorationLine, text: el.textContent?.slice(0, 40) };
    };
    const body = document.querySelector('.doc-inline-diff p, .doc-inline-diff li');
    return {
      ins: pick('.doc-inline-diff ins'),
      del: pick('.doc-inline-diff del'),
      bodyColor: body ? getComputedStyle(body).color : null,
      insCount: document.querySelectorAll('.doc-inline-diff ins').length,
      delCount: document.querySelectorAll('.doc-inline-diff del').length,
      // 块级结构没塌：标记后的列表仍然是 li，标题仍然是 h1
      liCount: document.querySelectorAll('.doc-inline-diff li').length,
      // 删除的旧列表与新增的新列表必须是两个 ol，否则新条目会接着旧序号编号
      olCount: document.querySelectorAll('.doc-inline-diff ol').length,
      olHasStartAttr: !!document.querySelector('.doc-inline-diff ol[start]'),
      hasHeading: !!document.querySelector('.doc-inline-diff h1'),
      // 选区外的正文逐字保留
      tailIntact: document.body.innerText.includes('结尾段落逐字保留，用来确认改写没有越界。'),
      // 标签本身绝不能作为文字漏出来
      rawTagLeak: document.body.innerText.includes('<ins>') || document.body.innerText.includes('<del>'),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  Object.assign(result, styles, { theme: 'dark' });
  await page.screenshot({ path: `${OUT}/02-review-dark.png` });
  log('dark:', JSON.stringify(styles));

  // 双主题：走页面上的真实切换按钮
  await page.locator('[data-testid="probe-theme"]').click();
  await page.waitForTimeout(700);
  const light = await page.evaluate(() => {
    const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
    const ins = cs('.doc-inline-diff ins');
    const del = cs('.doc-inline-diff del');
    const body = cs('.doc-inline-diff p, .doc-inline-diff li');
    return {
      theme: document.documentElement.dataset.theme,
      insColor: ins?.color, insBg: ins?.backgroundColor,
      delColor: del?.color, delDecoration: del?.textDecorationLine,
      bodyColor: body?.color,
      pageBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  result.light = light;
  await page.screenshot({ path: `${OUT}/03-review-light.png` });
  log('light:', JSON.stringify(light));

  const pass =
    result.insCount > 0 &&
    result.delCount > 0 &&
    result.liCount > 0 &&
    result.olCount === 2 &&
    !result.olHasStartAttr &&
    result.streamingPhase &&
    result.caretVisible &&
    result.hasHeading &&
    result.tailIntact &&
    !result.rawTagLeak &&
    !result.overflowX &&
    result.del?.decoration?.includes('line-through') &&
    result.ins?.color !== result.bodyColor &&
    light.insColor !== light.bodyColor &&
    light.delDecoration?.includes('line-through');
  console.log(`\nRESULT ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify(result));
  if (!pass) process.exitCode = 1;
} catch (e) {
  log('FAILED:', e.message);
  await page.screenshot({ path: `${OUT}/99-failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
