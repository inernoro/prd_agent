import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

const ok = data => ({ success: true, data, error: null });
const fail = () => ({ success: false, data: null, error: { code: 'NETWORK_ERROR', message: 'raw-secret-stack' } });
const model = (id, modelType = 'chat', enabled = true) => ({ id, publicId: `public-${id}`, name: `模型${id}`, modelType, enabled, identityKind: 'fixed', aliases: [], capabilities: [], allowedAppCallerCodes: [], defaultForAppCallerCodes: [], routingStrategy: 'priority', isDefaultForType: false, offerings: [] });
test('全局待处理总数超过当前页时仍明确提示未展示遗漏', async t => {
  const h = await setup(t);
  h.f.override = name => name === 'getModelReferenceMigrationPlans' ? ok({ items: [h.f.plan], total: 250, unresolvedTotal: 240, hasMore: true }) : undefined;
  await h.render(h.c.ModelReferenceMigrationOverview, { onOpen() {} });
  assert.match(h.body(), /待处理 240/);
  assert.match(h.body(), /尚有更多记录/);
  assert.match(h.body(), /不能将当前列表当作全部记录/);
});
function coverage(overrides = {}) {
  const c = { registryVersion: 'v1', registryHash: 'hash-v1', canComplete: true, verified: false, affected: 2, migrated: 0, blocked: 0, unknown: 0, residual: 2, ...overrides };
  return { ...c, consumers: [{ key: 'arena.slots', count: 4, ...Object.fromEntries(['affected','migrated','blocked','unknown','residual'].map(k => [k,c[k]])), reasons: [] }], items: [{ consumerKey: 'arena.slots', collection: 'arena_slots', recordId: 'slot', path: 'logicalModelId', status: 'affected', reason: '活动阵容需要更新' }] };
}
function makePlan(f, source = 'source', target = 'target') {
  const identity = logicalId => ({ logicalId, publicId: `public-${logicalId}`, aliases: [], poolIds: [] });
  return { intentId: 'original-intent', revision: 1, tenantId: 'tenant', actorId: 'actor', mapping: { tenantId: 'tenant', source: identity(source), target: identity(target) }, coverage: coverage(), status: 'planned', createdAt: new Date(f.now).toISOString(), updatedAt: new Date(f.now).toISOString() };
}
async function setup(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logical-models' });
  const names = ['window','document','HTMLElement','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','Event','MouseEvent'];
  const saved = Object.fromEntries(names.map(n => [n,globalThis[n]]));
  for (const n of names) globalThis[n] = dom.window[n];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; dom.window.HTMLElement.prototype.scrollTo = () => {};
  const timers = new Map(); let nextTimer = 0;
  dom.window.setInterval = (callback,delay) => { const id = ++nextTimer; timers.set(id,{callback,delay}); return id; };
  dom.window.clearInterval = id => timers.delete(id);
  const realNow = Date.now;
  const f = { now: realNow(), role: 'owner', models: [model('source','chat',false),model('target'),model('second'),model('image','generation'),model('disabled','chat',false)], calls: [], plans: [], usages: [], override: null };
  f.plan = makePlan(f); Date.now = () => f.now;
  f.api = async (name,args) => {
    f.calls.push({name,args});
    if (f.override) { const value = await f.override(name,args); if (value !== undefined) return value; }
    if (name === 'getLogicalModels') return ok({items:f.models,total:f.models.length});
    if (name === 'getModelReferenceCoverage') return ok(structuredClone(f.coverage || coverage()));
    if (name === 'getModelReferenceMigrationPlans') return ok({items:structuredClone(f.plans)});
    if (name === 'getRepairableModelUsages') return ok({items:structuredClone(f.usages)});
    if (name === 'createModelReferenceMigrationPlan') { f.plan = makePlan(f,args[0].sourceLogicalId,args[0].targetLogicalId); return f.unknownCreate ? fail() : ok(structuredClone(f.plan)); }
    if (name === 'createModelReferenceMigrationFromUsage') { f.plan = makePlan(f,'',args[0].targetLogicalId); return ok(structuredClone(f.plan)); }
    if (name === 'getModelReferenceMigrationPlan' || name === 'getModelReferenceMigrationPlanByRequest') return f.failRead ? fail() : ok(structuredClone(f.plan));
    if (name === 'runModelReferenceMigrationAction') { f.plan.revision++; f.plan.status = f.unknownApply ? 'applying' : 'completed'; f.plan.coverage = coverage({migrated:2,residual:0,verified:true,validUntil:new Date(f.now+600000).toISOString()}); return f.unknownApply ? fail() : ok(structuredClone(f.plan)); }
    if (name === 'getExchangeMeta') return ok({modelTypes:[],options:[]});
    return ok({items:[],total:0});
  };
  globalThis.__referenceFixture = f;
  const router = await import('react-router-dom'); globalThis.__referenceRouter = {...router.default,...router};
  const api = await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');
  const apiNames = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]);
  const cacheDir = await mkdtemp(join(tmpdir(),'reference-ui-'));
  const server = await createServer({cacheDir,root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},ssr:{noExternal:['react-router-dom']},plugins:[{name:'reference-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0reference-router';},load(id){
    if(id==='\0reference-router')return Object.keys(globalThis.__referenceRouter).filter(n=>n!=='default').map(n=>`export const ${n}=globalThis.__referenceRouter.${n};`).join('\n');
    if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {tenant:{id:"tenant",role:globalThis.__referenceFixture.role}}}';
    if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async()=>true,promptText:async()=>null}}';
    if(id.endsWith('/src/lib/api.ts'))return apiNames.map(n=>`export async function ${n}(...args){return globalThis.__referenceFixture.api(${JSON.stringify(n)},args)}`).join('\n');
  }}]});
  const c = await server.ssrLoadModule('/src/components/ModelReferenceMigrationPanel.tsx');
  const {createRoot} = await import('react-dom/client'); const root = createRoot(document.getElementById('root'));
  let renderId = 0;
  const render = async (Component=c.ModelReferenceMigrationPanel,props={}) => act(async()=>root.render(React.createElement(globalThis.__referenceRouter.MemoryRouter,{},React.createElement(Component,{source:f.models[0],key:++renderId,...props}))));
  const button = label => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
  const click = async label => {const b=button(label);assert.ok(b,`缺少按钮 ${label}`);assert.equal(b.disabled,false,`${label}不应禁用`);await act(async()=>b.click());};
  const select = async value => {const s=document.querySelector('select[aria-label="升级到同用途模型"]');assert.ok(s);await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value').set.call(s,value);s.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});};
  const tick = async delay => {const list=[...timers.values()].filter(v=>v.delay===delay);assert.ok(list.length,`缺少${delay}ms轮询`);await act(async()=>{for(const v of list)await v.callback();});};
  t.after(async()=>{await act(async()=>root.unmount());await server.close();await rm(cacheDir,{recursive:true,force:true});dom.window.close();Date.now=realNow;for(const n of names){if(saved[n]===undefined)delete globalThis[n];else globalThis[n]=saved[n];}delete globalThis.__referenceFixture;delete globalThis.__referenceRouter;});
  return {f,c,server,render,button,click,select,tick,body:()=>document.body.textContent};
}

