import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

const base = '/api/quick-creation';
const inputSha = '940ba09667ffdbabd5693a800e977ff4d287100309af306479c9ccd86667428b';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyWatercolor({page, api, data, match, openV9Run, verifyV9Player, receipt, out, id}) {
  assert.equal(receipt.version, 10);
  receipt.inputSha256 = inputSha;
  async function getRun(runId) {
    const run = await data(await api(base + '/runs/' + runId), 'read persisted run');
    assert.equal(run.templateId, 'watercolor');
    assert.equal(run.targetDurationSec, 60);
    assert.equal(run.attachments.length, 1);
    assert.equal(digest(run.attachments[0].excerpt), inputSha);
    return run;
  }

  async function waitForOutput(row, expected) {
    const deadline = Date.now() + 55 * 60_000;
    row.progress = [];
    let lastSample;
    while (Date.now() < deadline) {
      const run = await getRun(row.id);
      const stage = run.stages.find(item => item.status === 'running');
      const scenes = (run.scenes ?? []).map(item => ({ index: item.index, status: item.status }));
      const sample = { status: run.status, stage: stage?.key, progress: stage?.progress, scenes };
      const storyboard = page.locator('[data-qc=storyboard-preview]');
      sample.visibleStoryboard = await storyboard.isVisible();
      sample.visibleScenes = await storyboard.locator('[data-scene]').count();
      const state = JSON.stringify(sample);
      if (state !== lastSample) {
        lastSample = state;
        row.progress.push(sample);
        console.log(JSON.stringify({ id: row.id, ...sample }));
        if (sample.visibleStoryboard) await storyboard.screenshot({ path: join(out, row.id + '-progress.png') }).catch(() => {});
      }
      if (run.status === expected) return run;
      if (['failed', 'cancelled'].includes(run.status)) {
        row.failure = { code: run.failure?.code, stage: run.failure?.stageKey, message: run.failure?.message };
        assert.fail(row.id + ' failed ' + JSON.stringify(row.failure));
      }
      await delay(16_000);
    }
    assert.fail(row.id + ' exceeded the cloud acceptance time bound');
  }

  async function verifyFrames(run, row) {
    assert.ok(run.bundleUrl);
    const bundle = await data(await api(run.bundleUrl), 'read film bundle');
    assert.equal(bundle.version, 1);
    assert.ok(bundle.aac && bundle.opus && bundle.captions.length);
    row.durationSec = bundle.durationSec;
    row.captionCount = bundle.captions.length;
    await verifyV9Player(page, run, row);
    const frame = page.frameLocator('[data-qc=browser-player] iframe');
    const audio = frame.locator('audio');
    const playbackStart = await audio.evaluate(media => media.currentTime);
    await audio.evaluate(media => media.play());
    await delay(900);
    const playbackEnd = await audio.evaluate(media => { media.pause(); return media.currentTime; });
    assert.ok(playbackEnd > playbackStart + .2, 'the actual soundtrack advances');
    let from = 0;
    row.scenes = [];
    for (const [index, scene] of bundle.scenes.entries()) {
      const frameDigests = [];
      for (const fraction of [.29, .72]) {
        await audio.evaluate((media, time) => { media.currentTime = time; }, from + scene.durationSec * fraction);
        await delay(350);
        const image = await frame.locator('canvas').screenshot({ path: join(out, run.status + '-scene-' + (index + 1) + '-' + fraction + '.png') });
        frameDigests.push(digest(image));
      }
      row.scenes.push({ index: index + 1, codeSha256: digest(Buffer.from(scene.code, 'base64')), seconds: scene.durationSec,
        sampledAnimation: frameDigests[0] !== frameDigests[1] });
      from += scene.durationSec;
    }
    assert.ok(Math.abs(from - bundle.durationSec) < .1);
  }

  async function verifyPublication(final, finalRow) {
    const [published] = await Promise.all([
      page.waitForResponse(match(base + '/runs/' + final.id + '/publish', 'POST')),
      page.locator('[data-qc=publish]').click(),
    ]);
    const delivered = await data(published, 'publish to CDS preview web hosting');
    assert.ok(delivered.publish.siteId);
    finalRow.siteId = delivered.publish.siteId;
    assert.equal((await getRun(final.id)).publish.siteId, finalRow.siteId);
    await page.locator('[data-qc=open-hosting]').click();
    await page.locator('[data-hosted-site-id="' + finalRow.siteId + '"]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('focusSite'), finalRow.siteId);
    await page.screenshot({ path: join(out, '08-watercolor-published.png') });
    receipt.cases.push('Opened the published work from its final-film page');
  }

  const original = await getRun(id);
  await openV9Run(page, original);
  if (original.trial === null) {
    const finalRow = { id, kind: 'full-only' };
    receipt.runs.push(finalRow);
    if (original.status === 'done' && original.publish?.siteId) {
      finalRow.siteId = original.publish.siteId;
      await page.locator('[data-qc=open-hosting]').click();
      await page.locator('[data-hosted-site-id="' + finalRow.siteId + '"]').waitFor();
      const link = new URL(page.url());
      link.searchParams.set('openSite', finalRow.siteId);
      await page.goto(link.href);
      const player = page.frameLocator('[role=dialog][data-review-layout] iframe').first();
      const audio = player.locator('audio');
      await player.locator('canvas').waitFor();
      await audio.waitFor();
      const durationSec = await audio.evaluate(async media => {
        if (media.readyState === 0) {
          await new Promise((resolve, reject) => {
            media.addEventListener('loadedmetadata', resolve, { once: true });
            media.addEventListener('error', reject, { once: true });
          });
        }
        return media.duration;
      });
      assert.ok(Math.abs(durationSec - original.durationSec) < .1);
      const cue = original.captions.find(item => item.toSec - item.fromSec > .2);
      assert.ok(cue);
      await audio.evaluate((media, time) => { media.currentTime = time; }, (cue.fromSec + cue.toSec) / 2);
      await player.locator('figcaption span:visible').filter({ hasText: cue.text.replace(/\s+/g, ' ') }).waitFor();
      finalRow.hostedDurationSec = durationSec;
      finalRow.hostedTimedCaption = true;
      await page.screenshot({ path: join(out, '10-watercolor-hosted-player.png') });
      receipt.cases.push('Opened and seeked the already-published film inside the real hosting preview');
      return;
    }
    const final = await waitForOutput(finalRow, 'done');
    await page.reload();
    await verifyFrames(final, finalRow);
    await verifyPublication(final, finalRow);
    if (Math.abs(finalRow.durationSec - 60) > 9) receipt.failures.push({ code: 'duration_target', actual: finalRow.durationSec });
    receipt.cases.push('Final-film fallback exercised publication independently from the failing two-scene trial');
    return;
  }
  const trialRow = { id, kind: 'trial' };
  receipt.runs.push(trialRow);
  const trial = await waitForOutput(trialRow, 'trial-ready');
  await page.reload();
  await verifyFrames(trial, trialRow);
  assert.equal(trial.trial.scenes, 2);
  assert.equal(trialRow.scenes.length, 2);
  assert.ok(trialRow.durationSec > 0 && trialRow.durationSec < 60);
  console.log(JSON.stringify({ id, proof: 'trial_playback_ok', seconds: trialRow.durationSec }));

  const [approved] = await Promise.all([
    page.waitForResponse(match(base + '/runs/' + id + '/trial/approve', 'POST')),
    page.locator('[data-qc=trial-approve]').click(),
  ]);
  const next = await data(approved, 'approve and continue the same trial');
  assert.equal(next.trial.status, 'approved');
  assert.notEqual(next.id, id);
  const finalRow = { id: next.id, kind: 'full', resumedTrial: id };
  receipt.runs.push(finalRow);
  await page.locator('[data-run-id="' + next.id + '"]').first().waitFor();
  const final = await waitForOutput(finalRow, 'done');
  await page.reload();
  await verifyFrames(final, finalRow);
  assert.ok(finalRow.scenes.length > 2);
  if (finalRow.scenes.slice(0, 2).some((scene, index) => scene.codeSha256 !== trialRow.scenes[index].codeSha256 || scene.seconds !== trialRow.scenes[index].seconds)) {
    receipt.failures.push({ code: 'trial_scenes_changed' });
  }
  if (Math.abs(finalRow.durationSec - 60) > 9) receipt.failures.push({ code: 'duration_target', actual: finalRow.durationSec });
  await verifyPublication(final, finalRow);
  if (![trialRow, finalRow].some(row => row.progress.some(sample => sample.visibleScenes && sample.scenes.length))) {
    receipt.failures.push({ code: 'live_scene_preview_absent' });
  }
}
