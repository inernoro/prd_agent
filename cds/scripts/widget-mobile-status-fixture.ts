/** deterministic-fixture：生产 widget IIFE + Chromium CSS；不访问真实业务或登录态。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { buildWidgetScript } from '../src/widget-script.js';

declare global {
  interface Window {
    widgetFixture: { calls: string[]; unknown: string[]; status: string; emit: (status: string) => void };
  }
}

const output = process.env.CDS_WIDGET_FIXTURE_OUTPUT || mkdtempSync(path.join(tmpdir(), 'cds-widget-mobile-'));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CDS_CHROMIUM_PATH || undefined });
const results: { name: string; status: string; detail?: string; geometry?: Record<string, unknown> }[] = [];
const externalRequests: string[] = [];
const pageErrors: string[] = [];
const script = buildWidgetScript('fixture-branch', 'fixture/desktop-and-mobile-drawer-actions', 'a'.repeat(40))
  .replace(/^\s*<script data-cds-widget>/, '').replace(/<\/script>\s*$/, '');
const scriptSha256 = createHash('sha256').update(script).digest('hex');

async function fixture(viewport = { width: 390, height: 664 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', error => { pageErrors.push(error.message); });
  await page.route('**/*', route => { externalRequests.push(route.request().url()); return route.abort(); });
  await page.setContent('<html><head><title>deterministic-fixture</title></head><body style="margin:0;min-height:1200px;background:#faf9f6"><h1 style="margin:16px;font:20px sans-serif">业务主任务</h1></body></html>');
  await page.evaluate(() => {
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
      if (url === '/_cds/api/branches') body = { tabTitleEnabled: false, branches: [{ id: 'fixture-branch', status: window.widgetFixture.status, runningCommitSha: 'a'.repeat(40) }] };
      else if (url === '/_cds/api/build-profiles') body = { profiles: [] };
      else { window.widgetFixture.unknown.push(url); throw new Error(`未登记的夹具请求：${url}`); }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.addScriptTag({ content: script });
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
      hitTestable: root.contains(hit),
      visible: getComputedStyle(root).display !== 'none' && getComputedStyle(root).visibility === 'visible' && Number(getComputedStyle(root).opacity) > 0 && rect.width > 0 };
  });
}