test('完整覆盖清单展示SDK等阻断，空响应与只读角色不能执行',async t=>{
  const h=await setup(t);h.f.coverage=coverage({canComplete:false,blocked:1,unknown:1});h.f.coverage.consumers.push({key:'sdk.env.voice',count:3,affected:2,migrated:0,blocked:1,unknown:1,residual:2,reasons:['SDK、环境配置与语音引用需要人工核对']});
  await h.render();await h.select('target');assert.match(h.body(),/sdk.env.voice/);assert.match(h.body(),/SDK、环境配置与语音引用需要人工核对/);assert.equal(h.button('生成升级计划').disabled,true);
  assert.equal(document.querySelector('option[value="image"]'),null);assert.equal(document.querySelector('option[value="disabled"]').disabled,true);
  h.f.coverage={...coverage(),consumers:[]};await h.click('重新扫描范围');assert.match(h.body(),/尚未取得完整覆盖清单/);assert.equal(h.button('生成升级计划').disabled,true);
  h.f.coverage=coverage();h.f.role='viewer';await h.render();await h.select('target');assert.equal(h.button('生成升级计划').disabled,true);assert.equal(h.f.calls.some(x=>x.name.startsWith('createModelReference')),false);
});
test('未知创建结果按同clientRequestId恢复，未知应用仅GET原计划不重POST并持续计时',async t=>{
  const h=await setup(t);h.f.unknownCreate=true;h.f.unknownApply=true;await h.render();await h.select('target');await h.click('生成升级计划');
  const creates=h.f.calls.filter(x=>x.name==='createModelReferenceMigrationPlan');assert.equal(creates.length,1);assert.match(creates[0].args[0].clientRequestId,/^[0-9a-f-]{36}$/);assert.ok(h.f.calls.some(x=>x.name==='getModelReferenceMigrationPlanByRequest'&&x.args[0]===creates[0].args[0].clientRequestId));
  await h.click('升级全部使用位置');assert.equal(h.button('升级全部使用位置').disabled,true);h.f.now+=3000;await h.tick(1000);assert.match(h.body(),/已用 3 秒/);await h.tick(2000);await h.tick(2000);
  assert.equal(h.f.calls.filter(x=>x.name==='runModelReferenceMigrationAction').length,1);assert.ok(h.f.calls.filter(x=>x.name==='getModelReferenceMigrationPlan').every(x=>x.args[0]==='original-intent'));assert.doesNotMatch(h.body(),/升级全部使用位置完成|raw-secret-stack/);
  h.f.plan.status='completed';await h.tick(2000);assert.match(h.body(),/升级全部使用位置完成/);
});
test('部署明确在建档前拒绝时显示恢复动作，不查询不存在的计划且可重新创建',async t=>{
  const h=await setup(t);
  const reason='当前分支不允许修改模型配置，请前往 main 主环境处理。';
  h.f.override=name=>name==='createModelReferenceMigrationPlan'?{success:false,data:null,error:{code:'REFERENCE_DEPLOYMENT_BLOCKED',message:reason}}:undefined;
  await h.render();await h.select('target');await h.click('生成升级计划');
  assert.match(h.body(),new RegExp(reason));assert.equal(h.button('重新扫描范围').disabled,false);
  assert.equal(h.f.calls.filter(x=>x.name==='getModelReferenceMigrationPlanByRequest').length,0);
  assert.doesNotMatch(h.body(),/结果尚未确认|正在生成升级计划|升级全部使用位置完成/);
  h.f.override=null;await h.click('重新扫描范围');await h.click('生成升级计划');assert.equal(h.button('升级全部使用位置').disabled,false);
  assert.equal(h.f.calls.filter(x=>x.name==='createModelReferenceMigrationPlan').length,2);
});
test('完成必须GET复读且零残留；过期及读失败撤销绿色状态',async t=>{
  const h=await setup(t);let contradict=false;h.f.override=name=>{if(name==='getModelReferenceMigrationPlan'&&contradict)return ok({...structuredClone(h.f.plan),coverage:coverage({migrated:1,residual:1,verified:true,validUntil:new Date(h.f.now+600000).toISOString()})});};
  await h.render();await h.select('target');await h.click('生成升级计划');contradict=true;await h.click('升级全部使用位置');assert.doesNotMatch(h.body(),/升级全部使用位置完成/);assert.match(h.body(),/需重新核对/);
  contradict=false;await h.click('继续查询原计划');assert.match(h.body(),/升级全部使用位置完成/);h.f.now+=601000;await h.tick(30000);assert.doesNotMatch(h.body(),/升级全部使用位置完成/);
  h.f.plan.coverage.validUntil=new Date(h.f.now+600000).toISOString();await h.click('继续查询原计划');assert.match(h.body(),/升级全部使用位置完成/);h.f.failRead=true;await h.click('继续查询原计划');assert.doesNotMatch(h.body(),/升级全部使用位置完成/);assert.match(h.body(),/暂未确认/);
});
test('迟到旧扫描不能覆盖新目标，切换范围丢弃旧计划',async t=>{
  const h=await setup(t);let resolveOld;h.f.override=(name,args)=>{if(name==='getModelReferenceCoverage'&&args[1]==='target')return new Promise(r=>{resolveOld=r;});if(name==='getModelReferenceCoverage'&&args[1]==='second')return ok(coverage({affected:7}));};
  await h.render();await h.select('target');assert.ok(resolveOld);await h.select('second');await act(async()=>resolveOld(ok(coverage({affected:99}))));assert.equal(document.querySelector('select').value,'second');assert.equal(document.querySelector('table').textContent.includes('99'),false);
  await h.click('生成升级计划');assert.equal(h.f.calls.find(x=>x.name==='createModelReferenceMigrationPlan').args[0].targetLogicalId,'second');await h.select('target');assert.equal(h.button('升级全部使用位置'),undefined);
});
test('孤立引用使用安全位置创建计划，不提交任意source，不冒称清单是全覆盖',async t=>{
  const h=await setup(t);h.f.usages=[{consumerKey:'arena.slots',recordId:'old-slot',path:'modelId',modelType:'chat',value:'deleted-model',status:'orphan'},{consumerKey:'prefs',recordId:'user',path:'voice',modelType:'chat',value:'unparsed',status:'unknown'},{consumerKey:'lab',recordId:'known',path:'model',modelType:'chat',value:'existing',status:'available'}];
  await h.render(h.c.ModelReferenceUsageRepairPanel);assert.match(h.body(),/目录身份失效|结构待核对/);assert.doesNotMatch(h.body(),/existing/);assert.match(h.body(),/不代表全量覆盖/);await h.click('选择使用位置');await h.select('target');await h.click('生成修复计划');
  const req=h.f.calls.find(x=>x.name==='createModelReferenceMigrationFromUsage').args[0];assert.deepEqual(Object.keys(req).sort(),['clientRequestId','consumerKey','path','recordId','targetLogicalId']);assert.equal(req.recordId,'old-slot');assert.equal(req.path,'modelId');assert.equal(h.f.calls.filter(x=>x.name==='getModelReferenceCoverage').length,0);assert.match(h.body(),/只修改所选使用位置/);await h.click('升级所选使用位置');assert.match(h.body(),/升级全部使用位置完成/);
});
test('全局入口显示遗漏并打开原计划，空列表不冒称成功',async t=>{
  const h=await setup(t);h.f.plan.status='blocked';h.f.plan.coverage=coverage({canComplete:false,blocked:2,unknown:1});h.f.plans=[h.f.plan];let opened;await h.render(h.c.ModelReferenceMigrationOverview,{onOpen:p=>{opened=p;}});
  assert.match(h.body(),/待处理 1/);await h.click('升级记录与遗漏');assert.match(h.body(),/阻断 2.*未确认 1.*残留 2/);await h.click('查看使用位置计划');assert.equal(opened.intentId,'original-intent');assert.equal(opened.mapping.target.logicalId,'target');h.f.plans=[];await h.click('刷新升级记录');assert.match(h.body(),/不代表已完成全量覆盖/);
});
test('模型页固定和停用模型均可进入使用位置面板',async t=>{
  const h=await setup(t);const {LogicalModelsPage}=await h.server.ssrLoadModule('/src/pages/LogicalModelsPage.tsx');await h.render(LogicalModelsPage);
  await act(async()=>{ const select=document.querySelector('[aria-label="清单状态筛选"]');Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(select,'disabled');select.dispatchEvent(new window.Event('change',{bubbles:true})); });await h.click('查看');await h.click('使用位置与升级');assert.ok(document.querySelector('[data-testid="model-reference-migration-panel"]'));assert.match(h.body(),/模型source/);assert.match(h.body(),/已停用/);await h.select('target');assert.equal(h.button('生成升级计划').disabled,false);
});
test('全局计划可打开已删除的source，不伪装成停用模型且只核对原计划',async t=>{
  const h=await setup(t);h.f.models=h.f.models.filter(m=>m.id!=='source');h.f.plan=makePlan(h.f,'removed','target');h.f.plan.status='blocked';h.f.plan.coverage=coverage({canComplete:false,blocked:1});h.f.plans=[h.f.plan];
  const {LogicalModelsPage}=await h.server.ssrLoadModule('/src/pages/LogicalModelsPage.tsx');await h.render(LogicalModelsPage);await h.click('升级与引用');await h.click('升级记录与遗漏');await h.click('查看使用位置计划');
  const panel=document.querySelector('[data-testid="model-reference-migration-panel"]');assert.ok(panel);assert.match(panel.textContent,/目录身份已失效/);assert.doesNotMatch(panel.querySelector('.lg-collection-facts').textContent,/已停用/);assert.equal(h.button('升级全部使用位置').disabled,true);assert.ok(h.f.calls.some(x=>x.name==='getModelReferenceMigrationPlan'&&x.args[0]==='original-intent'));
});
test('稳定升级策略即使读取失败仍有可操作的全量使用位置入口',async t=>{
  const h=await setup(t);h.f.models[0].identityKind='stable';h.f.override=name=>name==='getModelUpgrade'?fail():undefined;
  const {LogicalModelsPage}=await h.server.ssrLoadModule('/src/pages/LogicalModelsPage.tsx');await h.render(LogicalModelsPage);await act(async()=>{ const select=document.querySelector('[aria-label="清单状态筛选"]');Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(select,'disabled');select.dispatchEvent(new window.Event('change',{bubbles:true})); });await h.click('查看');await h.click('升级策略');await h.click('全量使用位置');assert.ok(document.querySelector('[data-testid="model-reference-migration-panel"]'));await h.select('target');assert.equal(h.button('生成升级计划').disabled,false);
});

