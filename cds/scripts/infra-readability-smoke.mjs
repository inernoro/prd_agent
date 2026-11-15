import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** Controlled real-page readability probe. All maintenance writes are blocked. */
export async function verifyInfraReadability(browser, base, out, { baseline = false } = {}) {
  await fs.mkdir(out, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(30000);
  const writes = [], errors = [], results = [];
  let mode = 'few';
  const services = Array.from({ length: 30 }, (_, i) => ({ id: `fixture-project-database-${String(i + 1).padStart(2, '0')}-${'identity-'.repeat(4)}`, name: `合成数据服务 ${i + 1}`, projectId: 'fixture-project', dockerImage: 'example.invalid/database:stable', hostPort: 18001 + i, containerPort: 5432, containerName: `fixture-db-${i}`, status: i % 2 ? 'stopped' : 'running', command: ['database-server', '--data-directory=/var/lib/database'], errorMessage: undefined }));
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `fixture-executor-${String(i + 1).padStart(2, '0')}-${'long-identity-'.repeat(3)}`, host: `executor-${i + 1}.example.invalid`, port: 9900, role: 'remote', status: i % 2 ? 'draining' : 'online', lastHeartbeat: '2026-11-15T08:00:00Z', branchCount: 3, runningContainers: 5, capacity: { memoryMB: 8192 }, load: { cpuPercent: 37, memoryUsedMB: 2048 } }));
  await context.route('**/api/**', async route => {
    const request = route.request(), p = new URL(request.url()).pathname.replace(/^\/_cds/, '');
    if (p === '/api/client-events') return route.fulfill({ json: { ok: true } });
    if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': controlled fixture\n\n' });
    if (request.method() !== 'GET') { writes.push({ method: request.method(), path: p }); return route.fulfill({ status: 409, json: { error: 'Readability probe blocks all maintenance writes' } }); }
    if (p === '/api/auth/status') return route.fulfill({ json: { enabled: true, authenticated: true, user: { id: 'fixture-owner', authProvider: 'local', username: 'fixture-owner', isSystemOwner: true } } });
    if (p === '/api/me') return route.fulfill({ json: { user: { id: 'fixture-owner', username: 'fixture-owner', isSystemOwner: true } } });
    if (mode === 'error' && ['/api/infra', '/api/cluster/status'].includes(p)) return route.fulfill({ status: 500, json: { error: '合成维护数据读取失败' } });
    if (p === '/api/infra') return route.fulfill({ json: { services: mode === 'empty' ? [] : services.slice(0, mode === 'many' ? 30 : 2) } });
    if (p === '/api/cluster/status') return route.fulfill({ json: { effectiveRole: 'master', mode: 'master', remoteExecutorCount: mode === 'empty' ? 0 : mode === 'many' ? 30 : 2, capacity: { freePercent: 62, totalSlots: 64, usedSlots: 24 }, strategy: 'capacity-aware', masterUrl: 'https://master.example.invalid' } });
    if (p === '/api/executors') return route.fulfill({ json: { executors: mode === 'empty' ? [] : nodes.slice(0, mode === 'many' ? 30 : 2) } });
    if (p === '/api/host-stats') return route.fulfill({ json: { mem: { totalMB: 8192, freeMB: 4096, usedPercent: 50 }, cpu: { cores: 4, loadPercent: 37, loadAvg1: 1.2, loadAvg5: 1.1, loadAvg15: 1 }, uptimeSeconds: 180000 } });
    return route.fulfill({ json: resolveFixture(p) ?? {} });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const box = locator => locator.evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.left, right: r.right, y: r.top, width: r.width, height: r.height, clipped: element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible' }; });
  const check = (name, pass, extra = {}) => { results.push({ name, pass, ...extra }); if (!baseline) assert(pass, name); };
  async function open(kind) {
    const target = `${base}${kind === 'infra' ? '/settings/fixture-project#infra' : '/cds-settings#cluster'}`;
    if (page.url() === target) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.locator('[role=tabpanel][data-state=active]').waitFor();
    if (mode === 'error') await page.getByText('合成维护数据读取失败', { exact: false }).waitFor(); else await page.getByRole('heading', { name: kind === 'infra' ? '项目基础设施' : '集群', exact: true }).waitFor();
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  }
  try {
    for (const kind of ['infra', 'cluster']) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      mode = 'few'; await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript(theme => { localStorage.setItem('cds-theme', theme); }, theme);
      await open(kind); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
      const panel = page.locator('[role="tabpanel"][data-state="active"]');
      const object = panel.getByText(kind === 'infra' ? services[0].name : nodes[0].id, { exact: true }); await object.waitFor();
      const loadedFonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family));
      check(`${kind}-${width}-${theme}-fonts-ready`, loadedFonts.some(name => name.includes('Inter')), { loadedFonts });
      const objectBox = await box(object);
      const firstFact = await box(panel.getByText(kind === 'infra' ? '运行中' : 'master', { exact: true }).first());
      const actions = kind === 'infra' ? panel.getByRole('button', { name: '删除', exact: true }) : panel.getByRole('button', { name: '排空', exact: true });
      const actionBoxes = await Promise.all((await actions.all()).map(box));
      check(`${kind}-${width}-${theme}-actions-visible`, actionBoxes.every(b => b.x >= 0 && b.right <= width), { actionBoxes });
      if (width === 390) check(`${kind}-${theme}-touch-targets-44`, actionBoxes.every(b => b.height >= 44 && b.width >= 44));
      if (kind === 'infra') { check(`infra-${width}-${theme}-status-readable`, firstFact.width >= 35 && firstFact.height <= 40, { firstFact }); const description = await box(panel.getByText(/mongodb \/ redis \/ postgres 等 infra 容器/)); check(`infra-${width}-${theme}-description-readable`, description.width >= Math.min(280, width - 60), { description }); }
      else check(`cluster-${width}-${theme}-identity-not-clipped`, !objectBox.clipped && objectBox.x >= 0 && objectBox.right <= width, { objectBox });
      results.push({ kind, width, theme, state: 'few', firstObject: objectBox, firstNecessaryFact: firstFact, documentOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), provenance: 'deterministic-real-page-fixture' });
      await page.screenshot({ path: path.join(out, `${kind}-few-${width}-${theme}.png`) });
      await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ complete: false, baseline, results, writes, errors }, null, 2));
    }
    if (!baseline) {
      const scrollPosition = () => page.evaluate(() => window.scrollY + [...document.querySelectorAll('body *')].reduce((sum, element) => sum + (element.scrollTop || 0), 0));
      async function wheelTo(locator) { const start = await scrollPosition(); for (let i = 0; i < 80; i++) { const r = await box(locator); if (r.y >= 0 && r.y + r.height <= page.viewportSize().height) return (await scrollPosition()) - start; await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height - 120); await page.mouse.wheel(0, r.y < 0 ? -400 : 400); await page.waitForTimeout(30); } throw Error('last object unreachable with ordinary scrolling'); }
      for (const kind of ['infra', 'cluster']) {
        mode = 'few'; await page.setViewportSize({width:390,height:844}); await open(kind);
        const id = kind === 'infra' ? services[0].id : nodes[0].id;
        const trigger = page.locator('[role=tabpanel][data-state=active]').getByRole('button', { name: kind === 'infra' ? '删除' : '移除', exact:true }).first();
        const actualScroll = await wheelTo(trigger); const natural = await box(trigger); assert(natural.y >= 0 && natural.y + natural.height <= 844, 'check ordinary visibility before keyboard focus');
        await trigger.evaluate(element => { window.__infraReturnTrigger = element; }); await trigger.focus(); await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog'); await dialog.waitFor(); assert((await dialog.innerText()).includes(id));
        assert((await dialog.innerText()).includes(kind === 'infra' ? '数据卷本身不会被删' : '不会停止远端进程'));
        await page.screenshot({path:path.join(out,`${kind}-confirm-390.png`)}); await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'}); await page.waitForFunction(() => document.activeElement === window.__infraReturnTrigger);
        results.push({kind,state:'keyboard-confirm-cancel',pass:true,actualScrollToAction:actualScroll,writeCount:writes.length});
        for (const width of [1440,390]) for (const theme of ['light','dark']) for (const state of ['empty','many','error']) {
          mode = state; await page.setViewportSize({width,height:width===390?844:900}); await page.addInitScript(theme => {localStorage.setItem('cds-theme',theme)},theme); await open(kind);
          if(state==='empty') await page.getByText(kind==='infra'?'该项目尚无 infra 容器':'暂无执行器',{exact:true}).waitFor();
          let scrolling=0; if(state==='many'){const last=page.getByText(kind==='infra'?services[29].name:nodes[29].id,{exact:true});await last.waitFor();scrolling=await wheelTo(last);}
          await page.screenshot({path:path.join(out,`${kind}-${state}-${width}-${theme}.png`)});results.push({kind,width,theme,state,pass:true,scrolling,provenance:'deterministic-real-page-fixture'});
        }
      }
    }
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ complete: true, verdict: baseline ? 'BASELINE' : errors.length || writes.length || results.some(item => item.pass === false) ? 'FAIL' : 'PASS', baseline, results, writes, errors }, null, 2));
    if (!baseline) { assert.deepEqual(writes, []); assert.deepEqual(errors, []); }
    return results;
  } catch (error) { await page.screenshot({ path: path.join(out, 'failure.png') }); await fs.writeFile(path.join(out, 'failure.txt'), `${error.stack}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`); throw error; }
  finally { await context.close(); }
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  if (!args.includes('--base-url') || !args.includes('--output')) throw Error('Usage: node scripts/infra-readability-smoke.mjs --base-url http://127.0.0.1:5173 --output /tmp/infra-readability [--baseline]');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox'] });
  try { console.log(JSON.stringify(await verifyInfraReadability(browser, value('--base-url'), value('--output'), { baseline: args.includes('--baseline') }), null, 2)); }
  finally { await browser.close(); }
}
