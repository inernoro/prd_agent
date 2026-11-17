import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveFixture,isEventStream} from './fixtures/mobile-layout-fixtures.mjs';

/** Synthetic configuration writes only; no deployment/model/GitHub request leaves the fixture. */
export async function verifyDeliveryWorkflow(browser,base,out,{baseline=false}={}){
  await fs.mkdir(out,{recursive:true});const context=await browser.newContext({viewport:{width:1440,height:940}});
  let mode='compose',spec={apps:[],capabilities:[]},failGeneration=false,unknownSave=false,oldContract=false;
  const writes=[],results=[],errors=[];
  const source=[{id:'fixture-branch-alpha',branch:'main'},{id:'fixture-branch-beta',branch:'feature/example'}];
  await context.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),p=url.pathname.replace(/^\/_cds/,''),method=request.method();
    if(isEventStream(p)||p==='/api/activity-stream')return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    if(p==='/api/client-events')return route.fulfill({json:{ok:true}});
    if(p.endsWith('/delivery')&&method==='GET'){
      const branch=source.find(b=>b.id===url.searchParams.get('branchId'));
      if(oldContract)return route.fulfill({json:{projectId:'fixture-project',mode,managedSpec:spec,effectiveProfiles:[]}});
      return route.fulfill({json:{projectId:'fixture-project',mode,managedSpec:spec,effectiveProfiles:[],revision:branch?`project-v1/${branch.id}`:'project-v1',projectRevision:'project-v1',planBranches:source,generationSource:branch?{...branch,branchId:branch.id,commitSha:'1234567890abcdef1234567890abcdef12345678'}:null}});
    }
    if(p.endsWith('/delivery')&&method==='PUT'){
      const body=request.postDataJSON();writes.push({method,path:p,body});
      if(failGeneration)return route.fulfill({status:422,json:{error:'配置生成失败，原配置保持不变',message:'合成应用目录不存在'}});
      mode=body.mode;spec=body.managedSpec||{apps:[],capabilities:[]};
      if(unknownSave)return route.fulfill({status:500,json:{error:'合成写入结果未确认'}});
      return route.fulfill({json:{projectId:'fixture-project',mode,managedSpec:spec,plan:mode==='managed'?{profiles:[],generatedAt:'2026-11-15T00:00:00Z'}:null}});
    }
    if(p.endsWith('/managed-plan')){writes.push({method,path:p});return route.fulfill({json:{plan:{profiles:[]}}});}
    if(method!=='GET')throw Error(`Unexpected fixture write ${method} ${p}`);
    return route.fulfill({json:resolveFixture(p)??{}});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`${base}/settings/fixture-project#delivery`);await page.locator('[role="tabpanel"][data-state="active"]').waitFor();
    if(baseline){
      const requestSeen=page.waitForRequest(r=>r.method()==='PUT'&&new URL(r.url()).pathname.endsWith('/delivery'));
      await page.getByRole('button',{name:/^托管模式/}).click();await requestSeen;
      results.push({case:'select-mode-does-not-save',pass:writes.length===0,observedWrites:writes.length});
    }else{
      await page.getByRole('radio',{name:/^托管模式/}).check();await page.getByRole('textbox',{name:'托管应用声明'}).waitFor();
      assert.equal(writes.length,0);results.push({case:'select-mode-does-not-save',pass:true});
      const save=page.getByRole('button',{name:'保存并生成项目配置',exact:true});assert(await save.isDisabled());
      await page.getByRole('combobox',{name:'生成依据分支'}).selectOption('fixture-branch-alpha');
      await page.getByText('1234567890ab',{exact:true}).waitFor();assert(await save.isEnabled());
      failGeneration=true;await save.click();await page.getByRole('alert').filter({hasText:'合成应用目录不存在'}).waitFor();
      assert.equal(mode,'compose');assert.equal(writes.length,1);assert.equal(writes[0].body.generatePlan,true);assert.equal(writes[0].body.branchId,'fixture-branch-alpha');
      results.push({case:'explicit-source-generation-failure-preserves-old-mode',pass:true});
      failGeneration=false;unknownSave=true;await save.click();await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();
      assert(await save.isDisabled());assert.equal(writes.length,2);
      await page.getByRole('button',{name:'重新读取并核对',exact:true}).click();await page.getByText('上次读取的已保存模式：托管',{exact:true}).waitFor();
      assert.equal(writes.length,2);assert.equal(writes.filter(write=>write.path.endsWith('/managed-plan')).length,0);
      results.push({case:'unknown-result-readback-without-legacy-fallback-or-retry',pass:true});
      await page.screenshot({path:path.join(out,'delivery-desktop.png')});
      for(const theme of ['dark','light']){await page.setViewportSize({width:390,height:940});await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');},theme);await page.screenshot({path:path.join(out,`delivery-${theme}-390.png`)});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
      await page.goto(`${base}/settings/fixture-project?fromBranch=fixture-branch-beta#delivery`);await page.getByRole('combobox',{name:'生成依据分支'}).waitFor();assert.equal(await page.getByRole('combobox',{name:'生成依据分支'}).inputValue(),'fixture-branch-beta');
      results.push({case:'from-branch-predicts-generation-source',pass:true});
      oldContract=true;await page.reload();await page.getByRole('radio',{name:/^Compose 模式/}).check();
      await page.getByRole('alert').filter({hasText:'当前服务版本未确认'}).waitFor();
      assert(await page.getByRole('button',{name:'保存交付模式',exact:true}).isDisabled());assert.equal(writes.length,2);
      results.push({case:'old-server-contract-cannot-receive-new-save',pass:true});
      oldContract=false;source.splice(1,1);
      await page.goto(`${base}/settings/fixture-project?fromBranch=deleted#delivery`);await page.getByText(/已改用唯一可用分支 main/).waitFor();
      assert.equal(await page.getByRole('combobox',{name:'生成依据分支'}).count(),0);assert(await page.getByRole('button',{name:'重新生成项目配置',exact:true}).isEnabled());
      source.push({id:'fixture-branch-beta',branch:'feature/example'});
      await page.goto(`${base}/settings/fixture-project?fromBranch=deleted-again#delivery`);await page.getByText('原分支已不可用，请重新选择生成依据。',{exact:true}).waitFor();
      assert.equal(await page.getByRole('combobox',{name:'生成依据分支'}).inputValue(),'');assert(await page.getByRole('button',{name:'重新生成项目配置',exact:true}).isDisabled());
      results.push({case:'stale-from-branch-recovers-single-or-explicit-multiple-source',pass:true});
    }
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'results.json'),JSON.stringify({provenance:'deterministic-fixture',baseline,results,writes,errors},null,2));return results;
  }catch(error){await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.txt'),`${error.stack}\n${await page.locator('body').innerText()}`);throw error;}finally{await context.close();}
}
