import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** 只在本机用合成 GET 验收；页面刷新不应调用任何保存、探测或部署接口。 */
export async function verifySettingsRefresh(browser, base, out) {
  const context = await browser.newContext({viewport:{width:1440,height:940}});
  const counts = new Map(), errors = [], writes = [];
  let release, gate, failed = '', heldPath = '', version = 1;
  const project = '/api/projects/fixture-project';
  const fixtures = {
    [`${project}/identity-history`]: () => ({records:[],nextCursor:null,coverage:'complete'}),
    [`${project}/recent-auto-deploys`]: () => ({items:[]}),
    [`${project}/compose`]: () => ({yaml:`services: {} # ${version}`,version,hasPersisted:true,authority:[]}),
    [`${project}/storage`]: () => ({volumes:[],totalBytes:version,totalHuman:`合成存储 ${version} B`}),
    [`${project}/backup-health`]: () => ({verdict:{tone:'ok',headline:`合成备份 ${version}`,subline:null},targets:[],files:{count:0,bytes:0},directory:'/fixture',directoryExists:true,findings:[]}),
    [`${project}/migration/peers`]: () => ({peers:[]}),
    [`${project}/migration/config-preview`]: () => ({yaml:'services: {}',bytes:12,summary:{profiles:0,infra:0,envVars:0,routingRules:0}}),
    [`${project}/delivery`]: () => ({projectId:'fixture-project',mode:'compose',managedSpec:{apps:[],capabilities:[]},effectiveProfiles:[]}),
    [`${project}/db-isolation`]: () => ({projectId:'fixture-project',readOnly:false,services:[],branchOverrides:[],branches:[],summary:{services:0,shared:0,perBranch:0,branches:0,branchesWithOverride:0}}),
    [`${project}/db-ledger`]: () => ({projectId:'fixture-project',entries:[],tree:[],summary:{total:0,active:0,orphaned:0,dropped:0,unknown:0,withVerifiedBackup:0,withoutBackup:0}}),
    [`${project}/activity-logs`]: () => ({logs:[]}),
    '/api/cache/status': () => ({cacheBase:'/fixture',projectSlug:'fixture',caches:[],orphans:[],totalBytes:0,totalBytesHuman:'0 B',warnings:[]}),
    '/api/comment-template': () => ({body:`fixture template ${version}`,defaultBody:'default',variables:[],isDefault:false}),
  };
  await context.route('**/api/**',async route=>{
    const p = new URL(route.request().url()).pathname.replace(/^\/_cds/,'');
    if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    if (route.request().method() !== 'GET') writes.push(`${route.request().method()} ${p}`);
    counts.set(p,(counts.get(p)||0)+1);
    if (gate && p !== '/api/auth/status' && (!heldPath || p === heldPath)) await gate;
    if (p === failed) return route.fulfill({status:500,json:{error:'合成子页读取失败'}});
    let payload = fixtures[p]?.() ?? resolveFixture(p) ?? {};
    if(p===project) payload={...payload,githubRepoFullName:'fixture/repo'};
    if(p==='/api/auth/status') payload={enabled:true,authenticated:true,user:{name:'合成验收',isSystemOwner:true}};
    await route.fulfill({json:payload});
  });
  const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  const results=[];
  const refresh = () => page.getByRole('button',{name:'刷新项目设置',exact:true});
  async function done(){await refresh().waitFor();}
  async function countAtLeast(p,n){await page.waitForFunction(()=>true);for(let i=0;i<100;i++){if((counts.get(p)||0)>=n)return;await new Promise(r=>setTimeout(r,30));}throw new Error(`未重取 ${p}`);}
  const cases=[
    ['general',[`${project}/identity-history`,`${project}/recent-auto-deploys`]],
    ['github',['/api/github/app']],['env',['/api/env']],['runtime-defaults',['/api/build-profiles']],
    ['comment-template',['/api/comment-template']],['delivery',[`${project}/delivery`]],
    ['compose',[`${project}/compose`]],['db-isolation',[`${project}/db-isolation`,`${project}/db-ledger`]],
    ['infra',['/api/infra']],['storage',[`${project}/storage`]],['backup',[`${project}/backup-health`]],
    ['migration',[`${project}/migration/peers`,`${project}/migration/config-preview`]],
    ['cache',['/api/cache/status']],['stats',['/api/branches']],['activity',[`${project}/activity-logs`]],
  ];
  try {
    for(const [tab,reads] of cases){
      await page.goto(`${base}/settings/fixture-project#${tab}`);
      for(const p of reads) await countAtLeast(p,1);
      await page.locator('[role="tabpanel"][data-state="active"]').waitFor();
      await page.getByRole('status',{name:/^加载项目设置$/}).waitFor({state:'hidden'});
      // Initial read must settle before taking baseline counts.
      await page.waitForTimeout(150);
      const before=reads.map(p=>counts.get(p)||0);
      let draft;
      if(['compose','comment-template','delivery'].includes(tab)){
        draft=page.locator('[role="tabpanel"][data-state="active"] textarea').first();
        if(await draft.count()) await draft.fill('unsaved fixture draft'); else draft=null;
      }
      gate=new Promise(r=>release=r);
      await refresh().click();
      for(let i=0;i<reads.length;i++)await countAtLeast(reads[i],before[i]+1);
      assert.equal(await page.locator('[data-settings-page-skeleton]').count(),0,tab);
      if(draft){assert.equal(await draft.inputValue(),'unsaved fixture draft');await draft.focus();}
      release();gate=null;await done();
      if(draft){assert.equal(await draft.inputValue(),'unsaved fixture draft');assert(await draft.evaluate(e=>e===document.activeElement));}
      results.push({tab,reads,refreshes:true,draftPreserved:!!draft});
    }
    // 首载尚未返回时点击刷新，替代请求失败不能把局部面板留在永久骨架。
    for(const [tab,pendingPath] of [['env','/api/env'],['github','/api/github/app']]) {
      heldPath=pendingPath; failed=pendingPath; gate=new Promise(r=>release=r);
      const before=counts.get(pendingPath)||0;
      await page.goto(`${base}/settings/fixture-project#${tab}`);
      await countAtLeast(pendingPath,before+1); await refresh().waitFor();
      await refresh().click(); await countAtLeast(pendingPath,before+2);
      release();gate=null;await done();
      await page.locator('[role="tabpanel"][data-state="active"]').getByText(/合成子页读取失败/).waitFor();
      assert.equal(await page.locator('[role="tabpanel"][data-state="active"] .cds-loading-skeleton-line').count(),0,tab);
      failed='';heldPath='';await refresh().click();await done();
    }
    await page.goto(`${base}/settings/fixture-project#db-isolation`);
    await page.getByText('这个项目还没有服务配置，先在「项目配置」里接入服务',{exact:true}).waitFor();
    const isolationReads=counts.get(`${project}/db-isolation`)||0;
    failed=`${project}/db-isolation`;await refresh().click();await done();
    await countAtLeast(failed,isolationReads+1);
    await page.getByRole('alert').filter({hasText:'合成子页读取失败'}).waitFor();
    assert.equal(await page.getByRole('status',{name:'正在读取数据库隔离配置',exact:true}).count(),0);
    failed='';await refresh().click();await done();
    await page.getByRole('alert').filter({hasText:'合成子页读取失败'}).waitFor({state:'hidden'});
    // Same-data refresh failure keeps a loaded panel and the next refresh recovers.
    await page.goto(`${base}/settings/fixture-project#storage`);
    await page.getByText('合成存储 1 B',{exact:true}).waitFor();
    failed=`${project}/storage`;await refresh().click();await done();
    assert(await page.getByText('合成存储 1 B',{exact:true}).isVisible());
    failed='';version=2;await refresh().click();await done();await page.getByText('合成存储 2 B',{exact:true}).waitFor();
    // First failure exits skeleton, with a real local retry.
    failed=`${project}/compose`;await page.goto(`${base}/settings/fixture-project#compose`);
    await page.getByRole('button',{name:'重试',exact:true}).waitFor();
    assert.equal(await page.getByRole('status',{name:'加载 Compose 配置…',exact:true}).count(),0);
    failed='';await page.getByRole('button',{name:'重试',exact:true}).click();await page.locator('textarea').first().waitFor();
    await page.screenshot({path:path.join(out,'project-settings-refresh-ready.jpg')});
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    return {tabs:results,isolationRefreshErrorVisibleAndRetry:true,firstLoadReplacementFailureExitsSkeleton:true,backgroundFailureKeepsData:true,retry:true,firstFailureExitsSkeleton:true,errors,writes};
  }catch(e){await page.screenshot({path:path.join(out,'project-settings-refresh-failure.jpg')});await fs.writeFile(path.join(out,'project-settings-refresh-failure.html'),await page.content());throw e;}
  finally{release?.();await context.close();}
}
