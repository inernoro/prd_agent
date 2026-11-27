import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.E2E_BASE_URL);
const commit = process.env.E2E_EXPECTED_COMMIT;
const generate = process.env.E2E_QC_GENERATE === 'true';
const retryFilmId = process.env.E2E_QC_RETRY_FILM || '';
const existingWebId = process.env.E2E_QC_EXISTING_WEB || '';
const auditFilmId = process.env.E2E_QC_AUDIT_FILM || '';
const publishedCheck = process.env.E2E_QC_PUBLISHED_CHECK === 'true';
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD && process.env.RUNNER_TEMP);
if (generate) assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Review original tasks before repeating paid jobs');
if (retryFilmId) assert.match(retryFilmId, /^[a-f0-9]{32}$/);
if (existingWebId) assert.match(existingWebId, /^[a-f0-9]{32}$/);
if (auditFilmId) {
  assert.match(auditFilmId, /^[a-f0-9]{32}$/);
  assert.equal(generate, false, 'Evidence mode must read a finished film without starting a task');
}
if (publishedCheck) assert.ok(auditFilmId && existingWebId && !generate);
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
  if (mobile) await page.getByPlaceholder('搜索智能体、工具').fill('快速创作');
  const card = mobile ? page.getByRole('button', { name: /^快速创作/ })
    : page.locator('.toolbox-tool-card').filter({ has: page.getByText('快速创作', { exact: true }) });
  await card.getByText('开发中', { exact: true }).waitFor();
  receipt.cases.push(`${mobile ? 'mobile' : 'desktop'} toolbox quick creation card has the in-development badge`);
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

