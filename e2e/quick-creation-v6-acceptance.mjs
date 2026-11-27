import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.E2E_BASE_URL);
const commit = process.env.E2E_EXPECTED_COMMIT;
const generate = process.env.E2E_QC_GENERATE === 'true';
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD && process.env.RUNNER_TEMP);
if (generate) assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Review original tasks before repeating paid jobs');
const out = join(process.env.RUNNER_TEMP, 'dsn-1400e277-evidence');
await mkdir(out, { recursive: true });
const receipt = { design: 'DSN-1400E277', version: 6, commit, origin: origin.origin, cases: [], runs: [], failures: [] };
const base = '/api/quick-creation';

const match = (path, method = 'GET') => response => new URL(response.url()).origin === origin.origin
  && new URL(response.url()).pathname === path && response.request().method() === method;

async function data(response, name) {
  assert.ok(response.ok(), `${name} HTTP ${response.status()}`);
  const envelope = await response.json();
  assert.notEqual(envelope.success, false, `${name} ${envelope.error?.code ?? ''}`);
  return envelope.data ?? envelope;
}

async function openWorkbench(page, { mobile = false } = {}) {
  await page.goto(origin.href);
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
  await page.locator('input[autocomplete="username"]').first().fill(process.env.E2E_USER);
  await page.locator('input[autocomplete="current-password"]').first().fill(process.env.E2E_PASSWORD);
  const [login] = await Promise.all([
    page.waitForResponse(match('/api/v1/auth/login', 'POST')),
    page.getByRole('button', { name: '开始身份确认', exact: true }).click(),
  ]);
  const { accessToken } = await data(login, 'MAP login');
  assert.ok(accessToken);
  if (mobile) {
    await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  }
  const toolbox = page.locator('nav button[title^="百宝箱"]:visible')
    .or(page.getByRole('button', { name: /^(?:AI\s*)?百宝箱$/ }).filter({ visible: true })).first();
  await toolbox.click();
  const card = page.locator('.toolbox-tool-card').filter({ has: page.getByText('快速创作', { exact: true }) });
  await card.getByText('开发中', { exact: true }).waitFor();
  const [templates] = await Promise.all([
    page.waitForResponse(match(base + '/templates')),
    card.getByText('快速创作', { exact: true }).click(),
  ]);
  assert.equal(new URL(page.url()).pathname, '/quick-creation-agent');
  const catalog = await data(templates, 'style catalog');
  assert.equal(catalog.categories.length, 15);
  assert.equal(catalog.items.length, 99);
  assert.equal(new Set(catalog.items.map(style => style.id)).size, 99);
  assert.equal(catalog.source.name, 'Lemo-Opuscar by Lemomo (LemoLab)');
  assert.ok(catalog.items.every(style => style.posterUrl && style.promptRef && !style.guide));
  await page.locator('[data-qc-ready="compose"]').waitFor();
  return accessToken;
}

