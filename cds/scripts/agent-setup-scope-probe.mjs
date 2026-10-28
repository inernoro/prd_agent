#!/usr/bin/env node
// Real dashboard → GlobalAgentAccess → dialog. Only transport responses are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';

let browser;
let server;
const evidenceDir = process.env.CDS_AGENT_SETUP_EVIDENCE_DIR;
if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
try {
  server = await startViteDevServer();
  browser = await chromium.launch({ executablePath: process.env.CDS_CHROMIUM_PATH || undefined });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    context.setDefaultTimeout(15000);
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let projectMode = 'ok';
    let failedRequests = 0;
    let anonymousAuth = false;
    const releaseProjects = [];
    let projectRequestStarted;
    await context.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/status' && anonymousAuth) {
        await route.fulfill({ json: { authenticated: false, enabled: true } });
        return;
      }
      if (pathname === '/api/projects') {
        if (projectMode === 'wait') await new Promise(resolve => {
          releaseProjects.push(resolve);
          projectRequestStarted();
        });
        if (projectMode === 'fail' || projectMode === 'signed-out') {
          failedRequests++;
          await route.fulfill({ status: projectMode === 'signed-out' ? 401 : 503, json: { error: 'scope_probe_unavailable' } });
          return;
        }
        const projects = projectMode === 'empty' ? [] : [
          ...resolveFixture(pathname).projects,
          { id: 'cds-self', name: 'CDS Self', slug: 'cds-self' },
        ];
        await route.fulfill({ json: { projects } });
        return;
      }
      await route.fulfill(isEventStream(pathname)
        ? { contentType: 'text/event-stream', body: ': fixture\n\n' }
        : { json: resolveFixture(pathname) ?? {} });
    });
    const openEntry = async () => {
      if (width < 640) {
        await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
        await page.locator('.cds-mobile-drawer-panel').getByRole('button', { name: '接入 Agent', exact: true }).click();
      } else {
        await page.getByRole('button', { name: '接入 Agent', exact: true }).first().click();
      }
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      return dialog;
    };
    const open = async url => {
      await page.goto(server.url + url, { waitUntil: 'domcontentloaded' });
      return openEntry();
    };
    const copyPrompt = async dialog => {
      await dialog.getByRole('button', { name: '复制短接入口令', exact: true }).click();
      const prompt = await dialog.locator('pre').innerText();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), prompt);
      return new URL(prompt.match(/https?:\/\/[^，\s]+/)[0]);
    };
    const checkLayout = async name => {
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations()
          .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations))
          .map(animation => animation.finished.catch(() => {})));
      });
      const bounds = await page.getByRole('dialog').boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Dialog exceeds the viewport');
      if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `${name}-${width}.png`) });
    };

    let dialog = await open('/cds-settings#auth');
    let url = await copyPrompt(dialog);
    assert.equal(url.searchParams.get('target'), 'system');
    assert.equal(url.searchParams.has('project'), false);
    console.log(`PASS ${width}: system task stays system with CDS Self present`);
    await dialog.getByRole('button', { name: '上手助手', exact: true }).click();
    const starter = dialog.locator('[data-agent-starter="true"]');
    await starter.getByRole('button').filter({ hasText: /经验/ }).first().click();
    await starter.getByRole('button').filter({ hasText: /产品|前端|后端|全栈|测试|运维/ }).first().click();
    await starter.getByRole('button', { name: '确认这些技能', exact: true }).click();
    await starter.getByRole('button', { name: '生成我的上手包', exact: true }).click();
    await starter.getByRole('button', { name: '复制启动提示词', exact: true }).click();
    const startup = await page.evaluate(() => navigator.clipboard.readText());
    url = new URL([...startup.matchAll(/https?:\/\/[^，\s]+/g)].map(match => match[0]).find(link => link.includes('/api/agent/setup.md?')));
    assert.equal(url.searchParams.get('target'), 'system');
    assert.equal(url.searchParams.get('mission'), 'auth');
    assert.equal(url.searchParams.has('project'), false);
    console.log(`PASS ${width}: Starter preserves system SSO scope through the actual clipboard`);
    await page.keyboard.press('Escape');

    dialog = await open('/branches/not-visible');
    await dialog.getByRole('alert').filter({ hasText: '当前项目不在可见列表中' }).waitFor();
    assert.equal(await dialog.locator('pre').count(), 0);
    await dialog.getByRole('combobox').selectOption(FIXTURE_PROJECT_ID);
    url = await copyPrompt(dialog);
    assert.equal(url.searchParams.get('project'), FIXTURE_PROJECT_ID);
    console.log(`PASS ${width}: unavailable page target blocks prompt until explicit selection`);
    await page.keyboard.press('Escape');

    // Open after the surrounding page has loaded so only modal discovery fails.
    await page.goto(server.url + `/branches/${FIXTURE_PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: width < 640 ? '打开导航菜单' : '接入 Agent', exact: true }).first().waitFor();
    projectMode = 'fail';
    dialog = await openEntry();
    await dialog.getByRole('alert').filter({ hasText: '项目范围暂时无法确认' }).waitFor();
    assert(failedRequests > 0);
    assert.equal(await dialog.locator('pre').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: '复制短接入口令', exact: true }).count(), 0);
    await checkLayout('scope-error');
    projectMode = 'wait';
    const waitingForProjects = new Promise(resolve => { projectRequestStarted = resolve; });
    await dialog.getByRole('button', { name: '重新读取项目', exact: true }).click();
    const copy = dialog.getByRole('button', { name: '正在确认项目范围', exact: true });
    await copy.waitFor();
    let requestTimer;
    try {
      await Promise.race([waitingForProjects, new Promise((_, reject) => {
        requestTimer = setTimeout(() => reject(new Error('Retry did not request the project scope')), 15000);
      })]);
    } finally { clearTimeout(requestTimer); }
    assert.equal(await copy.isEnabled(), false);
    assert.equal(await dialog.locator('pre').innerText(), '正在读取当前项目范围，随后生成接入口令。');
    projectMode = 'ok';
    assert(releaseProjects.length > 0);
    for (const release of releaseProjects.splice(0)) release();
    url = await copyPrompt(dialog);
    assert.equal(url.searchParams.get('project'), FIXTURE_PROJECT_ID);
    console.log(`PASS ${width}: failed discovery → blocked retry → original project restored`);
    await checkLayout('scope-recovered');
    await page.keyboard.press('Escape');

    projectMode = 'empty';
    dialog = await open('/project-list');
    url = await copyPrompt(dialog);
    assert.equal(url.searchParams.get('target'), 'new');
    console.log(`PASS ${width}: genuine empty list still allows first project onboarding`);
    await page.keyboard.press('Escape');
    projectMode = 'signed-out';
    anonymousAuth = true;
    await page.goto(server.url + '/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '接入 Agent', exact: true }).click();
    dialog = page.getByRole('dialog');
    url = await copyPrompt(dialog);
    assert.equal(url.searchParams.get('target'), 'new');
    console.log(`PASS ${width}: signed-out discovery still allows first project approval flow`);
    await page.keyboard.press('Escape');
    anonymousAuth = false;
    dialog = await open('/branches/not-visible');
    await dialog.getByRole('alert').filter({ hasText: '当前项目不在可见列表中' }).waitFor();
    assert.equal(await dialog.locator('pre').count(), 0);
    await dialog.getByRole('button', { name: /创建一个新项目/ }).click();
    url = await copyPrompt(dialog);
    assert.equal(url.searchParams.get('target'), 'new');
    console.log(`PASS ${width}: signed-out page target stays blocked until explicit new-project choice`);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  server?.stop();
}
