/** Local fixtures only: no model calls, report uploads, or production mutations. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

export async function verifyCodeReviewDocument(browser, base, out) {
  assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, hasTouch: true });
  await context.addInitScript(() => {
    if (window.top !== window.self) return;
    localStorage.setItem('cds_theme', 'light'); localStorage.setItem('cds_ui_scale', '85');
  });
  const task = { id: 'fixture-report-scroll', projectId: 'fixture-project', title: '滚动与排版验收',
    sourceType: 'report', sourceName: 'review.md', excludePatterns: [], status: 'completed', phase: '已上传审查报告',
    progress: { totalFiles: 0, scannedFiles: 0 }, delivery: { status: 'not_requested' }, reportId: 'fixture-archive',
    createdBy: 'fixture', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' };
  let format = 'md', content = '# 代码审查报告\n\n对象：tiny.zip\n版本：固定快照\n\n' + Array.from({ length: 35 }, (_, i) =>
    `## 问题 ${i + 1}\n\n发现有待验证，原始证据与修复建议按文件列出。\n\n- 安全\n- 可维护性\n`).join('\n') + '\n报告最后一行';
  await context.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
    if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    let json = resolveFixture(p) ?? {};
    if (p === '/api/auth/status') json = { authenticated: true, enabled: true, user: { name: '合成验收账号', isSystemOwner: true } };
    if (p === `/api/code-reviews/${task.id}`) json = { task };
    if (p === `/api/code-reviews/${task.id}/report`) json = { report: { title: task.title, format }, content };
    return route.fulfill({ json });
  });
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `${base}/code-reviews?source=report&task=${task.id}&report=1`;
  const main = page.locator('.cds-main'), iframe = page.locator('.cr-document iframe');
  async function open() {
    await page.goto(url);
    await iframe.waitFor();
    await page.waitForFunction(() => parseFloat(document.querySelector('.cr-document iframe')?.style.height) > 500);
    return page.frames().find(f => f !== page.mainFrame() && f.url() === 'about:srcdoc');
  }
  async function wheel(delta) {
    const box = await iframe.boundingBox(), top = await main.evaluate(e => e.getBoundingClientRect().top);
    await page.mouse.move(box.x + Math.min(box.width / 2, 200), Math.max(top + 100, box.y + 100));
    await page.mouse.wheel(0, delta);
  }
  try {
    let frame = await open();
    // Pan over the iframe with the reader chrome completely above the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await main.evaluate(e => e.scrollTop = 600);
    const touch = await context.newCDPSession(page);
    const touchBox = await iframe.boundingBox(), mainBox = await main.boundingBox();
    const origin = { x: touchBox.x + 100, y: mainBox.y + 300 };
    async function pan(distance) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [origin] });
      for (let step = 1; step <= 6; step++) await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: origin.x, y: origin.y + distance * step / 6 }],
      });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    const touchStart = await main.evaluate(e => e.scrollTop);
    await pan(-180);
    await page.waitForFunction(value => document.querySelector('.cds-main').scrollTop > value + 50, touchStart);
    const touchDown = await main.evaluate(e => e.scrollTop);
    await pan(180);
    await page.waitForFunction(value => document.querySelector('.cds-main').scrollTop < value - 50, touchDown);
    assert.equal(await frame.evaluate(() => document.scrollingElement.scrollTop), 0);
    await touch.detach();
    results.push({ mobileTouchOverReport: true, readerChromeOffscreen: true, touchBothDirections: true });
    frame = await open();
    for (const density of ['85', '100']) {
      await page.evaluate(value => { if (value === '85') delete document.documentElement.dataset.uiScale; else document.documentElement.dataset.uiScale = value; }, density);
      for (const width of [1440, 2048, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 940 });
        await main.evaluate(e => e.scrollTop = 0);
        await page.waitForFunction(() => parseFloat(document.querySelector('.cr-document iframe').style.height) > 500);
        frame = page.frames().find(f => f !== page.mainFrame() && f.url() === 'about:srcdoc');
        // Wait for the same density to reach the sandboxed document, not a timer-based guess.
        const rootSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
        await frame.waitForFunction(size => getComputedStyle(document.documentElement).fontSize === size, rootSize);
        const inner = await frame.evaluate(() => ({
          height: innerHeight, bottom: document.body.getBoundingClientRect().bottom,
          scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight,
          overflow: getComputedStyle(document.documentElement).overflowY,
          body: getComputedStyle(document.body).fontSize,
          metadataLines: document.querySelector('p').innerHTML.includes('<br>'),
        }));
        assert.equal(inner.overflow, 'hidden');
        assert(inner.bottom <= inner.height, `fractional report content clipped: ${JSON.stringify(inner)}`);
        assert(inner.scrollHeight <= inner.clientHeight + 1, 'unexpected inner vertical overflow');
        assert(inner.metadataLines, 'Markdown metadata should retain its line breaks');
        const aligned = await page.evaluate(() => {
          const nodes = ['.cr-page-header', '.cr-source-meta', '.cr-coverage', '.cr-tabs', '.cr-document'].map(s => document.querySelector(`.cr-reader ${s}`).getBoundingClientRect());
          return Math.max(...nodes.map(r => r.left)) - Math.min(...nodes.map(r => r.left)) < 1 && Math.max(...nodes.map(r => r.right)) - Math.min(...nodes.map(r => r.right)) < 1;
        });
        assert(aligned, 'reader header, metadata, tabs and document edges must align');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page horizontal overflow');
        await wheel(480);
        await page.waitForFunction(() => document.querySelector('.cds-main').scrollTop > 100);
        assert.equal(await frame.evaluate(() => document.scrollingElement.scrollTop), 0);
        const moved = await main.evaluate(e => e.scrollTop);
        await wheel(-240);
        await page.waitForFunction(previous => document.querySelector('.cds-main').scrollTop < previous, moved);
        await wheel(100000);
        // Wheel deltas are bounded per message; repeat genuine input for long reports.
        for (let i = 0; i < 3; i++) await wheel(100000);
        await page.waitForFunction(() => { const e = document.querySelector('.cds-main'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; });
        const last = await frame.getByText('报告最后一行', { exact: true }).boundingBox();
        assert(last.y + last.height <= (await main.boundingBox()).y + (await main.boundingBox()).height + 1, 'report end inaccessible');
        results.push({ density, width, inner, aligned, wheelBothDirections: true, bottomReached: true });
        await main.evaluate(e => e.scrollTop = 0);
        if (width === 1440 && density === '85' || width === 390 && density === '100') await page.screenshot({ path: path.join(out, `report-reader-${width}-${density}.png`) });
      }
    }
    // HTML keeps its presentation and horizontal code scrolling, while uploaded JS stays blocked.
    await page.setViewportSize({ width: 1440, height: 940 });
    format = 'html'; content = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><style>
      body{margin:8px;padding:12.25px;background:rgb(241,245,249)}pre{overflow:auto;max-height:120px}section{height:1800.25px}
      </style></head><body><h1>原版 HTML</h1><script>document.body.dataset.untrusted='executed'</script>
      <pre>${'wide code '.repeat(150)}\n${'nested line\n'.repeat(40)}</pre><section>HTML 正文</section><p>报告最后一行</p></body></html><textarea>`;
    frame = await open();
    assert.equal(await frame.evaluate(() => document.body.dataset.untrusted), undefined);
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(241, 245, 249)');
    await frame.locator('pre').evaluate(e => e.scrollLeft = 300);
    assert(await frame.locator('pre').evaluate(e => e.scrollLeft > 0), 'horizontal code scroll lost');
    const pre = await frame.locator('pre').boundingBox(); await page.mouse.move(pre.x + 30, pre.y + 20); await page.mouse.wheel(0, 60);
    await frame.waitForFunction(() => document.querySelector('pre').scrollTop > 0);
    assert.equal(await main.evaluate(e => e.scrollTop), 0, 'nested code scroller should retain its own wheel input');
    await wheel(500); await page.waitForFunction(() => document.querySelector('.cds-main').scrollTop > 100);
    // Source + token checks reject forged messages from another window.
    const height = await iframe.evaluate(e => e.style.height);
    const token = await iframe.evaluate(e => e.srcdoc.match(/nonce="([a-f0-9-]+)"/)[1]);
    await page.evaluate(token => window.postMessage({ kind: 'cds-report-height', token, height: 99999 }, '*'), token);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await iframe.evaluate(e => e.style.height), height);
    await frame.evaluate(() => parent.postMessage({ kind: 'cds-report-height', token: 'wrong-token', height: 99999 }, '*'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await iframe.evaluate(e => e.style.height), height);
    await iframe.focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => { const e = document.querySelector('.cds-main'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; });
    assert.deepEqual(errors, []);
    results.push({ originalHtmlStyle: true, untrustedScriptBlocked: true, customCspAndUnclosedTail: true, horizontalCodeScroll: true, nestedWheel: true, keyboardEnd: true });
    content = `<html><head><style>
      :root{--panel-size:100vh;--label:"100vh"}body{margin:8px}header,footer{padding:16px}
      @media(min-width:600px){.hero{min-height:var(--panel-size)}}
      .label::after{content:var(--label)}
      </style></head><body><header>视口高度报告</header><section class="hero" style="height:calc(100dvh - 1rem)">正文</section>
      <p class="label">单位原文：</p><footer>报告最后一行</footer></body></html>`;
    frame = await open();
    const heights = await page.evaluate(() => new Promise(resolve => {
      const values = [];
      const sample = () => { values.push(parseFloat(document.querySelector('.cr-document iframe').style.height)); if (values.length < 45) requestAnimationFrame(sample); else resolve(values); };
      requestAnimationFrame(sample);
    }));
    assert(Math.max(...heights) < 5000, 'viewport units inflated the report height');
    assert(Math.max(...heights.slice(-10)) - Math.min(...heights.slice(-10)) < 1, 'report height did not settle');
    assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden');
    assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.label'), '::after').content), '"100vh"');
    const visibleHeight = await main.evaluate(e => e.clientHeight);
    assert(Math.abs(await frame.locator('.hero').evaluate(e => e.getBoundingClientRect().height) - visibleHeight) < 1);
    await page.setViewportSize({ width: 1440, height: 740 });
    const resizedHeight = await main.evaluate(e => e.clientHeight);
    await frame.waitForFunction(height => Math.abs(document.querySelector('.hero').getBoundingClientRect().height - height) < 1, resizedHeight);
    assert(parseFloat(await iframe.evaluate(e => e.style.height)) < 5000, 'resize restarted the viewport feedback loop');
    results.push({ viewportUnitsStable: true, viewportHeight: visibleHeight, height: heights.at(-1) });
    await fs.writeFile(path.join(out, 'report-document-results.json'), JSON.stringify(results, null, 2));
    return results;
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'report-document-failure.png') });
    throw error;
  } finally { await context.close(); }
}
