import { test, expect } from '@playwright/test';
import { installOperationsFixtures } from '../fixtures/admin-operations.mjs';
import { captureSpeaker, observeNativeAudio, nativeAudioEvidence } from '../fixtures/admin-operations-audio';

// Observe real browser audio. No fake AudioContext, autoplay preference, or fabricated readiness.
test('网关原生音频：点击激活、静音、扫描与确认提示音', async ({ page, browser }, testInfo) => {
  await observeNativeAudio(page);
  await installOperationsFixtures(page, { quickstart: true });
  const ended = (duration: number) => page.evaluate(d => Reflect.get(window, 'gatewayNativeAudio').filter((entry: { event: string; duration: number; elapsed: number }) => entry.event === 'ended' && Math.abs(entry.duration - d) < .01 && entry.elapsed >= d - .08).length, duration);
  try {
    await page.goto('http://127.0.0.1:8200/llmgw/login');
    await page.locator('#llmgw-username').fill('demo');
    await page.locator('#llmgw-password').fill('demo');
    await captureSpeaker(testInfo, 'password-entry', true, async () => {
      await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
      await expect(page).toHaveURL(/\/quickstart$/);
      await expect(page.locator('.lg-console-header')).toBeVisible({ timeout: 12000 });
      await expect.poll(() => ended(1.8)).toBeGreaterThan(0);
    });
    await page.reload();
    const sound = page.locator('.gateway-chrome-sound');
    await expect(sound).toHaveAttribute('data-audio-status', 'pending');
    await captureSpeaker(testInfo, 'entry-reveal', true, async () => {
      await sound.click();
      await expect(sound).toHaveAttribute('data-audio-status', 'ready');
      await expect.poll(() => ended(1.8)).toBeGreaterThan(0);
    });
    const started = () => page.evaluate(() => Reflect.get(window, 'gatewayNativeAudio').filter((entry: { event: string }) => entry.event === 'started').length);
    await sound.click();
    await expect(sound).toHaveAttribute('data-audio-status', 'muted');
    const quiet = await started();
    await captureSpeaker(testInfo, 'muted-scan', false, async () => {
      await page.getByRole('textbox', { name: '我想做什么', exact: true }).fill('为团队知识库接入问答助手');
      await page.getByRole('button', { name: '准备接入', exact: true }).click();
      await expect(page.getByRole('button', { name: '下一步', exact: true })).toBeEnabled();
      await page.waitForTimeout(650); // Assert silence over the whole 550ms scan cue.
    });
    expect(await started()).toBe(quiet);
    await sound.click();
    await expect(sound).toHaveAttribute('data-audio-status', 'ready');
    await expect.poll(() => ended(1.8)).toBeGreaterThan(1);
    await captureSpeaker(testInfo, 'intent-scan', true, async () => {
      await page.getByRole('button', { name: '重新生成', exact: true }).click();
      await expect.poll(() => ended(.55)).toBeGreaterThan(0);
    });
    await captureSpeaker(testInfo, 'access-verified', true, async () => {
      await page.getByRole('button', { name: '下一步', exact: true }).click();
      await expect.poll(() => ended(1.05)).toBeGreaterThan(0);
    });
    await expect(page.getByRole('heading', { name: '设定归属与预算', exact: true })).toBeVisible();
  } finally {
    const native = await nativeAudioEvidence(page);
    const evidence = { engine: testInfo.project.name, version: browser.version(), ...native };
    console.log('Native audio evidence:', JSON.stringify(evidence));
    await testInfo.attach('native-audio-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  }
});