test('Lab生图引用只选择generation目标，空用途或结构待核对不允许迁移',async t=>{
  const h=await setup(t);h.f.usages=[{consumerKey:'lab.groups',recordId:'image-group',path:'models[0]',modelType:'generation',value:'old-image',status:'orphan'},{consumerKey:'lab.experiments',recordId:'unknown',path:'models[0]',modelType:'',value:'unresolved',status:'unknown'}];
  await h.render(h.c.ModelReferenceUsageRepairPanel);await h.click('选择使用位置');assert.equal(document.querySelector('option[value="target"]'),null);await h.select('image');await h.click('生成修复计划');assert.equal(h.f.calls.find(x=>x.name==='createModelReferenceMigrationFromUsage').args[0].targetLogicalId,'image');
  const choices=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='选择使用位置');await act(async()=>choices[1].click());assert.match(h.body(),/结构或用途尚未确认/);assert.equal(h.button('生成修复计划').disabled,true);assert.equal(h.f.calls.filter(x=>x.name==='createModelReferenceMigrationFromUsage').length,1);
});
test('有效执行中的原计划不能恢复，客户端时间流逝不能代替服务端许可',async t=>{
  const h=await setup(t);h.f.plan.status='applying';h.f.plan.canResume=false;
  await h.render(h.c.ModelReferenceMigrationPanel,{initialPlan:h.f.plan});
  assert.equal(h.button('继续原升级计划').disabled,true);assert.equal(h.button('升级全部使用位置').disabled,true);
  h.f.now+=3600000;await h.tick(2000);assert.equal(h.button('继续原升级计划').disabled,true);
  assert.equal(h.f.calls.filter(x=>x.name==='runModelReferenceMigrationAction').length,0);assert.doesNotMatch(h.body(),/升级全部使用位置完成/);
});
test('GET确认可恢复后显式沿用原intent和revision提交一次，未知结果只GET且不能假报完成',async t=>{
  const h=await setup(t);h.f.plan.status='applying';h.f.plan.canResume=false;
  await h.render(h.c.ModelReferenceMigrationPanel,{initialPlan:h.f.plan});assert.equal(h.button('继续原升级计划').disabled,true);
  h.f.plan.canResume=true;h.f.plan.revision=7;await h.tick(2000);assert.equal(h.button('继续原升级计划').disabled,false);
  h.f.unknownApply=true;await h.click('继续原升级计划');
  const writes=()=>h.f.calls.filter(x=>x.name==='runModelReferenceMigrationAction');assert.equal(writes().length,1);assert.deepEqual(writes()[0].args,['original-intent','apply',7]);
  // 即使响应丢失后的读取仍带canResume=true，也不能自动或再次点击重发本次恢复。
  assert.equal(h.f.plan.canResume,true);assert.equal(h.button('继续原升级计划').disabled,true);await h.tick(2000);await h.tick(2000);assert.equal(writes().length,1);
  assert.equal(h.f.calls.filter(x=>x.name.startsWith('createModelReferenceMigration')).length,0);assert.ok(h.f.calls.filter(x=>x.name==='getModelReferenceMigrationPlan').every(x=>x.args[0]==='original-intent'));assert.doesNotMatch(h.body(),/升级全部使用位置完成/);
});
test('原计划恢复继续遵守只读、目标有效性和覆盖阻断守卫',async t=>{
  const h=await setup(t);h.f.plan.status='applying';h.f.plan.canResume=true;
  h.f.role='viewer';await h.render(h.c.ModelReferenceMigrationPanel,{initialPlan:h.f.plan});assert.equal(h.button('继续原升级计划').disabled,true);
  h.f.role='owner';h.f.plan.coverage=coverage({blocked:1,canComplete:false});await h.render(h.c.ModelReferenceMigrationPanel,{initialPlan:h.f.plan});assert.equal(h.button('继续原升级计划').disabled,true);
  h.f.plan.coverage=coverage();h.f.models.find(x=>x.id==='target').enabled=false;await h.render(h.c.ModelReferenceMigrationPanel,{initialPlan:h.f.plan});assert.equal(h.button('继续原升级计划').disabled,true);assert.equal(h.f.calls.filter(x=>x.name==='runModelReferenceMigrationAction').length,0);
});