async function verifyHosting(page, row) {
  assert.match(row.siteId, /^[a-f0-9]{32}$/);
  const target = `[data-hosted-site-id="${row.siteId}"]`;
  try {
    await page.locator('[data-qc=open-hosting]').click();
    await page.waitForFunction(selector => location.pathname === '/web-pages'
      && document.querySelector(selector)?.style.outline === '2px solid var(--accent-primary)', target, { timeout: 12_000 });
    await page.screenshot({ path: join(out, `09-${row.kind}-hosting-focus.png`) });
    row.hostingHighlighted = true;
  } catch (error) {
    row.hosting = await page.evaluate(selector => ({
      pathname: location.pathname,
      focusRequested: new URLSearchParams(location.search).has('focusSite'),
      matchingCards: document.querySelectorAll(selector).length,
    }), target);
    receipt.failures.push({ id: row.id, kind: row.kind, code: 'hosting_focus', details: String(error.message).slice(0, 250) });
    await page.screenshot({ path: join(out, `09-${row.kind}-hosting-failure.png`) }).catch(() => {});
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(55_000);
  const version = await data(await page.request.get(new URL('/api/version', origin).href), 'MAP version');
  assert.equal(version.actualCommit, commit);
  const token = await openWorkbench(page);
  const api = (path, { headers, ...options } = {}) => page.request.fetch(new URL(path, origin).href, {
    headers: { Authorization: `Bearer ${token}`, 'X-Client': 'admin', ...headers },
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
    receipt.cases.push('distinct touch context and no 375px page overflow');
    if (publishedCheck) {
      await phone.goto(new URL(`/quick-creation-agent?run=${auditFilmId}`, origin).href);
      await phone.getByRole('tab', { name: /^预览/ }).click();
      await phone.locator('[data-qc=film]').waitFor();
      await phone.waitForFunction(() => document.querySelector('[data-qc=film]')?.readyState >= 2);
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375);
      await phone.screenshot({ path: join(out, '05-phone-playback.png') });
      receipt.cases.push('published film playable at 375px without page overflow');
    }
  } catch (error) {
    await phone.screenshot({ path: join(out, '04-phone-failure.png') }).catch(() => {});
    receipt.failures.push({ kind: 'mobile', code: 'navigation', details: String(error.message).slice(0, 250) });
  } finally {
    await phone.close();
  }
  if (auditFilmId) {
    const film = await data(await api(`${base}/runs/${auditFilmId}`), 'read completed film');
    assert.equal(film.kind, 'video');
    assert.equal(film.status, 'done');
    assert.equal(film.publish.status, 'done');
    assert.ok(film.publish.siteId);
    const row = { id: film.id, kind: 'video', currentStatus: film.status, durationSec: film.durationSec,
      siteId: film.publish.siteId, captionCount: film.captions?.length ?? 0 };
    receipt.runs.push(row);
    await verifyPreview(page, film, row);
    if (publishedCheck) {
      const captionToggle = page.locator('[data-qc=captions-toggle]');
      assert.equal(await captionToggle.isEnabled(), false);
      if (await captionToggle.getAttribute('aria-label') !== '本片没有可切换的字幕轨') {
        receipt.failures.push({ id: film.id, kind: 'video', code: 'caption_control_label' });
      }
      await verifyHosting(page, row);
      const web = await data(await api(`${base}/runs/${existingWebId}`), 'read completed webpage');
      assert.equal(web.kind, 'web');
      assert.equal(web.status, 'done');
      assert.equal(web.publish.status, 'done');
      const webRow = { id: web.id, kind: 'web', currentStatus: web.status, siteId: web.publish.siteId };
      receipt.runs.push(webRow);
      await verifyPreview(page, web, webRow);
      await verifyHosting(page, webRow);
      if (row.hostingHighlighted && webRow.hostingHighlighted) {
        receipt.cases.push('both existing publications opened in hosting and highlighted the exact record');
      }
    } else {
      const media = await api(film.media.url, { timeout: 60_000 });
      assert.equal(media.status(), 200);
      assert.equal(media.headers()['content-type'].split(';')[0], 'video/mp4');
      const bytes = await media.body();
      assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
      assert.ok(bytes.length < 128 * 1024 * 1024);
      await writeFile(join(process.env.RUNNER_TEMP, 'existing-v6-film.mp4'), bytes);
      const video = page.locator('[data-qc=film]');
      for (const second of [4, 10, 18, 25, 33, 40, 44, 49].filter(value => value < film.durationSec)) {
        await video.evaluate((element, seconds) => new Promise(resolve => {
          element.addEventListener('seeked', resolve, { once: true });
          element.currentTime = seconds;
        }), second);
        await video.screenshot({ path: join(out, `film-${String(second).padStart(2, '0')}s.png`) });
      }
      receipt.cases.push('existing published film decoded and rendered in the cloud player at eight points');
    }
  }
  if (generate) {
    const filmInput = { kind: 'video', templateId: 'sketchnote', ask: '', attachmentIds: [original.id], title: '需求评审的三个习惯' };
    const unverified = await api(base + '/runs', { method: 'POST', data: filmInput });
    assert.equal(unverified.status(), 400, 'A request without explicit intent must not create a task');
    assert.equal((await unverified.json()).error?.code, 'TASK_INTENT_REQUIRED');
    receipt.cases.push('generation is rejected unless the authenticated request supplies explicit intent');
    let web;
    try {
      if (existingWebId) {
        const existing = await data(await api(`${base}/runs/${existingWebId}`), 'read existing published webpage');
        assert.equal(existing.status, 'done');
        assert.equal(existing.kind, 'web');
        assert.equal(existing.templateId, 'ink-wash');
        assert.equal(existing.attachments[0]?.excerpt, original.excerpt);
        assert.ok(existing.publish.siteId);
        const row = { id: existing.id, kind: 'web', currentStatus: 'done', siteId: existing.publish.siteId, reused: true };
        receipt.runs.push(row);
        await verifyPreview(page, existing, row);
        await page.locator('[data-qc=published]').waitFor();
        receipt.cases.push('the previously published webpage and its preview survived the deployment');
      } else {
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
      }
    } catch (error) {
      receipt.failures.push({ kind: 'web', code: 'admission', details: String(error.message).slice(0, 250) });
    }
    try {
      const prior = retryFilmId ? await data(await api(`${base}/runs/${retryFilmId}`), 'read the original failed video') : null;
      if (prior) {
        assert.equal(prior.status, 'failed');
        assert.equal(prior.kind, 'video');
        assert.equal(prior.templateId, 'sketchnote');
        assert.equal(prior.attachments[0]?.excerpt, original.excerpt);
      }
      const filmPath = prior ? `${base}/runs/${prior.id}/retry` : base + '/runs';
      const filmRequest = {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        data: prior ? { action: 'requeue' } : filmInput,
      };
      const film = await data(await api(filmPath, filmRequest), 'queue real code video');
      receipt.runs.push({ id: film.id, kind: 'video', admitted: film.status, retryOf: prior?.id });
      console.log(`Quick creation video ${film.id}: ${film.status}`);
      assert.equal(film.kind, 'video');
      assert.equal(film.attachments[0].id, prior?.attachments[0]?.id ?? original.id);
      assert.equal(film.templateId, 'sketchnote');
      if (prior) {
        assert.notEqual(film.id, prior.id);
        const replay = await api(filmPath, filmRequest);
        assert.equal(replay.headers()['idempotency-replayed'], 'true');
        assert.equal((await data(replay, 'replay the same video retry')).id, film.id);
        receipt.cases.push('retry reused the original video inputs and replay returned the same task ID');
      }
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
    const expected = new Map(receipt.runs.filter(row => !row.reused).map(row => [row.id, (row.kind === 'web' ? 22 : 135) * 60_000]));
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
        const stage = view.stages?.find(item => item.status === 'running') ?? view.stages?.at(-1);
        if (stage) {
          row.stages ??= [];
          if (row.stages.at(-1)?.key !== stage.key || row.stages.at(-1)?.status !== stage.status) {
            row.stages.push({ key: stage.key, label: stage.label, status: stage.status, elapsedSec: view.elapsedSec });
          }
        }
        if (view.status === 'failed' || Date.now() - started > budget) {
          const failure = { id, kind: view.kind,
            code: view.status === 'failed' ? 'task_failed' : 'acceptance_deadline',
            stage: view.failure?.stageKey ?? stage?.key, message: view.failure?.message };
          receipt.failures.push(failure);
          console.log(JSON.stringify(failure));
          expected.delete(id);
          continue;
        }
        if (view.status !== 'done') continue;
        try {
          if (view.kind === 'video') {
            const response = await api(view.media.url, { headers: { Range: 'bytes=0-31' } });
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
  }
  assert.equal(receipt.failures.length, 0, JSON.stringify(receipt.failures));
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