async function check(name: string, run: (page: Page) => Promise<void>, viewport?: { width: number; height: number }) {
  const page = await fixture(viewport);
  try {
    await run(page);
    assert.deepEqual(await page.evaluate(() => window.widgetFixture.unknown), []);
    const measured = await geometry(page);
    if (!viewport || viewport.width <= 640) assert.equal(measured.touch, true, '保留 44px 触控目标');
    assert.equal(measured.visible, true, '保留可见徽标');
    assert.equal(measured.hitTestable, measured.placement !== 'blocked', '只有安全落位的徽标接收指针');
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
  await check('no-safe-slot', async page => {
    await addFloat(page, 'alert');
    await page.locator('#fixture-status').evaluate(el => { (el as HTMLElement).style.cssText = 'position:fixed;inset:0;background:#fff;z-index:70'; });
    await settle(page);
    const blocked = await geometry(page);
    assert.equal(blocked.placement, 'blocked', '所有候选被占时不能宣称已避让');
    assert.equal(blocked.visible, true, '不能删除或隐藏入口');
    assert.equal(blocked.hitTestable, false, '无安全候选时不拦截业务指针');
    await page.locator('#cds-widget button[data-action="toggle"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('#cds-widget-panel').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '关闭 CDS 诊断面板', exact: true }).click();
    await settle(page);
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
  // 1440x900 对齐线上抽屉按钮几何；所有操作只作用于本地夹具。
  for (const animated of [false, true]) await check(`desktop-drawer-${animated ? 'animated' : 'static'}`, async page => {
    const original = await geometry(page);
    await page.evaluate(animated => {
      const drawer = document.createElement('aside');
      drawer.id = 'fixture-drawer';
      drawer.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:640px;background:#fff;border-left:1px solid #ddd;z-index:100;transition:transform .2s';
      if (animated) drawer.style.transform = 'translateX(100%)';
      drawer.innerHTML = '<h2 style="padding:24px">新建策略（本地夹具）</h2><footer style="position:absolute;left:0;right:0;bottom:0;height:62px;background:#fafafa;border-top:1px solid #ddd"><button id="fixture-cancel" style="position:fixed;right:224px;bottom:14px;width:60px;height:32px">取消</button><button id="fixture-save" style="position:fixed;right:144px;bottom:14px;width:60px;height:32px">保存</button></footer>';
      for (const button of drawer.querySelectorAll('button')) button.addEventListener('click', () => { button.setAttribute('data-clicked', 'yes'); });
      document.body.append(drawer);
    }, animated);
    if (animated) {
      await page.locator('#fixture-drawer').evaluate(el => new Promise<void>(resolve => {
        el.addEventListener('transitionend', () => resolve(), { once: true });
        requestAnimationFrame(() => requestAnimationFrame(() => { (el as HTMLElement).style.transform = 'translateX(0)'; }));
      }));
    }
    await settle(page);
    const saveRect = await page.locator('#fixture-save').boundingBox();
    assert.ok(saveRect && original.x < saveRect.x + saveRect.width && original.x + original.width > saveRect.x
      && original.y < saveRect.y + saveRect.height && original.y + original.height > saveRect.y,
    '夹具必须复现原位置覆盖保存按钮，不能只测本来就没遮挡的布局');
    for (const id of ['fixture-save', 'fixture-cancel']) {
      const button = page.locator(`#${id}`);
      assert.equal(await button.evaluate(el => {
        const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true, `${id} 中心应命中业务按钮`);
      await button.click({ timeout: 1500 });
      assert.equal(await button.getAttribute('data-clicked'), 'yes');
    }
    assert.equal((await geometry(page)).placement, 'clear');
    await page.locator('#cds-widget button[data-action="toggle"]').click();
    await page.getByRole('button', { name: '关闭 CDS 诊断面板', exact: true }).click();
    await settle(page);
    await page.locator('#fixture-save').click({ timeout: 1500 });
  }, { width: 1440, height: 900 });
  await check('desktop-fixed-footer-resize', async page => {
    await page.evaluate(() => {
      const footer = document.createElement('footer');
      footer.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:64px;display:flex;background:white';
      for (let i = 0; i < 12; i++) {
        const button = document.createElement('button');
        button.textContent = `操作 ${i}`; button.style.flex = '1';
        button.onclick = () => { button.dataset.clicked = 'yes'; };
        footer.append(button);
      }
      document.body.append(footer);
    });
    for (const width of [1440, 900, 640, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      for (const button of await page.locator('footer button').all()) {
        await button.click({ timeout: 1500 });
        assert.equal(await button.getAttribute('data-clicked'), 'yes');
      }
      assert.equal((await geometry(page)).placement, 'clear');
    }
  }, { width: 1440, height: 900 });
  await check('desktop-no-safe-slot-pointer', async page => {
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'fixture-fullscreen';
      button.textContent = '占满候选的业务控件';
      button.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
      button.onclick = () => { button.dataset.clicked = 'yes'; }; document.body.append(button);
    });
    await settle(page);
    const measured = await geometry(page);
    assert.equal(measured.placement, 'blocked');
    // 从徽标实际中心发原生指针，不能只在未遮挡的业务按钮中心验证。
    await page.mouse.click(measured.x + measured.width / 2, measured.y + measured.height / 2);
    assert.equal(await page.locator('#fixture-fullscreen').getAttribute('data-clicked'), 'yes');
    await page.locator('#fixture-fullscreen').evaluate(el => el.remove());
    await settle(page);
    assert.equal((await geometry(page)).placement, 'clear');
    await page.locator('#cds-widget button[data-action="toggle"]').click();
    await page.getByRole('button', { name: '关闭 CDS 诊断面板', exact: true }).click();
    await settle(page);
  }, { width: 1440, height: 900 });
} finally {
  await browser.close();
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ provenance: 'deterministic-fixture', scriptSha256, externalRequests, pageErrors, results }, null, 2));
}
console.log(JSON.stringify({ provenance: 'deterministic-fixture', output, scriptSha256, externalRequests: externalRequests.length, pageErrors, results }, null, 2));
assert.deepEqual(externalRequests, [], '禁止任何外部业务请求');
assert.deepEqual(pageErrors, [], '生产 IIFE 不得抛页面异常');
assert.equal(results.filter(result => result.status === 'FAIL').length, 0, '徽标布局回归失败');
