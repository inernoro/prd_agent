/** Deterministic browser regression: shared picker, stacking and post-transition stability. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
const devServer = process.argv[2] ? null : await startViteDevServer();
const base = process.argv[2] || devServer.url;
const out = process.argv[3];
if (out) fs.mkdirSync(out, { recursive: true });
const results = [];
let browser;
const tracked = Array.from({ length: 25 }, (_, i) => ({ id: `tracked-${i}`, projectId: FIXTURE_PROJECT_ID, branch: `feature/tracked-${i}`, status: i === 0 ? 'error' : 'idle', services: {}, createdAt: '2026-11-01T00:00:00Z', errorMessage: i === 0 ? 'Synthetic application error' : undefined }));
const remote = Array.from({ length: 30 }, (_, i) => ({ name: `feature/remote-${i}`, subject: 'Synthetic remote branch' }));
let remoteFail = false, remoteCalls = [], submitted;
const check = (name, pass, detail) => { results.push({ name, pass, ...(detail === undefined ? {} : { detail }) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); };
try {
 browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
 for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(out && process.env.RECORD_VIDEO === 'true' ? { recordVideo: { dir: `${out}/video`, size: { width: 1440, height: 1000 } } } : {}) });
  await context.addInitScript(theme => { localStorage.setItem('cds_theme', theme); }, theme);
  await context.route('**/api/**', async route => {
   const u = new URL(route.request().url()), path = u.pathname.replace(/^\/_cds/, '');
   let body = resolveFixture(path);
   if (isEventStream(path)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
   if (path === '/api/projects') body.projects = [{ ...body.projects[0], githubRepoFullName: 'fixture/repository' }, { ...body.projects[0], id: 'project-b', name: '第二项目', aliasName: '第二项目' }];
   if (path === '/api/branches') body.branches = tracked;
   if (/^\/api\/branches\/[^/]+$/.test(path)) body = tracked[0];
   if (path === '/api/code-reviews/branches') body = { branches: u.searchParams.get('projectId') === 'project-b' ? [] : tracked };
   if (path === '/api/code-reviews/capabilities') body = { engineConfigured: true, storageConfigured: true };
   if (path === '/api/remote-branches') {
    remoteCalls.push(u.search);
    if (remoteFail) return route.fulfill({ status: 502, json: { message: 'Synthetic fetch failure' } });
    body = { branches: u.searchParams.get('project') === 'project-b' ? [] : remote, defaultBranch: 'feature/remote-0' };
   }
   if (path === '/api/code-reviews' && route.request().method() === 'POST') { submitted = route.request().postDataJSON(); body = { task: { id: 'accepted', projectId: FIXTURE_PROJECT_ID, status: 'queued', sourceType: submitted.sourceType, sourceName: submitted.ref, progress: {}, delivery: {} } }; }
   await route.fulfill({ json: body || {} });
  });
  const page = await context.newPage();
  await page.goto(`${base}/code-reviews?view=source`, {waitUntil:'domcontentloaded'});
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await page.locator('.cr-project-choice').first().click();
  const search = page.getByRole('combobox', { name: '搜索审查分支' });
  const hasPicker = await search.count() > 0;
  check(`${theme}: review reuses searchable branch picker`, hasPicker);
  if (hasPicker) {
   await search.fill('REMOTE-29');
   await page.getByRole('button', { name: /feature\/remote-29/ }).click();
   await page.getByRole('button', { name: '下一步：确认', exact: true }).click();
   check(`${theme}: confirmation shows remote selection`, (await page.locator('.cr-confirm-list').innerText()).includes('feature/remote-29'));
   await page.getByRole('button', { name: '返回修改', exact: true }).click();
   await search.focus(); await search.fill('');
   check(`${theme}: all 30 remote branches remain selectable`, await page.locator('[aria-label="分支建议"] button').filter({ hasText: 'feature/remote-' }).count() === 30);
   if (out) await page.screenshot({ path: `${out}/review-${theme}.png` });
   await page.getByRole('button', { name: '刷新远程', exact: true }).click();
   await page.waitForFunction(() => !document.querySelector('.cr-label button')?.disabled);
   check(`${theme}: explicit refresh fetches origin`, remoteCalls.some(q => new URLSearchParams(q).get('force') === 'true'));
   remoteFail = true;
   await page.getByRole('button', { name: '刷新分支', exact: true }).click();
   await page.getByText('远程分支读取失败，请刷新重试。').first().waitFor();
   await search.focus();
   check(`${theme}: refresh failure preserves selectable cached branches`, await page.getByRole('button', { name: /feature\/remote-29/ }).count() === 1);
   remoteFail = false;
   await page.getByRole('button', { name: '刷新分支', exact: true }).click();
   await page.getByText('远程分支读取失败，请刷新重试。').waitFor({ state: 'hidden' });
   await search.focus();
   await page.getByRole('button', { name: /feature\/remote-29/ }).click();
   await page.getByRole('button', { name: '下一步：确认', exact: true }).click();
   await page.getByRole('button', { name: '确认并开始审查', exact: true }).click();
   await page.waitForURL(/task=accepted/);
   check(`${theme}: submission pins selected project repository/ref`, submitted?.sourceType === 'github' && submitted?.ref === 'feature/remote-29' && submitted?.githubUrl === 'https://github.com/fixture/repository' && !submitted?.branchId);
   await page.goto(`${base}/code-reviews?view=source`, {waitUntil:'domcontentloaded'});
   await page.locator('.cr-project-choice').first().click();
   await search.fill('tracked-24');
   await page.getByRole('button', { name: /feature\/tracked-24/ }).click();
   await page.locator('.cr-project-choice').filter({hasText:'第二项目'}).click();
   check(`${theme}: switching project clears previous selection`, await page.getByRole('button',{name:'下一步：确认',exact:true}).isDisabled());
  }
  await page.goto(`${base}/branches/${FIXTURE_PROJECT_ID}`, {waitUntil:'domcontentloaded'});
  await page.locator('[data-branch-card-id="tracked-0"]').waitFor();
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  const input = page.getByPlaceholder(/搜索分支/);
  await input.focus(); await page.locator('[aria-label="分支建议"]').waitFor();
  await page.waitForTimeout(750);
  const hit = await page.evaluate(() => {
   const card = document.querySelector('[data-branch-card-id="tracked-0"]'), menu = document.querySelector('[aria-label="分支建议"]');
   const a=card.getBoundingClientRect(), b=menu.getBoundingClientRect();
   const left=Math.max(a.left,b.left), right=Math.min(a.right,b.right), top=Math.max(a.top,b.top), bottom=Math.min(a.bottom,b.bottom);
   if(right<=left||bottom<=top) return { overlap: false };
   const target = document.elementFromPoint((left+right)/2,(top+bottom)/2);
   return { overlap: true, menuOnTop:menu.contains(target), cardZ:getComputedStyle(card).zIndex };
  });
  check(`${theme}: error card stays below dropdown`, hit.overlap && hit.menuOnTop, hit);
  if(out) await page.screenshot({path:`${out}/layer-${theme}.png`});
  await input.press('Escape');
  await page.evaluate(() => {
   window.drawerProbe={starts:[],frames:[],begin:performance.now()};
   document.addEventListener('animationstart', e => { if(e.target.classList?.contains('cds-branch-detail-drawer')) window.drawerProbe.starts.push(e.animationName); });
   const sample=()=>{const el=document.querySelector('.cds-branch-detail-drawer'); if(el) window.drawerProbe.frames.push({t:performance.now()-window.drawerProbe.begin,x:el.getBoundingClientRect().x,transform:getComputedStyle(el).transform}); if(performance.now()-window.drawerProbe.begin<1700)requestAnimationFrame(sample);};requestAnimationFrame(sample);
  });
  await page.locator('[data-branch-card-id="tracked-0"]').click({ position: { x: 130, y: 30 } });
  await page.locator('.cds-branch-detail-drawer').waitFor();
  await page.waitForTimeout(1800);
  const probe = await page.evaluate(()=>window.drawerProbe);
  check(`${theme}: no second drawer animation after camera ends`, !probe.starts.includes('cds-drawer-slide-in'), {starts:probe.starts, driftingFrames:probe.frames.filter(f=>f.t>850&&f.transform!=='none')});
  await page.keyboard.press('Escape'); await page.locator('.cds-branch-detail-drawer').waitFor({state:'hidden'});
  // Reopen verifies the marker is per mount and return does not strand a snapshot.
  await page.locator('[data-branch-card-id="tracked-0"]').click({ position: { x: 130, y: 30 } });
  await page.locator('.cds-branch-detail-drawer').waitFor();await page.waitForTimeout(850);
  check(`${theme}: reopening settles without transform`, await page.locator('.cds-branch-detail-drawer').evaluate(el=>getComputedStyle(el).transform==='none'));
  await page.keyboard.press('Escape'); await page.locator('.cds-branch-detail-drawer').waitFor({state:'hidden'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('[data-branch-card-id="tracked-0"]').click({position:{x:130,y:30}});
  await page.locator('.cds-branch-detail-drawer').waitFor();
  check(`${theme}: reduced motion opens usable drawer`, await page.getByRole('dialog',{name:'分支详情'}).isVisible());
  if (hasPicker) {
   await page.keyboard.press('Escape');
   await page.setViewportSize({width:390,height:844});
   await page.goto(`${base}/code-reviews?view=source`, {waitUntil:'domcontentloaded'});
   await page.locator('.cr-project-choice').first().click(); await search.focus();
   await page.getByRole('button',{name:/feature\/remote-29/}).waitFor({state:'attached'});
   const fits = await page.locator('[aria-label="分支建议"]').evaluate(el=>{const r=el.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth,scrollable:el.scrollHeight>el.clientHeight};});
   check(`${theme}: mobile picker fits and scrolls all branches`,fits.fits&&fits.scrollable,fits);
   if(out) await page.screenshot({path:`${out}/mobile-${theme}.png`});
  }
  await context.close();
 }
} finally { await browser?.close(); devServer?.stop(); }
console.log(JSON.stringify({ source: 'deterministic-fixture', base, results }, null, 2));
if(out)fs.writeFileSync(`${out}/results.json`,JSON.stringify({source:'deterministic-fixture',base,results},null,2));
assert.ok(results.every(r=>r.pass), `${results.filter(r=>!r.pass).length} regression assertions failed`);
