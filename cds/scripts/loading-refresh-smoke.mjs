import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** 实际页面读接口的合成验收；从不保存表单、授权或发起部署。 */
export async function verifyLoadingRefresh(browser, base, out) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  let projectGate, relationGate, projectRequested, relationRequested, releaseProject, releaseRelation, failProject = false, failRelation = false;
  let projectCount = 0, relationCount = 0, projectRequestSeen, relationRequestSeen;
  const errors = [];
  await context.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
    if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    let payload = resolveFixture(p) ?? {};
    if (p === '/api/auth/status') payload = { enabled: true, authenticated: true, user: { name: '合成验收账号', isSystemOwner: true } };
    if (/\/identity-history$/.test(p)) payload = {records:[],nextCursor:null,coverage:'complete'};
    if (p === '/api/cds-system/connections') payload = { connections: [] };
    if (p === '/api/projects/fixture-project') {
      projectCount++; projectRequestSeen?.();
      if (projectGate) await projectGate;
      if (failProject) return route.fulfill({ status: 400, json: { error: '合成：项目读取失败' } });
    }
    if (p.endsWith('/service-graph')) {
      relationCount++; relationRequestSeen?.();
      if (relationGate) await relationGate;
      if (failRelation) return route.fulfill({ status: 400, json: { error: '合成：关系读取失败' } });
    }
    try { await route.fulfill({ json: payload }); } catch (e) { if (!/closed|handled|canceled/i.test(String(e))) throw e; }
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  function holdProject() { projectRequested = new Promise(r => projectRequestSeen = r); projectGate = new Promise(r => releaseProject = r); }
  function holdRelation() { relationRequested = new Promise(r => relationRequestSeen = r); relationGate = new Promise(r => releaseRelation = r); }
  try {
    await page.goto(base + '/settings/fixture-project');
    const name = page.getByLabel('项目名称', { exact: true }); await name.waitFor();
    await name.fill('尚未保存的名称');
    holdProject(); await page.getByRole('button', { name: '刷新项目设置', exact: true }).click(); await projectRequested;
    assert.equal(await page.locator('[data-settings-page-skeleton]').count(), 0);
    await name.focus(); assert.equal(await name.inputValue(), '尚未保存的名称');
    releaseProject(); await page.getByRole('button', { name: '刷新项目设置', exact: true }).waitFor();
    assert.equal(await name.inputValue(), '尚未保存的名称'); assert(await name.evaluate(e => e === document.activeElement));
    projectGate = null; failProject = true;
    await page.getByRole('button', { name: '刷新项目设置', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成：项目读取失败' }).waitFor();
    assert.equal(await name.inputValue(), '尚未保存的名称');
    failProject = false; await page.getByRole('button', { name: '刷新项目设置', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成：项目读取失败' }).waitFor({ state: 'hidden' });
    // 当前请求未完成就离开，随后再返回：旧响应不得覆盖新挂载的内容。
    holdProject(); await page.getByRole('button', { name: '刷新项目设置', exact: true }).click(); await projectRequested;
    await page.getByRole('link', { name: '项目列表', exact: true }).click(); await name.waitFor({state:'hidden'}); releaseProject(); projectGate = null;
    await page.goBack(); await name.waitFor(); assert.notEqual(await name.inputValue(), '尚未保存的名称');
    await page.screenshot({ path: path.join(out, 'project-refresh-ready.jpg') });
    await page.goto(base + '/branch-relations/fixture-branch-alpha');
    await page.locator('[data-testid="relation-workspace"]').waitFor();
    holdRelation(); await page.getByRole('button', { name: '刷新', exact: true }).click(); await relationRequested;
    assert.equal(await page.locator('[data-content-loading="panel"]').count(), 0);
    assert(await page.locator('[data-testid="relation-workspace"]').isVisible());
    releaseRelation(); await page.getByRole('button', { name: '刷新', exact: true }).waitFor({ state: 'visible' }); relationGate = null;
    await page.waitForFunction(() => !document.querySelector('button[disabled]'));
    failRelation = true; await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成：关系读取失败' }).waitFor();
    assert(await page.locator('[data-testid="relation-workspace"]').isVisible());
    failRelation = false; await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成：关系读取失败' }).waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    return { projectRefreshKeepsContent: true, unsavedInputAndFocusPreserved: true, refreshFailureRetainsContent: true, retry: true, navigateAwayReopen: true, relationRefreshKeepsGraph: true, projectCount, relationCount, errors };
  } finally { releaseProject?.(); releaseRelation?.(); await context.close(); }
}
