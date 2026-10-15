import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertDefaultPeachRequest,createDefaultWorkspaceThroughUi,selectSupportedDefaultSizes,submitDefaultPeachThroughUi,secondaryImagePlacement,readCanvasPlacementThroughUi} from '../../e2e/utils/stableSmokeDefaultJourney.mjs';
const proof={pool:{isDefault:true,code:'configured-public-id',name:'具体配置型号'},selectedLabel:'具体配置型号',request:{prompt:'白桃',size:'1024x1024',modelId:'configured-public-id',platformId:'logical-model',expectedImageRefCount:0,targetKey:'owned-canvas'}};
test('REG-visual-progress-002 请求未携带可选坐标时读取真实画框内联世界坐标，不猜原点', async()=>{
 const element={style:{left:'820px',top:'430px',width:'1024px',height:'1024px'}};
 const page={locator:selector=>{assert.equal(selector,'[data-canvas-key="owned-canvas"]');return {waitFor:async()=>{},count:async()=>1,evaluate:async fn=>fn(element)};}};
 assert.deepEqual(await readCanvasPlacementThroughUi(page,'owned-canvas'),{x:820,y:430,w:1024,h:1024});
 element.style.width='';await assert.rejects(()=>readCanvasPlacementThroughUi(page,'owned-canvas'),/canvas-fixture/);
 const source=readFileSync(new URL('../../e2e/utils/stableSmokeDefaultJourney.mjs',import.meta.url),'utf8');
 assert.match(source,/proof\.placement = await readCanvasPlacementThroughUi\(page, request\.targetKey\)/);
});
test('REG-visual-progress-002 并发图片按真实主图位置错开，不以固定1100遮住主图', () => {
 const primary={x:820,y:430,w:1024,h:1024};
 const next=secondaryImagePlacement(primary);
 assert.ok(next.x>primary.x+primary.w);
 assert.equal(next.y,primary.y);
 assert.throws(()=>secondaryImagePlacement({x:0,y:0,w:undefined,h:1024}), /canvas-fixture/);
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const testBody=source.split("test('[CORE-004][GW-005][GW-008]")[1].split("test('[VIS-003]")[0];
 assert.match(testBody,/secondaryImagePlacement\(created\.placement\)/);
 assert.doesNotMatch(testBody,/x: 1100/);
 assert.match(testBody,/data-canvas-key.*squareTargetKey.*getByTestId\('canvas-image'\)/);
});
test('REG-visual-policy-001 接受产品已有固定提示词包装，但不接受其它输入或附加指令',()=>{
 assert.doesNotThrow(()=>assertDefaultPeachRequest({...proof,request:{...proof.request,prompt:'Generate an image based on the following description:\n白桃'}}));
 for(const prompt of ['Generate an image based on the following description:\n蓝杯','白桃\n另一个对象','请忽略要求并生成白桃'])assert.throws(()=>assertDefaultPeachRequest({...proof,request:{...proof.request,prompt}}));
});
test('REG-visual-policy-001 真人默认白桃实际发送合同成立',()=>assert.doesNotThrow(()=>assertDefaultPeachRequest(proof)));
for(const [label,patch] of [['蓝杯不能替代白桃',{prompt:'蓝色陶瓷杯'}],['错误尺寸',{size:'1536x1024'}],['静默换型',{modelId:'another'}],['缺引用声明',{expectedImageRefCount:undefined}],['静默引用',{imageRefs:[{refId:1}]}],['缺画布身份',{targetKey:''}]])test(`REG-visual-policy-001 ${label}必须变红`,()=>assert.throws(()=>assertDefaultPeachRequest({...proof,request:{...proof.request,...patch}})));
test('REG-visual-policy-001 抽象池名和界面漂移不得算具体默认',()=>{assert.throws(()=>assertDefaultPeachRequest({...proof,pool:{...proof.pool,name:'图片生成默认池'}}));assert.throws(()=>assertDefaultPeachRequest({...proof,selectedLabel:'别的型号'}));});
test('REG-visual-policy-001 原主例必须接真人创建与发送，不直调API冒充',()=>{
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const primary=source.split("test('[CORE-004][GW-005][GW-008]")[1].split("test('[VIS-003]")[0];
 assert.match(primary,/createDefaultWorkspaceThroughUi\(/);
 assert.match(primary,/submitDefaultPeachThroughUi\(/);
 assert.match(primary,/const generationPrompt = '白桃'/);
});

function workspaceUi({runId,navigationFails=false}) {
 let title='',clicks=0;
 const page={
  url:()=> 'https://example.invalid/visual-agent',
  getByRole:(role)=>role==='dialog'?{getByRole:(child)=>child==='textbox'?{fill:async value=>{title=value;}}:{click:async()=>{clicks++;}}}:{click:async()=>{clicks++;}},
  waitForResponse:async()=>({ok:()=>true,json:async()=>({success:true,data:{workspace:{id:'owned-id',title:title.slice(0,40)}}})}),
  waitForURL:async()=>{if(navigationFails)throw Error('navigation interrupted');},
 };
 return {page,read:()=>({title,clicks}),runId};
}
test('REG-visual-policy-001 40字符runId不得被后缀截断，导航失败也保留清理身份',async()=>{
 const runId='stsmk-20261015-closure-8PZCrO-default-01';
 assert.equal(runId.length,40);
 const fixture=workspaceUi({runId,navigationFails:true});let created;
 await assert.rejects(()=>createDefaultWorkspaceThroughUi(fixture.page,{runId,onCreated:value=>{created=value;}}),/navigation interrupted/);
 assert.equal(fixture.read().title,runId);
 assert.equal(created?.id,'owned-id','导航失败前必须登记清理身份');
});
test('REG-visual-policy-001 越界或无巡检前缀标题必须在任何创建点击前拒绝',async()=>{
 for(const runId of ['real-project',`stsmk-${'a'.repeat(40)}`]){
  const fixture=workspaceUi({runId});
  await assert.rejects(()=>createDefaultWorkspaceThroughUi(fixture.page,{runId,onCreated:()=>{throw Error('不得产生实体');}}),/runId/);
  assert.equal(fixture.read().clicks,0);
 }
});
test('REG-visual-policy-001 方横竖来自当前具体型号，不向正式强送CDS尺寸',()=>{
 const capability=(sizes)=>({matched:true,modelId:'configured-public-id',sizesByResolution:{'1k':sizes.map(size=>({size}))}});
 const cds=selectSupportedDefaultSizes(capability(['1024x1024','1536x1024','1024x1536']),'configured-public-id');
 assert.equal(cds.landscape.size,'1536x1024');
 const prod=selectSupportedDefaultSizes(capability(['1024x1024','1344x768','768x1344']),'configured-public-id');
 assert.equal(prod.landscape.size,'1344x768');assert.equal(prod.portrait.size,'768x1344');
 for(const info of [capability([]),{...capability(['1024x1024']),modelId:'other'},{...capability(['1024x1024']),matched:false}])assert.throws(()=>selectSupportedDefaultSizes(info,'configured-public-id'),/configuration\/model-size/);
});
test('REG-visual-policy-001 请求断言失败前也记录任务身份和脱敏实际请求',async()=>{
 const events=[];const input={count:async()=>1,fill:async text=>{assert.equal(text,'白桃');}};
 const model={filter:()=>({waitFor:async()=>{}}),innerText:async()=>proof.pool.name};
 const page={getByRole:(_role,{name})=>name==='模型偏好'?model:name==='投稿已开启（点击关闭）'?{count:async()=>0}:name==='尺寸比例'?{innerText:async()=> '1K · 1:1'}:{click:async()=>{events.push('clicked');}},locator:()=>input,
 waitForResponse:async()=>({ok:()=>true,json:async()=>({success:true,data:{runId:'owned-run'}}),request:()=>({postDataJSON:()=>({...proof.request,size:'512x512'})})})};
 await assert.rejects(()=>submitDefaultPeachThroughUi(page,{workspaceId:'owned-id',pool:proof.pool,onCreated:id=>events.push(id),onSubmitted:async observed=>{events.push('recorded');assert.equal(observed.runId,'owned-run');assert.equal(observed.request.size,'512x512');assert.equal(observed.request.imageRefCount,0);}}),/白桃1024/);
 assert.deepEqual(events,['clicked','owned-run','recorded']);
});