for (const failInitialRead of [false,true]) test(`局部更新尚有全局残留时仅在权威读取后刷新候选位置，读取失败=${failInitialRead}`,async t=>{
  const h=await setup(t);
  const first={consumerKey:'prefs',recordId:'first-owner',path:'chatModelId',modelType:'chat',value:'retired-shared-model',status:'orphan'};
  const second={...first,recordId:'second-owner'};h.f.usages=[first,second];
  h.f.override=name=>{
    if(name==='runModelReferenceMigrationAction'){
      h.f.plan.revision++;h.f.plan.status='blocked';h.f.plan.coverage=coverage({migrated:1,residual:1,blocked:1,canComplete:false,verified:false});
      h.f.usages=[second];h.f.failRead=failInitialRead;return ok(structuredClone(h.f.plan));
    }
  };
  await h.render(h.c.ModelReferenceUsageRepairPanel);await h.click('选择使用位置');await h.select('target');await h.click('生成修复计划');await h.click('升级所选使用位置');
  const writes=()=>h.f.calls.filter(x=>x.name==='runModelReferenceMigrationAction').length;
  if(failInitialRead){
    assert.match(h.body(),/first-owner/);assert.equal(h.f.calls.filter(x=>x.name==='getRepairableModelUsages').length,1);
    h.f.failRead=false;await h.click('继续查询原计划');
  }
  assert.doesNotMatch(h.body(),/first-owner/);assert.match(h.body(),/second-owner/);
  assert.match(h.body(),/当前位置已更新，其他位置待迁移/);assert.doesNotMatch(h.body(),/升级全部使用位置完成/);
  assert.equal(h.f.calls.filter(x=>x.name==='getRepairableModelUsages').length,2);assert.equal(writes(),1);
  await h.click('继续查询原计划');assert.equal(h.f.calls.filter(x=>x.name==='getRepairableModelUsages').length,2);assert.equal(writes(),1);
});
