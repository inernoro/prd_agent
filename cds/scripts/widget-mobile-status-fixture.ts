/** deterministic-fixture：生产 widget IIFE + Chromium CSS；不访问真实业务或登录态。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { buildWidgetScript } from '../src/widget-script.js';

const require = createRequire(import.meta.url);
function loadPlaywright(): typeof import('playwright') {
  const failures: string[] = [];
  for (const candidate of [process.env.PWPATH, 'playwright'].filter(Boolean) as string[]) {
    try { return require(candidate); }
    catch (error) { failures.push(`${candidate}: ${(error as Error).message}`); }
  }
  throw new Error(`Unable to load Playwright. Tried ${failures.join('; ')}`);
}
const { chromium } = loadPlaywright();

declare global {
  interface Window {
    widgetFixture: { calls: string[]; unknown: string[]; status: string; emit: (status: string) => void };
  }
}

const output = process.env.CDS_WIDGET_FIXTURE_OUTPUT || mkdtempSync(path.join(tmpdir(), 'cds-widget-mobile-'));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CDS_CHROMIUM_PATH || undefined });
const results: { name: string; status: string; detail?: string; geometry?: Record<string, unknown> }[] = [];
const externalRequests: string[] = [];
const pageErrors: string[] = [];
const script = buildWidgetScript('fixture-branch', 'fixture/mobile', 'a'.repeat(40))
  .replace(/^\s*<script data-cds-widget>/, '').replace(/<\/script>\s*$/, '');
const scriptSha256 = createHash('sha256').update(script).digest('hex');

async function fixture(hosted = false, width = 390, tags: string[] = []) {
  const page = await browser.newPage({ viewport: { width, height: 664 } });
  page.on('pageerror', error => { pageErrors.push(error.message); });
  await page.route('**/*', route => { externalRequests.push(route.request().url()); return route.abort(); });
  await page.setContent('<html><head><title>deterministic-fixture</title></head><body style="margin:0;min-height:1200px;background:#faf9f6"><h1 style="margin:16px;font:20px sans-serif">业务主任务</h1></body></html>');
  await page.evaluate(tags => {
    const streams: EventTarget[] = [];
    window.EventSource = class extends EventTarget {
      constructor(public url: string) {
        super(); streams.push(this);
        if (!['/_cds/api/branches/stream', '/_cds/api/activity-stream'].includes(url)) window.widgetFixture.unknown.push(url);
      }
      close() {}
    } as unknown as typeof EventSource;
    window.widgetFixture = {
      calls: [], unknown: [], status: 'running',
      emit(status) {
        const previousStatus = this.status;
        this.status = status;
        for (const stream of streams) stream.dispatchEvent(new MessageEvent('branch.status', {
          data: JSON.stringify({ branchId: 'fixture-branch', status, previousStatus }),
        }));
      },
    };
    window.fetch = async input => {
      const url = String(input);
      window.widgetFixture.calls.push(url);
      let body;
      if (url === '/_cds/api/branches') body = { tabTitleEnabled: false, branches: [{ id: 'fixture-branch', status: window.widgetFixture.status, runningCommitSha: 'a'.repeat(40), tags }] };
      else if (url === '/_cds/api/build-profiles') body = { profiles: [] };
      else { window.widgetFixture.unknown.push(url); throw new Error(`未登记的夹具请求：${url}`); }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
  }, tags);
  await page.addScriptTag({ content: hosted ? buildWidgetScript('fixture-branch', 'fixture/mobile', 'a'.repeat(40), '', true).replace(/^\s*<script data-cds-widget>/, '').replace(/<\/script>\s*$/, '') : script });
  await page.waitForFunction(() => window.widgetFixture.calls.length === 2 && !!document.querySelector('#cds-widget .cds-badge'), undefined, { timeout: 3000 });
  return page;
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function addFloat(page: Page, semantic: string, position = 'fixed') {
  await page.evaluate(({ semantic, position }) => {
    const box = document.createElement('section');
    box.id = 'fixture-status';
    box.style.cssText = `position:${position};left:8px;bottom:80px;top:${position === 'sticky' ? '532px' : 'auto'};width:calc(100vw - 16px);height:64px;background:#fff;border:1px solid #222;z-index:70`;
    const label = document.createElement('span');
    if (semantic === 'live') label.setAttribute('aria-live', 'polite');
    else label.setAttribute('role', semantic);
    label.textContent = '正在处理文件：状态、正文和进度都不能被徽标挡住';
    box.append(label);
    document.body.append(box);
  }, { semantic, position });
  await settle(page);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#cds-widget')!;
    const rect = root.getBoundingClientRect();
    const hits = [...document.querySelectorAll('#fixture-status, #fixture-cta, h1')].filter(el => {
      const other = el.getBoundingClientRect(); return rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top;
    }).map(el => `${el.tagName.toLowerCase()}#${el.id}`);
    const button = root.querySelector('button')!.getBoundingClientRect();
    const hit = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
    const targets = [...root.querySelectorAll('button')].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, overlap: hits.length > 0, hits, placement: root.dataset.cdsPlacement,
      inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      safe: rect.left >= 12 && rect.top >= 12 && rect.right <= innerWidth - 12 && rect.bottom <= innerHeight - 12,
      touch: targets.length > 0 && targets.every(r => r.width >= 44 && r.height >= 44),
      visible: getComputedStyle(root).display !== 'none' && getComputedStyle(root).visibility === 'visible' && Number(getComputedStyle(root).opacity) > 0 && rect.width > 0 && root.contains(hit) };
  });
}

