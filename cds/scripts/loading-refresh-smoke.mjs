import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** 实际页面的合成验收；GET/PUT 均被本机拦截，不保存真实配置、授权或发起部署。 */
export async function verifyLoadingRefresh(browser, base, out) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  let projectGate, relationGate, projectRequested, relationRequested, releaseProject, releaseRelation, centerGate, centerRequested, releaseCenter, centerRequestSeen, failProject = false, failRelation = false;
  let projectCount = 0, relationCount = 0, projectRequestSeen, relationRequestSeen, savedProject;
  let healthGate, releaseHealth, healthRequestSeen, healthCount = 0, healthInterval = 45, failHealth = false;
  let sectionGate, releaseSection, sectionRequestSeen, jobsCount = 0, runsCount = 0, changesCount = 0, sectionVersion = 1, failCenter = false, failRuns = false, activePoll = false, heldCenterRequests = 0;
  const errors = [];
  await context.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
    if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    let payload = resolveFixture(p) ?? {};
    if (p === '/api/auth/status') payload = { enabled: true, authenticated: true, user: { name: '合成验收账号', isSystemOwner: true } };
    if (/\/identity-history$/.test(p)) payload = {records:[],nextCursor:null,coverage:'complete'};
    if (p === '/api/cds-system/connections') payload = { connections: [] };
    if (p === '/api/uptime/summary') {
      healthCount++; healthRequestSeen?.();
      if (healthGate) await healthGate;
      if (failHealth) return route.fulfill({status:500,json:{error:'合成：健康刷新失败'}});
      payload = {enabled:true,intervalSeconds:healthInterval,timeoutMs:5432,failureThreshold:3,targets:[]};
    }
    if (p === '/api/scheduled-jobs') {
      jobsCount++; sectionRequestSeen?.(); if (sectionGate) await sectionGate;
      const target = {type:'release',targetId:'fixture-release-target',source:{kind:'branch',branchId:'fixture-branch-alpha'}};
      payload = {jobs:[
        {id:'fixture-refresh-push',projectId:'fixture-project',name:'合成事件规则',enabled:true,schedule:{type:'push',event:'push',branchPattern:`fixture/${sectionVersion}`},target,timeoutSeconds:60,retryCount:0},
        {id:'fixture-refresh-timer',projectId:'fixture-project',name:`合成定时规则 ${sectionVersion}`,enabled:true,schedule:{type:'interval',intervalMinutes:60},target,timeoutSeconds:60,retryCount:0},
      ]};
    }
    if (p === '/api/scheduled-jobs/runs') {
      runsCount++; sectionRequestSeen?.(); if (sectionGate) await sectionGate;
      if (failRuns) return route.fulfill({status:500,json:{error:'合成：运行记录读取失败'}});
      payload = {runs:[{id:'fixture-refresh-run',jobId:'fixture-refresh-timer',status:'failed',trigger:'manual',queuedAt:'2026-11-04T00:00:00Z',error:`合成运行记录 ${sectionVersion}`} ]};
    }
    if (/\/api\/releases\/targets\/[^/]+\/changes$/.test(p)) {
      changesCount++; sectionRequestSeen?.(); if (sectionGate) await sectionGate;
      payload = {changes:[{id:'fixture-refresh-change',targetId:'fixture-release-target',at:'2026-11-04T00:00:00Z',kind:'updated',reason:`合成配置记录 ${sectionVersion}`,changes:[]}]};
    }
    if (p === '/api/projects/fixture-project') {
      if (route.request().method() === 'PUT') {
        savedProject = {...payload,...route.request().postDataJSON()};
        return route.fulfill({json:{project:savedProject}});
      }
      payload = savedProject ?? payload;
      projectCount++; projectRequestSeen?.();
      if (projectGate) await projectGate;
      if (failProject) return route.fulfill({ status: 400, json: { error: '合成：项目读取失败' } });
    }
    if (p === '/api/releases/center' && activePoll) payload={...payload,rows:payload.rows.map(row=>({...row,latestRun:{releaseId:'fixture-active-run',projectId:'fixture-project',branchId:'fixture-branch-alpha',commitSha:'0'.repeat(40),targetId:row.target.id,status:'running',startedAt:'2026-11-04T00:00:00Z',artifact:{type:'image',commitSha:'0'.repeat(40)},logs:[]}}))};
    if (p === '/api/releases/center' && centerGate) {heldCenterRequests++;centerRequestSeen?.(); await centerGate;}
    if (p === '/api/releases/center' && failCenter) return route.fulfill({status:500,json:{error:'合成：发布中心刷新失败'}});
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
  async function requested(promise) {
    let timer;
    try { await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('manual refresh did not request section data')),15000);})]); }
    finally { clearTimeout(timer); }
  }
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
    await name.fill('  已保存的名称  ');
    await page.locator('form').filter({has:name}).getByRole('button',{name:'保存修改',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('input[maxlength="60"]')?.value==='已保存的名称');
    assert.equal(await name.inputValue(),'已保存的名称');
    holdProject(); await page.getByRole('button', { name: '刷新项目设置', exact: true }).click(); await projectRequested;
    await name.fill('  保存期间的最新名称  ');
    await page.locator('form').filter({has:name}).getByRole('button',{name:'保存修改',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('input[maxlength="60"]')?.value==='保存期间的最新名称');
    releaseProject(); projectGate=null;
    await page.getByRole('button', { name: '刷新项目设置', exact: true }).waitFor();
    assert.equal(await name.inputValue(),'保存期间的最新名称','保存成功后迟到GET不得覆盖结果');
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
    await page.goto(base + '/release-center?project=fixture-project');
    await page.getByRole('button',{name:/^全环境矩阵/}).waitFor();
    centerRequested = new Promise(r=>centerRequestSeen=r); centerGate = new Promise(r=>releaseCenter=r);
    await page.getByRole('button',{name:'刷新',exact:true}).first().click(); await centerRequested;
    assert.equal(await page.locator('[data-release-center-skeleton]').count(),0);
    assert(await page.getByRole('button',{name:/^全环境矩阵/}).isVisible());
    releaseCenter(); centerGate=null;
    await page.getByRole('button',{name:'刷新',exact:true}).first().waitFor({state:'visible'});
    failCenter=true; await page.getByRole('button',{name:'刷新',exact:true}).first().click();
    await page.getByRole('alert').filter({hasText:'合成：发布中心刷新失败'}).waitFor();
    assert(await page.getByText('fixture-release-target',{exact:true}).first().isVisible());
    assert.equal(await page.locator('[data-release-center-skeleton]').count(),0);
    failCenter=false; await page.getByRole('alert').getByRole('button',{name:'重试',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'合成：发布中心刷新失败'}).waitFor({state:'hidden'});
    await page.getByRole('button',{name:/^健康监测/}).click();
    await page.getByText('45 秒',{exact:true}).waitFor();
    const healthRequested = new Promise(resolve=>healthRequestSeen=resolve);
    healthGate = new Promise(resolve=>releaseHealth=resolve); healthInterval=77;
    await page.getByRole('button',{name:'刷新',exact:true}).first().click(); await requested(healthRequested);
    assert(await page.getByText('45 秒',{exact:true}).isVisible());
    assert.equal(await page.getByRole('status',{name:'读取发布健康数据',exact:true}).count(),0);
    releaseHealth(); healthGate=null; await page.getByText('77 秒',{exact:true}).waitFor();
    failHealth=true; await page.getByRole('button',{name:'刷新',exact:true}).first().click();
    await page.getByText(/合成：健康刷新失败/).waitFor(); assert(await page.getByText('77 秒',{exact:true}).isVisible());
    failHealth=false; await page.getByRole('button',{name:'刷新',exact:true}).first().click();
    await page.getByText(/合成：健康刷新失败/).waitFor({state:'hidden'});

    await page.getByRole('button',{name:/^自动发布规则/}).click();
    await page.getByText('合成定时规则 1',{exact:true}).waitFor();
    failRuns=true; await page.locator('summary').filter({hasText:'运行记录'}).click();
    await page.getByRole('alert').filter({hasText:'合成：运行记录读取失败'}).waitFor();
    assert.equal(await page.getByText('还没有运行记录。',{exact:true}).count(),0);
    assert.equal(await page.getByRole('status',{name:'读取规则运行记录',exact:true}).count(),0);
    failRuns=false; await page.getByRole('button',{name:'刷新',exact:true}).first().click();
    await page.getByText(/合成运行记录 1/).waitFor();
    await page.getByRole('button',{name:'新建规则',exact:true}).click();
    const draft = page.getByLabel('分支匹配',{exact:true}); await draft.fill('wip/unsaved');
    const beforeJobs=jobsCount, beforeRuns=runsCount;
    const rulesRequested = new Promise(resolve=>sectionRequestSeen=()=>{if(jobsCount>=beforeJobs+2 && runsCount>=beforeRuns+1)resolve();});
    sectionGate=new Promise(resolve=>releaseSection=resolve); sectionVersion=2;
    await page.getByRole('button',{name:'刷新',exact:true}).first().click(); await requested(rulesRequested);
    assert(await page.getByText('合成定时规则 1',{exact:true}).isVisible());
    assert(await page.getByText(/合成运行记录 1/).isVisible());
    assert.equal(await draft.inputValue(),'wip/unsaved'); await draft.focus();
    releaseSection(); sectionGate=null; await page.getByText('合成定时规则 2',{exact:true}).waitFor(); await page.getByText(/合成运行记录 2/).waitFor();
    assert.equal(await draft.inputValue(),'wip/unsaved'); assert(await draft.evaluate(e=>e===document.activeElement));

    await page.getByRole('button',{name:/^证据归档/}).click();
    await page.getByText(/合成配置记录 2/).waitFor();
    const beforeChanges=changesCount;
    const changesRequested = new Promise(resolve=>sectionRequestSeen=()=>{if(changesCount>beforeChanges)resolve();});
    sectionGate=new Promise(resolve=>releaseSection=resolve); sectionVersion=3;
    await page.getByRole('button',{name:'刷新',exact:true}).first().click(); await requested(changesRequested);
    assert(await page.getByText(/合成配置记录 2/).isVisible());
    assert.equal(await page.getByRole('status',{name:'读取变更历史',exact:true}).count(),0);
    releaseSection(); sectionGate=null; await page.getByText(/合成配置记录 3/).waitFor();
    // 模拟一个永不返回的静默轮询，手动刷新仍须可用且能取代它。
    await page.clock.install(); activePoll=true;
    await Promise.all([page.waitForResponse(r=>r.url().includes('/api/releases/center')),page.getByRole('button',{name:'刷新',exact:true}).first().click()]);
    await page.getByRole('button',{name:'刷新',exact:true}).first().waitFor();
    centerRequested=new Promise(r=>centerRequestSeen=r); centerGate=new Promise(r=>releaseCenter=r);
    await page.clock.runFor(12_001); await requested(centerRequested);
    const centerRefresh=page.getByRole('button',{name:'刷新',exact:true}).first();
    assert(await centerRefresh.isEnabled(),'静默请求不能禁用手动刷新');
    const heldBefore=heldCenterRequests;
    const manualRequested=new Promise(r=>centerRequestSeen=r);
    await centerRefresh.click(); await requested(manualRequested);
    assert(heldCenterRequests>heldBefore,'手动刷新必须取代卡住的静默请求');
    releaseCenter();centerGate=null;activePoll=false;
    await page.waitForFunction(()=>!document.querySelector('button[title="刷新"][disabled]'));
    assert.deepEqual(errors, []);
    return { saveInvalidatesOlderRefresh: true, hungSilentPollCanBeReplaced: true, projectRefreshKeepsContent: true, unsavedInputAndFocusPreserved: true, savedNormalizationApplied: true, releaseCenterRefreshKeepsContent: true, releaseCenterRefreshFailureRetainsContent: true, releaseCenterHealthRefreshes: true, healthRefreshFailureRetainsContent: true, releaseRulesAndOpenRunsRefresh: true, releaseRuleDraftAndFocusPreserved: true, releaseEvidenceRefreshes: true, refreshFailureRetainsContent: true, retry: true, navigateAwayReopen: true, relationRefreshKeepsGraph: true, projectCount, relationCount, healthCount, jobsCount, runsCount, changesCount, errors };
  } catch(e) {
    await page.screenshot({path:path.join(out,'failure-refresh.jpg')});
    await fs.writeFile(path.join(out,'failure-refresh.html'),await page.content());
    throw e;
  } finally { releaseProject?.(); releaseRelation?.(); releaseCenter?.(); releaseHealth?.(); releaseSection?.(); await context.close(); }
}
