import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** All writes terminate in this deterministic fixture; never run with un-intercepted APIs. */
export async function verifySettingsWorkflow(browser, base, out, { baseline = false } = {}) {
  await fs.mkdir(out, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  const pages = [], results = [], writes = [], errors = [];
  let template = '## Preview {{pr_number}}\n{{preview_url}}', templateGate, releaseTemplate, previewGate, releasePreview;
  let templateReadOverride;
  let env = { FIXTURE_SAMPLE_KEY: '合成值', FIXTURE_SECOND: '第二条合成值' }, failEnvRead = false, rejectTemplate = false, unknownTemplate = false;
  const vars = Array.from({length:9},(_,i)=>({key:`variable_${i}`,label:`示例变量 ${i}`,example:`合成示例 ${i}`}));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const p = url.pathname.replace(/^\/_cds/, ''), method = request.method();
    if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': deterministic fixture\n\n' });
    if (method !== 'GET') writes.push({method,path:p});
    if (p === '/api/auth/status') return route.fulfill({json:{authenticated:true,enabled:true,user:{id:'fixture-owner',authProvider:'local',username:'fixture-owner',isSystemOwner:true}}});
    if (p === '/api/comment-template' && method === 'GET') return route.fulfill({ json: { body: templateReadOverride ?? template, defaultBody: '默认模板 {{preview_url}}', isDefault: !(templateReadOverride ?? template), updatedAt: null, variables: vars } });
    if (/\/comment-template$/.test(p) && method === 'PUT') {
      const body = request.postDataJSON().body;
      if (templateGate) await templateGate;
      if (rejectTemplate) return route.fulfill({status:400,json:{error:'合成校验拒绝'}});
      template = body.slice(0,16*1024);
      if (unknownTemplate) return route.fulfill({status:500,json:{error:'合成响应中断，写入结果未确认'}});
      return route.fulfill({json:{ok:true,body:template,updatedAt:'2026-11-15T00:00:00Z'}});
    }
    if (p === '/api/comment-template/preview') {
      const body = request.postDataJSON().body;
      if (previewGate) await previewGate;
      return route.fulfill({json:{ok:true,rendered:`合成预览：${body}`}});
    }
    if (p === '/api/env' && method === 'GET') return route.fulfill(failEnvRead ? {status:500,json:{error:'合成读取失败'}} : {json:{env}});
    if (p.startsWith('/api/env/') && method === 'PUT') { env[decodeURIComponent(p.slice('/api/env/'.length))] = request.postDataJSON().value; return route.fulfill({json:{ok:true}}); }
    if (/\/compose$/.test(p)) return route.fulfill({json:{yaml:'services:\n  web:\n    build: .\nx-cds-routing:\n  rules: []\n',authority:[],version:1,hasPersisted:true}});
    if (method !== 'GET') throw new Error(`Unplanned fixture write ${method} ${p}`);
    const payload = resolveFixture(p);
    return route.fulfill({json: payload ?? {}});
  });
  const page = await context.newPage(); pages.push(page); page.on('pageerror', err => errors.push(err.message));
  async function open(route) { await page.goto(`${base}${route}`); await page.locator('[role="tabpanel"][data-state="active"]').waitFor(); }
  async function metrics(selector) {
    return page.locator(selector).first().evaluate(element => {
      const r=element.getBoundingClientRect(); let scroller=element.parentElement;
      while(scroller && scroller.scrollHeight<=scroller.clientHeight) scroller=scroller.parentElement;
      return { top:r.top, bottom:r.bottom, height:r.height, viewport:innerHeight, scroll:scroller?.scrollTop||0, documentOverflow:document.documentElement.scrollWidth>innerWidth };
    });
  }
  try {
    await open('/settings/fixture-project#comment-template');
    const editor = page.locator('[role="tabpanel"][data-state="active"] textarea').first(); await editor.waitFor();
    results.push({case:'template-initial-custom', source:'deterministic-fixture', editor:await metrics('[role="tabpanel"][data-state="active"] textarea'), preview:await metrics(baseline ? '[role="tabpanel"] section:last-child' : '[aria-labelledby="comment-preview-title"]')});
    await page.screenshot({path:path.join(out,'template-desktop.png')});
    if(!baseline){const count=writes.filter(write=>write.method==='PUT').length;await editor.fill('x'.repeat(17000));await page.getByRole('alert').filter({hasText:'超过上限 16384'}).waitFor();assert.equal((await editor.inputValue()).length,17000);assert(await page.getByRole('button',{name:'保存模板',exact:true}).isDisabled());assert.equal(writes.filter(write=>write.method==='PUT').length,count);results.push({case:'over-limit-body-retained-and-zero-put-before-server-slice',pass:true});await editor.fill('## Preview {{pr_number}}\n{{preview_url}}');}
    for (const theme of ['dark','light']) for (const width of [1440,390]) {
      await page.setViewportSize({width,height:940});
      await page.evaluate(theme=>{document.documentElement.setAttribute('data-theme',theme);document.documentElement.classList.toggle('dark',theme==='dark');localStorage.setItem('cds-theme',theme);},theme);
      await page.screenshot({path:path.join(out,`template-initial-${theme}-${width}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`template initial ${theme}/${width} overflow`);
    }
    await page.setViewportSize({width:1440,height:940});
    previewGate=new Promise(resolve=>releasePreview=resolve);
    await editor.fill('草稿A {{unknown_variable}}');
    await page.getByRole('button',{name:baseline?'预览':'生成预览',exact:true}).click();
    await editor.fill('草稿B {{unknown_variable}}'); releasePreview();previewGate=null;
    await page.getByText('合成预览：草稿A {{unknown_variable}}',{exact:true}).waitFor();
    const previewPreservesNewDraft=(await editor.inputValue())==='草稿B {{unknown_variable}}';
    results.push({case:'late-preview-preserves-new-draft',pass:previewPreservesNewDraft});
    if (!baseline) {
      assert(previewPreservesNewDraft,'迟到预览不得覆盖新草稿');
      await page.getByText('草稿已变化，下方仍是上次预览。',{exact:true}).waitFor();
      await page.getByRole('radio',{name:'使用默认模板',exact:true}).check();
      await page.getByRole('radio',{name:'自定义模板',exact:true}).check();
      assert.equal(await editor.inputValue(),'草稿B {{unknown_variable}}');
      templateGate=new Promise(resolve=>releaseTemplate=resolve);
      await page.getByRole('button',{name:'保存模板',exact:true}).click();
      await editor.fill('保存进行中继续编辑'); releaseTemplate();templateGate=null;
      await page.getByRole('button',{name:'保存模板',exact:true}).waitFor();
      await page.getByText('有未保存修改',{exact:false}).waitFor();
      assert.equal(await editor.inputValue(),'保存进行中继续编辑');
      rejectTemplate=true; await page.getByRole('button',{name:'保存模板',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'保存被拒绝'}).waitFor();
      assert.equal(await editor.inputValue(),'保存进行中继续编辑'); rejectTemplate=false;
      results.push({case:'mode-toggle-late-save-rejection-keeps-draft',pass:true});
      await page.getByRole('tab',{name:'项目环境变量',exact:true}).click();
      await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor();
      await page.getByRole('tab',{name:'评论模板',exact:true}).click();
      await page.getByText('已恢复未保存草稿',{exact:false}).waitFor();
      assert.equal(await editor.inputValue(),'保存进行中继续编辑');
      results.push({case:'tab-navigation-restores-project-draft',pass:true});
      templateReadOverride=template;unknownTemplate=true;
      await page.getByRole('button',{name:'保存模板',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();
      assert(await page.getByRole('button',{name:'保存模板',exact:true}).isDisabled());
      await editor.fill('未知结果后继续编辑');
      await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();
      unknownTemplate=false;
      await page.getByRole('button',{name:'重新读取并核对',exact:true}).click();await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();assert(await page.getByRole('button',{name:'保存模板',exact:true}).isDisabled());await page.getByRole('tab',{name:'项目环境变量',exact:true}).click();await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor();await page.getByRole('tab',{name:'评论模板',exact:true}).click();await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();assert(await page.getByRole('button',{name:'保存模板',exact:true}).isDisabled());assert.equal(await editor.inputValue(),'未知结果后继续编辑');templateReadOverride=undefined;await page.getByRole('button',{name:'重新读取并核对',exact:true}).click();results.push({case:'template-old-get-and-real-tabs-do-not-resolve-submitted-snapshot',pass:true});
      await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor({state:'hidden'});
      assert.equal(await editor.inputValue(),'未知结果后继续编辑');
      results.push({case:'unknown-save-requires-readback-and-keeps-new-draft',pass:true});
      previewGate=new Promise(resolve=>releasePreview=resolve);
      const requestSeen=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/comment-template/preview'));
      await page.getByRole('button',{name:'更新预览',exact:true}).click(); await requestSeen;
      await page.getByRole('tab',{name:'项目环境变量',exact:true}).click();
      await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor();
      await page.getByRole('tab',{name:'评论模板',exact:true}).click();
      await page.getByText('已恢复未保存草稿',{exact:false}).waitFor();
      releasePreview(); previewGate=null;
      await page.waitForTimeout(100);
      assert.equal(await editor.inputValue(),'未知结果后继续编辑');
      assert.equal(await page.getByText('合成预览：未知结果后继续编辑',{exact:true}).count(),0);
      results.push({case:'unmounted-preview-cannot-update-returned-session',pass:true});
    }
    if(!baseline){await editor.fill(Array.from({length:120},(_,i)=>`长模板第${i}行 {{unknown_variable_${i}}}`).join('\n'));results.push({case:'long-template-retains-full-editable-content',pass:(await editor.inputValue()).includes('unknown_variable_119')});}
    for (const theme of ['dark','light']) for (const width of [1440,390]) {
      await page.setViewportSize({width,height:940});
      await page.evaluate(theme=>{document.documentElement.setAttribute('data-theme',theme);document.documentElement.classList.toggle('dark',theme==='dark');localStorage.setItem('cds-theme',theme);},theme);
      await page.screenshot({path:path.join(out,`template-${theme}-${width}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`template ${theme}/${width} overflow`);
    }
    await page.setViewportSize({width:1440,height:940});
    await page.getByText('当前项目的评论模板设置已保存',{exact:true}).waitFor({state:'hidden'});
    await open('/settings/fixture-project#env'); await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor();
    results.push({case:'project-env-two-rows',firstData:await metrics('div.font-mono.font-semibold'),source:'deterministic-fixture'});
    await page.screenshot({path:path.join(out,'project-env-desktop.png')});
    const sampleMasked = await page.locator('code').filter({hasText:'••••••••'}).count() > 0;
    results.push({case:'short-secret-is-masked',pass:sampleMasked});
    if (!baseline) {
      assert(sampleMasked,'短敏感值必须遮盖');
      env={PRIVATE_CONFIG:'abc',SERVICE_CREDENTIAL:'x',PUBLIC_LABEL:'可见'};
      await page.reload();
      const privateRow=page.locator('[data-env-key="PRIVATE_CONFIG"]'), credentialRow=page.locator('[data-env-key="SERVICE_CREDENTIAL"]');
      await privateRow.getByText('敏感值已遮盖',{exact:true}).waitFor();
      assert.equal(await privateRow.locator('code').innerText(),'••••••••');
      assert.equal(await credentialRow.locator('code').innerText(),'••••••••');
      await privateRow.getByRole('button',{name:'显示 PRIVATE_CONFIG',exact:true}).click();
      await privateRow.getByText('敏感值已显示',{exact:true}).waitFor();
      assert.equal(await privateRow.locator('code').innerText(),'abc');
      await privateRow.getByRole('button',{name:'隐藏 PRIVATE_CONFIG',exact:true}).click();
      await credentialRow.getByRole('button',{name:'编辑 SERVICE_CREDENTIAL',exact:true}).click();
      await credentialRow.getByText('正在编辑明文',{exact:true}).waitFor();
      assert.equal(await credentialRow.getByRole('textbox').inputValue(),'x');
      await credentialRow.getByRole('button',{name:'取消编辑 SERVICE_CREDENTIAL',exact:true}).click();
      results.push({case:'private-credential-visible-edit-states-are-truthful',pass:true});
      for(const theme of ['dark','light']) {
        await page.setViewportSize({width:390,height:940});
        await page.evaluate(theme=>{document.documentElement.setAttribute('data-theme',theme);document.documentElement.classList.toggle('dark',theme==='dark');},theme);
        await page.screenshot({path:path.join(out,`env-${theme}-390.png`)});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`env ${theme} overflow`);
        for(const label of ['显示 PRIVATE_CONFIG','复制 PRIVATE_CONFIG','编辑 PRIVATE_CONFIG','删除 PRIVATE_CONFIG']){const box=await privateRow.getByRole('button',{name:label,exact:true}).boundingBox();assert(box.x>=0&&box.x+box.width<=390&&box.height>=40&&box.width>=40,`变量动作${label}缺可见热区`);}
        results.push({case:`env-${theme}-390-core-actions-visible-touch-targets`,pass:true});
      }
      env={};await page.reload();await page.getByText('当前项目没有独有环境变量。添加后重新部署分支即可生效。',{exact:true}).waitFor();assert.equal(await page.locator('[data-env-key]').count(),0);assert(await page.getByRole('button',{name:'新增变量',exact:true}).isVisible());results.push({case:'project-env-empty-has-main-action-without-empty-table',pass:true});
      env=Object.fromEntries(Array.from({length:80},(_,i)=>[`FIXTURE_VARIABLE_${String(i).padStart(2,'0')}`,`合成长值${i}`]));await page.reload();await page.locator('[data-env-key="FIXTURE_VARIABLE_79"]').waitFor();await page.getByRole('textbox',{name:'搜索变量',exact:true}).fill('FIXTURE_VARIABLE_79');assert.equal(await page.locator('[data-env-key]').count(),1);const manyRow=page.locator('[data-env-key="FIXTURE_VARIABLE_79"]');await manyRow.getByRole('button',{name:'编辑 FIXTURE_VARIABLE_79',exact:true}).click();assert.equal(await manyRow.getByRole('textbox').inputValue(),'合成长值79');await manyRow.getByRole('button',{name:'取消编辑 FIXTURE_VARIABLE_79',exact:true}).click();await page.screenshot({path:path.join(out,'env-many-target-390.png')});results.push({case:'project-env-many-search-locate-edit-cancel',pass:true});
      await page.setViewportSize({width:1440,height:940});
      env={FIXTURE_SAMPLE_KEY:'合成值',FIXTURE_SECOND:'第二条合成值'}; await page.reload();
      await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor();
    }

    if (!baseline) {
      assert.equal(await page.getByRole('textbox',{name:'变量名',exact:true}).count(),0,'新增面板默认不挤占列表');
      await page.getByRole('button',{name:'新增变量',exact:true}).click();
      await page.getByRole('textbox',{name:'变量名',exact:true}).fill('FIXTURE_NEW');
      await page.getByRole('textbox',{name:'变量值',exact:true}).fill('合成新增');
      failEnvRead=true; await page.getByRole('button',{name:'添加',exact:true}).click();
      await page.getByText('配置已写入，列表刷新失败。请刷新核对，勿重复提交。',{exact:true}).waitFor();
      await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor(); failEnvRead=false;
      results.push({case:'write-success-read-failure-is-distinct',pass:true});
      await open('/settings/fixture-project?tab=build&fromBranch=fixture-branch-alpha');
      await page.getByRole('textbox',{name:'项目配置 YAML',exact:true}).waitFor();
      assert.equal(await page.getByRole('link',{name:'返回分支',exact:true}).getAttribute('href'),'/branches/fixture-project?branch=fixture-branch-alpha&branchTab=config&configSection=settings');
      assert.equal(await page.getByRole('textbox',{name:'项目配置 YAML'}).evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'services:');
      results.push({case:'legacy-build-target-and-return-context',pass:true});
    }
    env = { FIXTURE_SAMPLE_KEY: '合成值', FIXTURE_SECOND: '第二条合成值' };
    await open('/cds-settings#global-vars'); await page.getByText('FIXTURE_SAMPLE_KEY',{exact:true}).waitFor();
    results.push({case:'global-env-two-rows',firstData:await metrics('div.font-mono.font-semibold'),source:'deterministic-fixture'});
    await page.screenshot({path:path.join(out,'global-env-desktop.png')});
    if (!baseline) {
      await page.getByText('将全局中的项目变量整理到项目',{exact:true}).click();
      assert.equal(await page.getByRole('combobox',{name:'整理目标项目'}).inputValue(),'');
      assert.equal(await page.getByRole('button',{name:'预览整理方案',exact:true}).isDisabled(),true);
      results.push({case:'migration-requires-explicit-project',pass:true});
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify({provenance:'deterministic-fixture',baseline,results,writes,errors},null,2));
    return results;
  } finally { releaseTemplate?.();releasePreview?.(); await context.close(); }
}