async function check(name: string, run: (page: Page) => Promise<void>, hosted = false, width = 390, tags: string[] = []) {
  const page = await fixture(hosted, width, tags);
  try {
    await run(page);
    assert.deepEqual(await page.evaluate(() => window.widgetFixture.unknown), []);
    const measured = await geometry(page);
    assert.equal(measured.touch, true, '保留 44px 触控目标');
    assert.equal(measured.visible, true, '保留可见、可命中的徽标入口');
    if (measured.placement === 'clear') assert.equal(measured.safe, true, '避让成功必须以落位后的真实安全区为准');
    results.push({ name, status: 'PASS', geometry: measured });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: String(error), geometry: await geometry(page) });
  } finally {
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    await page.close();
  }
}

try {
  for (const semantic of ['status', 'alert', 'live']) await check(`dynamic-${semantic}`, async page => {
    await addFloat(page, semantic);
    const placed = await geometry(page);
    assert.equal(placed.overlap, false, '避让整张语义浮层后，也不能新遮挡页面主标题');
    assert.equal(placed.inside, true);
    assert.equal(placed.placement, 'clear');
    await page.screenshot({ path: path.join(output, `dynamic-${semantic}-present.png`) });
    await page.locator('#fixture-status').evaluate(el => el.remove());
    await settle(page);
    const removed = await geometry(page);
    assert.deepEqual([removed.x, removed.y], [placed.x, placed.y], '浮层消失不应无意义跳回');
  });
  await check('sticky-and-cta-resize', async page => {
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'fixture-cta'; button.textContent = '主操作';
      button.style.cssText = 'position:fixed;left:12px;top:12px;width:100px;height:44px';
      document.body.append(button);
    });
    await addFloat(page, 'status', 'sticky');
    assert.equal((await geometry(page)).overlap, false, '不能从浮层移到现存主按钮上');
    await page.setViewportSize({ width: 360, height: 600 });
    await settle(page);
    const resized = await geometry(page);
    assert.equal(resized.inside, true);
    assert.equal(resized.overlap, false);
    assert.equal(await page.locator('#fixture-cta').evaluate(el => {
      const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, '主按钮仍能命中');
  });
  await check('sync-error-readable', async page => {
    for (const status of ['building', 'error', 'starting', 'running']) {
      await page.evaluate(status => window.widgetFixture.emit(status), status);
      await settle(page);
      const visible = await page.locator('.cds-sync-chip').evaluate(el => {
        const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
      });
      assert.equal(visible, true, `${status} 的进度/失败文字不能被手机 CSS 裁掉`);
      assert.match(await page.locator('.cds-sync-chip').innerText(), status === 'error' ? /失败/ : status === 'running' ? /完成/ : /刷新/);
      assert.equal((await geometry(page)).inside, true, '状态条变化后仍留在可视区');
      await page.screenshot({ path: path.join(output, `sync-${status}.png`) });
    }
  });
  await check('status-cta-sync-safe-area', async page => {
    // 独立组合页的标题位于工具行下；前面的标题16px场景仍保持，不拿此布局替代它。
    await page.locator('h1').evaluate(el => { (el as HTMLElement).style.marginTop = '80px'; });
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'fixture-cta'; button.textContent = '主操作';
      button.style.cssText = 'position:fixed;left:12px;top:12px;width:100px;height:44px'; document.body.append(button);
    });
    await addFloat(page, 'status');
    await page.evaluate(() => window.widgetFixture.emit('building'));
    await settle(page);
    const measured = await geometry(page);
    assert.equal(measured.safe, true, '写入候选后真实 BCR 必须仍在12px安全区内');
    assert.equal(measured.overlap, false);
  });
  await check('rejected-real-position-restores-origin', async page => {
    await settle(page);
    await page.locator('#cds-widget').evaluate(el => { (el as HTMLElement).style.transform = 'translateX(100px)'; });
    const before = await geometry(page);
    assert.equal(before.safe, true);
    await page.evaluate(() => {
      const box = document.createElement('section'); box.id = 'fixture-status'; box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;left:100px;right:0;top:0;bottom:0;z-index:70;background:#fff';
      box.textContent = '所有真实落位均不可用'; document.body.append(box);
    });
    await settle(page);
    const after = await geometry(page);
    assert.equal(after.placement, 'blocked');
    assert.deepEqual([after.x, after.y], [before.x, before.y], '真实落位拒绝不能留下被拒绝的候选位置');
  });
  for (const host of ['shell', 'body']) await check(`fixed-${host}-semantic-region`, async page => {
    await page.evaluate(host => {
      const shell = host === 'body' ? document.body : document.createElement('main');
      shell.style.cssText = 'position:fixed;inset:0';
      if (host !== 'body') document.body.append(shell);
      const box = document.createElement('section'); box.id = 'fixture-status'; box.setAttribute('role', 'status');
      box.style.cssText = 'position:absolute;left:8px;right:8px;bottom:80px;height:64px;background:#fff;z-index:70';
      box.textContent = '固定应用容器内的真实状态内容'; shell.append(box);
    }, host);
    await settle(page);
    assert.equal((await geometry(page)).placement, 'clear', '固定应用外壳不能冒充整屏语义浮层');
    assert.equal((await geometry(page)).overlap, false);
  });
  for (const width of [360, 390]) await check(`hosted-sync-controls-${width}`, async page => {
    for (const status of ['building', 'error', 'starting', 'running']) {
      await page.evaluate(status => window.widgetFixture.emit(status), status); await settle(page);
      const controls = await page.locator('.cds-badge-main').evaluate(row => [...row.querySelectorAll('button')].map(button => {
        const r = button.getBoundingClientRect(), badge = row.parentElement!.getBoundingClientRect();
        return { action: button.dataset.action, visible: r.width >= 44 && r.height >= 44 && r.left >= badge.left && r.right <= badge.right
          && r.top >= badge.top && r.bottom <= badge.bottom && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      }));
      assert.deepEqual(controls.map(control => control.action), ['toggle', 'dismiss']);
      assert.ok(controls.every(control => control.visible), `${status} 的真实托管徽标两按钮都必须可点击`);
      assert.equal(await page.locator('.cds-sync-chip').isVisible(), true);
      await page.screenshot({ path: path.join(output, `hosted-${width}-${status}.png`) });
    }
    await page.locator('button[data-action="toggle"]').click(); await settle(page);
    assert.equal(await page.locator('.cds-hosted-panel-note').isVisible(), true, '托管限制说明仍可经真实按钮打开查看');
  }, true, width);
  for (const hosted of [false, true]) for (const width of [360, 390]) await check(`tagged-${hosted ? 'hosted' : 'normal'}-sync-controls-${width}`, async page => {
    for (const status of ['building', 'error', 'starting', 'running']) {
      await page.evaluate(status => window.widgetFixture.emit(status), status); await settle(page);
      assert.equal(await page.locator('.cds-tag').count(), 8, '沿用真实 branches.tags 渲染，不删标签数据');
      const controls = await page.locator('.cds-badge-main').evaluate(row => [...row.querySelectorAll('button')].map(button => {
        const r = button.getBoundingClientRect(), badge = row.parentElement!.getBoundingClientRect();
        return { action: button.dataset.action, visible: r.width >= 44 && r.height >= 44 && r.left >= badge.left && r.right <= badge.right
          && r.top >= badge.top && r.bottom <= badge.bottom && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      }));
      assert.deepEqual(controls.map(control => control.action), ['toggle', 'dismiss']);
      assert.ok(controls.every(control => control.visible), `${status} 的带标签徽标仍须可展开、可关闭`);
      assert.equal(await page.locator('.cds-sync-chip').isVisible(), true);
    }
    await page.locator('button[data-action="toggle"]').click(); await settle(page);
    if (hosted) assert.equal(await page.locator('.cds-hosted-panel-note').isVisible(), true);
  }, hosted, width, ['开发', '测试', '验收', '手机', '构建', '回归', '待合并', '功能修复']);
  await check('native-nonzero-safe-area', async page => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 40, left: 20, right: 30, bottom: 34 } });
    await addFloat(page, 'status');
    assert.equal(await page.locator('#cds-widget').evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--cds-safe-bottom'))), 34, '原生env在当前Chromium计算后须为真实像素');
    const bounds = await page.locator('#cds-widget').evaluate(el => {
      const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    assert.ok(bounds.left >= 32 && bounds.top >= 52 && bounds.right <= 348 && bounds.bottom <= 618,
      `非零原生env安全区必须真的生效：${JSON.stringify(bounds)}`);
    assert.equal((await geometry(page)).placement, 'clear');
  });
  for (const hosted of [false, true]) await check(`top-relocated-panel-safe-area-${hosted}`, async page => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 40, bottom: 34 } });
    await addFloat(page, 'status');
    await page.locator('#fixture-status').evaluate(el => { (el as HTMLElement).style.cssText = 'position:fixed;left:0;right:0;top:160px;bottom:0;background:#fff;z-index:70'; });
    await settle(page);
    assert.equal((await geometry(page)).placement, 'clear');
    assert.ok((await geometry(page)).y >= 52 && (await geometry(page)).y < 160, '真实底部浮层应先把徽标移到顶部安全槽');
    await page.locator('button[data-action="toggle"]').click(); await settle(page);
    const bounds = await page.locator('#cds-widget').evaluate(el => {
      const root = el.getBoundingClientRect(), close = el.querySelector('button[data-action="close-panel"]')!.getBoundingClientRect();
      return { top: root.top, bottom: root.bottom, closeTop: close.top, closeBottom: close.bottom };
    });
    assert.ok(bounds.top >= 52 && bounds.bottom <= 618 && bounds.closeTop >= 52 && bounds.closeBottom <= 618,
      `由顶部槽展开后，面板和关闭按钮仍须在实际上下安全区内：${JSON.stringify(bounds)}`);
    await page.locator('button[data-action="close-panel"]').click(); await settle(page);
  }, hosted);
  await check('no-safe-slot', async page => {
    await addFloat(page, 'alert');
    await page.locator('#fixture-status').evaluate(el => { (el as HTMLElement).style.cssText = 'position:fixed;inset:0;background:#fff;z-index:70'; });
    await settle(page);
    const blocked = await geometry(page);
    assert.equal(blocked.placement, 'blocked', '所有候选被占时不能宣称已避让');
    assert.equal(blocked.visible, true, '不能删除或隐藏入口');
  });
  await check('no-unneeded-move', async page => {
    const before = await geometry(page);
    await page.evaluate(() => {
      const content = document.createElement('div');
      content.innerHTML = '<span role="status">正常流内容</span><span role="alert" style="display:none;position:fixed;inset:0">隐藏状态</span><button style="position:fixed;right:12px;top:12px;width:80px;height:44px">另一主操作</button>';
      document.body.append(content);
    });
    await settle(page);
    const after = await geometry(page);
    assert.deepEqual([after.x, after.y], [before.x, before.y]);
    assert.equal(after.visible, true);
  });
} finally {
  await browser.close();
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ provenance: 'deterministic-fixture', scriptSha256, externalRequests, pageErrors, results }, null, 2));
}
console.log(JSON.stringify({ provenance: 'deterministic-fixture', output, scriptSha256, externalRequests: externalRequests.length, pageErrors, results }, null, 2));
assert.deepEqual(externalRequests, [], '禁止任何外部业务请求');
assert.deepEqual(pageErrors, [], '生产 IIFE 不得抛页面异常');
assert.equal(results.filter(result => result.status === 'FAIL').length, 0, '徽标布局回归失败');