async function verifyPreview(page, view, row) {
  await page.goto(new URL(`/quick-creation-agent?run=${encodeURIComponent(view.id)}`, origin).href);
  await page.locator(`[data-run-id="${view.id}"] [data-qc=done-card]`).waitFor();
  if (view.kind === 'video') {
    const video = page.locator('[data-qc=film]');
    await video.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-qc=film]')?.readyState >= 2);
    await page.locator('[data-qc=play-toggle]').click();
    await page.waitForFunction(() => document.querySelector('[data-qc=film]')?.currentTime > 0);
    await page.locator('[data-qc=play-toggle]').click();
    const caption = view.captions?.find(cue => cue.toSec - cue.fromSec >= 0.25 && cue.toSec <= view.durationSec + 0.1);
    if (caption) {
      await video.evaluate((element, second) => { element.currentTime = second; }, (caption.fromSec + caption.toSec) / 2);
      await page.waitForFunction(expected => document.querySelector('[data-qc=caption]')?.textContent === expected, caption.text);
      row.captionSeek = 'pass';
    }
  } else {
    const frame = page.frameLocator('[data-qc=web-preview] iframe');
    await frame.locator('body').waitFor();
    row.visibleText = (await frame.locator('body').innerText()).trim().slice(0, 5000);
    assert.ok(row.visibleText.length > 100, 'Real webpage preview has visible content');
    row.headings = await frame.locator('h1, h2, h3').allTextContents();
  }
  await page.screenshot({ path: join(out, `07-${view.kind}-preview.png`) });
  row.preview = 'pass';
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(55_000);
  const version = await data(await page.request.get(new URL('/api/version', origin).href), 'MAP version');
  assert.equal(version.actualCommit, commit);
  const token = await openWorkbench(page);
  const api = (path, options = {}) => page.request.fetch(new URL(path, origin).href, {
    headers: { Authorization: `Bearer ${token}`, 'X-Client': 'admin' },
    timeout: 20_000,
    ...options,
  });
  await page.screenshot({ path: join(out, '01-desktop-compose.png') });
  assert.equal(await page.locator('[data-qc=submit]').isEnabled(), false);
  assert.ok(await page.locator('[data-qc=block-reason]').isVisible());
  const chip = page.locator('[data-qc=style-chip]');
  await chip.click();
  const popover = page.locator('[data-qc=style-popover]');
  await popover.getByRole('textbox').fill('水墨');
  await popover.getByRole('radio', { name: /中国水墨/ }).click();
  assert.match(await chip.getAttribute('aria-label'), /中国水墨/);
  await page.getByRole('radiogroup', { name: '选择产出' }).getByRole('radio', { name: '网页', exact: true }).click();
  assert.match(await chip.getAttribute('aria-label'), /中国水墨/);
  assert.equal(await page.locator('[data-qc-ready="compose"]').getAttribute('data-output'), 'web');
  await page.screenshot({ path: join(out, '02-desktop-web-style.png') });
  receipt.cases.push('real navigation, catalog, poster source, disabled empty submit, style independent from output');

  const [sample] = await Promise.all([
    page.waitForResponse(match(base + '/attachments/knowledge', 'POST')),
    page.getByRole('button', { name: /用示例稿件试一下/ }).click(),
  ]);
  const original = await data(sample, 'sample document');
  assert.equal(original.name, '需求评审的三个习惯.md');
  assert.equal(original.status, 'ready');
  assert.ok(original.excerpt.includes('习惯三：最后对验收'));
  await page.locator('[data-qc=submit]:enabled').waitFor();
  await page.screenshot({ path: join(out, '03-desktop-source.png') });
  receipt.cases.push('fixed V6 sample loaded and eligible');

  const phone = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  phone.setDefaultTimeout(55_000);
  try {
    await openWorkbench(phone, { mobile: true });
    const phoneWidth = await phone.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(phoneWidth.viewport, 375);
    assert.equal(phoneWidth.scroll, phoneWidth.viewport);
    await phone.screenshot({ path: join(out, '04-phone-compose.png') });
  } catch (error) {
    await phone.screenshot({ path: join(out, '04-phone-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await phone.close();
  }
  receipt.cases.push('distinct touch context and no 375px page overflow');

  if (generate) {
    let web;
    try {
      const [created] = await Promise.all([
        page.waitForResponse(match(base + '/runs', 'POST')),
        page.locator('[data-qc=submit]').click(),
      ]);
      web = await data(created, 'queue real webpage');
      receipt.runs.push({ id: web.id, kind: 'web', admitted: web.status });
      console.log(`Quick creation web ${web.id}: ${web.status}`);
      assert.equal(web.kind, 'web');
      assert.equal(web.attachments[0].id, original.id);
      assert.equal(web.templateId, 'ink-wash');
    } catch (error) {
      receipt.failures.push({ kind: 'web', code: 'admission', details: String(error.message).slice(0, 250) });
    }
    try {
      const film = await data(await api(base + '/runs', {
        method: 'POST',
        data: { kind: 'video', templateId: 'sketchnote', ask: '', attachmentIds: [original.id], title: '需求评审的三个习惯' },
      }), 'queue real code video');
      receipt.runs.push({ id: film.id, kind: 'video', admitted: film.status });
      console.log(`Quick creation video ${film.id}: ${film.status}`);
      assert.equal(film.kind, 'video');
      assert.equal(film.attachments[0].id, original.id);
      assert.equal(film.templateId, 'sketchnote');
    } catch (error) {
      receipt.failures.push({ kind: 'video', code: 'admission', details: String(error.message).slice(0, 250) });
    }
    if (web) {
      try {
        await page.locator('[data-qc=saved-notice]').waitFor();
        await page.reload();
        await page.locator(`[data-run-id="${web.id}"]`).waitFor();
        await page.screenshot({ path: join(out, '05-recovered-run.png') });
        const runUrl = new URL(`${base}/runs/${web.id}`, origin).href;
        await page.route(runUrl, route => route.abort('internetdisconnected'), { times: 1 });
        await page.locator('[data-qc=reconnecting]').waitFor();
        await page.screenshot({ path: join(out, '06-disconnected-run.png') });
        await page.locator('[data-qc=reconnecting]').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('[data-run-id]').getAttribute('data-run-id'), web.id);
        receipt.cases.push('transient browser disconnect, same persisted task resumed automatically');
      } catch (error) {
        receipt.failures.push({ id: web.id, kind: 'web', code: 'recovery', details: String(error.message).slice(0, 250) });
      }
    }
    const expected = new Map(receipt.runs.map(row => [row.id, (row.kind === 'web' ? 22 : 135) * 60_000]));
    const started = Date.now();
    while (expected.size) {
      for (const [id, budget] of expected) {
        const view = await data(await api(`${base}/runs/${id}`), 'read durable run');
        const row = receipt.runs.find(item => item.id === id);
        if (row.currentStatus !== view.status) {
          console.log(`Quick creation ${view.kind} ${id}: ${view.status}`);
        }
        row.currentStatus = view.status;
        row.elapsedSec = view.elapsedSec;
        row.stages = view.stages?.map(({ id, label, status }) => ({ id, label, status }));
        if (view.status === 'failed' || Date.now() - started > budget) {
          const failure = { id, kind: view.kind, code: view.failure?.code ?? (view.status === 'failed' ? 'task_failed' : 'acceptance_deadline') };
          receipt.failures.push(failure);
          console.log(JSON.stringify(failure));
          expected.delete(id);
          continue;
        }
        if (view.status !== 'done') continue;
        try {
          if (view.kind === 'video') {
            const response = await api(view.media.url, { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-31' } });
            assert.equal(response.status(), 206);
            assert.equal((await response.body()).toString('ascii', 4, 8), 'ftyp');
            assert.ok(view.durationSec > 0);
            row.durationSec = view.durationSec;
            row.captionCount = view.captions?.length ?? 0;
          } else {
            assert.ok(view.previewSiteId);
          }
          await verifyPreview(page, view, row);
          const publish = `${base}/runs/${id}/publish`;
          const [published] = await Promise.all([
            page.waitForResponse(match(publish, 'POST')),
            page.locator('[data-qc=publish]').click(),
          ]);
          const a = await data(published, 'publish completed output through the UI');
          const b = await data(await api(publish, { method: 'POST', data: {} }), 'repeat same publication');
          assert.ok(a.publish.siteId && a.publish.siteId === b.publish.siteId);
          await page.locator('[data-qc=published]').waitFor();
          row.siteId = a.publish.siteId;
          await page.screenshot({ path: join(out, `08-${view.kind}-published.png`) });
          if (view.kind === 'video' && !row.captionSeek) {
            receipt.failures.push({ id, kind: view.kind, code: 'no_timed_caption_verified' });
          }
        } catch (error) {
          receipt.failures.push({ id, kind: view.kind, code: 'preview_or_publication', details: String(error.message).slice(0, 250) });
          await page.screenshot({ path: join(out, `07-${view.kind}-failure.png`) }).catch(() => {});
        }
        expected.delete(id);
      }
      if (expected.size) await delay(20_000);
    }
    assert.equal(receipt.failures.length, 0, JSON.stringify(receipt.failures));
  }
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
