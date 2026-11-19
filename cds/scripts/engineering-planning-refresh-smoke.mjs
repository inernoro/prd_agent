import assert from 'node:assert/strict';
import path from 'node:path';
import { isEventStream, resolveFixture } from './fixtures/mobile-layout-fixtures.mjs';

export async function verifyEngineeringPlanningRefresh(browser, base, out) {
  const projectId = 'fixture-project';
  const id = 'debt-fixture-refresh';
  const today = '2026-11-20';
  const createdAt = today + 'T01:00:00Z';
  const target = `/api/projects/${projectId}/planning`;
  const detailPath = `${target}/debts/${id}`;
  const commandsPath = `${target}/commands`;
  const apiPath = url => new URL(url).pathname.replace(/^\/_cds/, '');
  const actor = { kind: 'human', id: 'fixture-owner', label: '合成验收账号' };
  const title = '合成债务版本回读';
  const note = '合成进展已记录';
  let debt = {
    id, projectId, title, version: 1, status: 'open', priority: 'mid', createdAt, updatedAt: createdAt,
    source: { type: 'test', ref: 'fixture-debt-refresh' },
    criteria: [{ id: 'fixture-criterion', text: '记录进展使用当前版本' }], reopenCount: 0, hitCount: 0,
  };
  const events = [];
  const writes = [];
  let releaseDetail;
  const detailGate = new Promise(resolve => { releaseDetail = resolve; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  await context.route('**/api/**', async route => {
    const request = route.request();
    const pathname = apiPath(request.url());
    if (isEventStream(pathname) || pathname === '/api/activity-stream') {
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    }
    if (pathname === '/api/auth/status') {
      return route.fulfill({ json: { enabled: true, authenticated: true, user: { ...actor, name: actor.label, isSystemOwner: true } } });
    }
    if (pathname === target) {
      return route.fulfill({ json: { ...resolveFixture(target), permissions: ['read', 'write'] } });
    }
    if (pathname === target + '/debts') return route.fulfill({ json: { projectId, today, items: [debt], nextCursor: null } });
    if (pathname === detailPath) {
      if (debt.version === 2) await detailGate;
      return route.fulfill({ json: { projectId, debt, events } });
    }
    if (pathname === commandsPath && request.method() === 'POST') {
      const { type, expectedVersion, debtId, reviewAt, reason, note } = request.postDataJSON();
      writes.push({ type, expectedVersion, debtId });
      if (debtId !== id || expectedVersion !== debt.version) {
        return route.fulfill({ status: 409, json: { error: 'version_conflict', message: '记录已经变化，请刷新后重试' } });
      }
      if (type !== 'debt.defer' && type !== 'debt.progress') return route.fulfill({ status: 400, json: { error: 'unexpected_command' } });
      const deferred = type === 'debt.defer';
      debt = { ...debt, version: debt.version + 1, status: deferred ? 'deferred' : 'in_progress',
        reviewAt: deferred ? reviewAt : undefined, deferReason: deferred ? reason : undefined };
      events.unshift({ id: `event-${debt.version}`, projectId, entity: 'debt', entityId: id,
        type: deferred ? 'deferred' : 'progress', at: createdAt, actor, note: deferred ? reason : note });
      return route.fulfill({ status: 201, json: { projectId, result: debt, reused: false } });
    }
    return route.fulfill({ json: resolveFixture(pathname) ?? {} });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(base + '/project-list');
    await page.getByRole('link', { name: '工程规划', exact: true }).click();
    await page.getByRole('heading', { name: '待你确认', exact: true }).waitFor();
    await page.getByRole('button', { name: /^债务分支/ }).click();
    await page.getByRole('button', { name: title, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: title, exact: true });
    await drawer.getByRole('button', { name: '暂缓', exact: true }).click();
    const deferForm = page.getByRole('dialog', { name: '暂缓', exact: true });
    await deferForm.getByLabel('下次回看日期').fill('2026-11-23');
    await deferForm.getByLabel('暂缓原因').fill('合成暂缓原因');
    const detailRequested = page.waitForRequest(request => request.method() === 'GET' && apiPath(request.url()) === detailPath);
    await deferForm.getByRole('button', { name: '保存', exact: true }).click();
    await detailRequested;

    const progress = drawer.getByRole('button', { name: '记录进展', exact: true });
    await drawer.getByText('待处理', { exact: true }).waitFor();
    assert(await progress.isDisabled(), '旧债务详情等待新版本时仍可以记录进展');
    assert.deepEqual(writes, [{ type: 'debt.defer', expectedVersion: 1, debtId: id }]);
    releaseDetail();

    await drawer.getByText('已暂缓', { exact: true }).waitFor();
    await progress.click();
    const progressForm = page.getByRole('dialog', { name: '记录进展', exact: true });
    await progressForm.getByLabel('进展说明').fill(note);
    await progressForm.getByRole('button', { name: '保存', exact: true }).click();
    await drawer.getByText(note, { exact: true }).waitFor();
    assert.deepEqual(writes, [
      { type: 'debt.defer', expectedVersion: 1, debtId: id },
      { type: 'debt.progress', expectedVersion: 2, debtId: id },
    ]);
    return { actionsDisabledDuringDetailRefresh: true, progressExpectedVersion: writes[1].expectedVersion };
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure-planning-debt-refresh.png') });
    throw error;
  } finally {
    releaseDetail();
    await context.close();
  }
}
