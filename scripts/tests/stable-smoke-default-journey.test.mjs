import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as defaultJourney from '../../e2e/utils/stableSmokeDefaultJourney.mjs';
import {assertDefaultPeachRequest,createDefaultWorkspaceThroughUi,selectSupportedDefaultSizes,submitDefaultPeachThroughUi,secondaryImagePlacement,readCanvasPlacementThroughUi} from '../../e2e/utils/stableSmokeDefaultJourney.mjs';
import * as multiJourney from '../../e2e/utils/stableSmokeDefaultJourney.mjs';

const multiReferences = [
 {name:'b.png',sha256:'b'.repeat(64),url:'https://offline.invalid/b.png',refId:2,mime:'image/png',bytes:700},
 {name:'a.png',sha256:'a'.repeat(64),url:'https://offline.invalid/a.png',refId:1,mime:'image/png',bytes:701},
];
const multiRequest = {modelId:'configured-public-id',platformId:'logical-model',size:'1024x1024',targetKey:'owned-frame',prompt:'组合主色',expectedImageRefCount:2,
 imageRefs:multiReferences.map((r,index)=>({refId:r.refId,assetSha256:r.sha256,url:r.url,label:`第${index+1}张图`}))};
const multiPool={isDefault:true,code:'configured-public-id',name:'后端配置别名'};

function multiLayoutFixture({after={x:100,y:100,width:300,height:300},hitBlocked=false,selected=0}={}){
 const events=[];let fitted=false;
 const viewport={x:0,y:0,width:1000,height:800},panelRect={x:600,y:10,width:390,height:780};
 const before={x:450,y:500,width:500,height:500};
 const rect=value=>({...value,left:value.x,top:value.y,right:value.x+value.width,bottom:value.y+value.height});
 const node=(name,bounds)=>({name,parentElement:null,ownerDocument:null,getBoundingClientRect:()=>rect(typeof bounds==='function'?bounds():bounds)});
 const root=node('root',viewport),stage=node('stage',viewport),frame=node('frame',()=>fitted?after:before),image=node('image',()=>fitted?after:before),panel=node('panel',panelRect),input=node('input',{x:620,y:650,width:350,height:100}),foreign=node('cover',{x:0,y:0,width:1,height:1});
 stage.parentElement=root;frame.parentElement=stage;image.parentElement=frame;panel.parentElement=root;input.parentElement=panel;
 frame.contains=other=>other===frame||other===image;image.contains=other=>other===image;
 frame.closest=selector=>selector==='[data-tour-id="visual-editor-root"]'?root:undefined;
 input.closest=selector=>selector==='.absolute.z-30.flex.flex-col'?panel:undefined;
 frame.querySelectorAll=selector=>selector==='[data-testid="canvas-image"]'?[image]:[];
 root.querySelector=selector=>selector==='[data-tour-id="visual-editor-canvas"]'?stage:undefined;
 root.querySelectorAll=selector=>selector.includes('contenteditable')?[input]:[];
 const inside=(bounds,x,y)=>x>=bounds.x&&x<=bounds.x+bounds.width&&y>=bounds.y&&y<=bounds.y+bounds.height;
 const document={documentElement:{clientWidth:1000,clientHeight:800},defaultView:{innerWidth:1000,innerHeight:800,requestAnimationFrame:done=>done(),getComputedStyle:element=>({overflowX:element===stage?'hidden':'visible',overflowY:element===stage?'hidden':'visible'})},
  elementFromPoint:(x,y)=>hitBlocked?foreign:inside(input.getBoundingClientRect(),x,y)?input:inside(panelRect,x,y)?panel:inside(image.getBoundingClientRect(),x,y)?image:frame};
 for(const element of[root,stage,frame,image,panel,input,foreign])element.ownerDocument=document;
 const target={count:async()=>1,waitFor:async()=>{},evaluate:async(fn,arg)=>fn(frame,arg),isVisible:async()=>true};
 const rootLocator={waitFor:async()=>{},locator:selector=>selector==='.image-chip-node'?{count:async()=>selected}:target,
  getByRole:(role,{name,exact})=>{assert.equal(role,'button');assert.equal(name,'适配');assert.equal(exact,true);return{count:async()=>1,waitFor:async()=>{},click:async()=>{fitted=true;events.push('native-fit');}};}};
 const page={locator:selector=>{assert.equal(selector,'[data-tour-id="visual-editor-root"]');return rootLocator;}};
 return {page,events,target};
}

test('MVIS011 原isVisible为真但底部裁切必须红，真实适配按钮后完整边界和无遮挡才绿',async()=>{
 const fixture=multiLayoutFixture();
 assert.equal(await fixture.target.isVisible(),true,'旧普通可见断言不能证明完整画框');
 await assert.rejects(()=>multiJourney.readMultiImageResultLayoutThroughUi(fixture.page,{targetKey:'own-frame'}),/multi\/layout/);
 const proof=await multiJourney.fitMultiImageResultThroughUi(fixture.page,{targetKey:'own-frame'});
 assert.deepEqual(fixture.events,['native-fit']);assert.equal(proof.targetKey,'own-frame');assert.equal(proof.sampledPoints,27);
 assert.deepEqual(proof.frame,{x:100,y:100,width:300,height:300});assert.equal(proof.action,'native-fit-button');
});

test('MVIS011 适配后仍裁切、聊天层相交或命中被盖均红，不能凭截图数量或旧选择放行',async()=>{
 for(const options of[{after:{x:100,y:650,width:300,height:300}},{after:{x:450,y:100,width:300,height:300}},{hitBlocked:true},{selected:1}]){
  const fixture=multiLayoutFixture(options);
  await assert.rejects(()=>multiJourney.fitMultiImageResultThroughUi(fixture.page,{targetKey:'own-frame'}),/multi\/layout/);
 }
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const body=source.split('async function runDefaultMultiImageJourney')[1].split("test('[MVIS-003][MVIS-004]")[0];
 assert.ok(body.indexOf('fitMultiImageResultThroughUi')>body.indexOf('decodeDownloadedImageDimensions'));
 assert.ok(body.indexOf('fitMultiImageResultThroughUi')<body.indexOf('multi-image-${referenceCount}-result'));
 assert.match(body,/multi-image-result-layout/);
 const helper=readFileSync(new URL('../../e2e/utils/stableSmokeDefaultJourney.mjs',import.meta.url),'utf8').split('export async function readMultiImageResultLayoutThroughUi')[1].split('function multiImageCanvasError')[0];
 assert.doesNotMatch(helper,/\.style\s*[.=]|scrollIntoView|force:\s*true|request\.(post|put)|\.route\(|\.fulfill\(/);
});


test('REG-multi-image-001 合法持久化shape按上传assetId关联，省略sha/name仍读真实非顺序refId',async()=>{
 const references=multiReferences.map((reference,index)=>({...reference,assetId:'asset-'+index}));
 const detail={assets:references.map(reference=>({id:reference.assetId,sha256:reference.sha256,url:reference.url})),
  canvas:{payloadJson:JSON.stringify({schemaVersion:1,elements:references.map((reference,index)=>({id:'persisted-frame-'+index,kind:'image',assetId:reference.assetId,src:reference.url,refId:[41,9][index]}))})}};
 const canvas=JSON.parse(detail.canvas.payloadJson);
 assert.equal(canvas.elements.find(item=>item.sha256===references[0].sha256&&item.name===references[0].name),undefined,'真实合法shape必须让原sha+name读取假设变红');
 const actual=multiJourney.readPersistedMultiImageReferences(detail,references);
 assert.deepEqual(actual.map(({assetId,canvasKey,refId})=>({assetId,canvasKey,refId})),[{assetId:'asset-0',canvasKey:'persisted-frame-0',refId:41},{assetId:'asset-1',canvasKey:'persisted-frame-1',refId:9}]);
 const request={...multiRequest,imageRefs:actual.map((reference,index)=>({refId:reference.refId,assetSha256:reference.sha256,url:reference.url,label:`第${index+1}张图`}))};
 const {page}=multiUi(request);const selectors=[];const locate=page.locator;
 page.locator=selector=>{selectors.push(selector);return locate(selector);};
 await multiJourney.submitDefaultMultiImageThroughUi(page,{workspaceId:'owned',pool:multiPool,references:actual,prompt:'组合主色',size:'1024x1024',onCreated:()=>{}});
 assert.deepEqual(selectors.filter(selector=>selector.includes('canvas-image')),actual.map(reference=>`[data-canvas-key="${reference.canvasKey}"] [data-testid="canvas-image"][alt="${reference.name}"]`));
 for(const patch of [
  {assets:detail.assets.map(asset=>({...asset,id:'foreign'}))},
  {assets:detail.assets.map(asset=>({...asset,sha256:'f'.repeat(64)}))},
  {canvas:{payloadJson:JSON.stringify({schemaVersion:1,elements:canvas.elements.map(element=>({...element,sha256:'f'.repeat(64)}))})}},
  {canvas:{payloadJson:JSON.stringify({schemaVersion:1,elements:[...canvas.elements,canvas.elements[0]]})}},
  {canvas:{payloadJson:JSON.stringify({schemaVersion:1,elements:canvas.elements.map(element=>({...element,refId:9}))})}},
 ])assert.throws(()=>multiJourney.readPersistedMultiImageReferences({...detail,...patch},references));
});

test('REG-multi-image-001 资产已同步不等于canvas已落盘；只读有界等待后才回真实refId',async()=>{
 const references=multiReferences.map((reference,index)=>({...reference,assetId:'asset-'+index}));
 const assets=references.map(reference=>({id:reference.assetId,sha256:reference.sha256,url:reference.url}));
 const snapshot=ready=>({assets,canvas:{payloadJson:JSON.stringify({schemaVersion:1,elements:references.map((reference,index)=>({id:'persisted-frame-'+index,kind:'image',assetId:reference.assetId,refId:ready?[41,9][index]:undefined}))})}});
 let reads=0;
 const actual=await multiJourney.waitForPersistedMultiImageReferences({references,readDetail:async()=>snapshot(++reads>1),timeoutMs:500,intervalMs:0});
 assert.equal(reads,2);assert.deepEqual(actual.map(reference=>reference.refId),[41,9]);
 await assert.rejects(()=>multiJourney.waitForPersistedMultiImageReferences({references,readDetail:async()=>snapshot(false),timeoutMs:0,intervalMs:0}),/尚未持久化/);
 let wrongReads=0;
 await assert.rejects(()=>multiJourney.waitForPersistedMultiImageReferences({references,readDetail:async()=>{wrongReads++;return{...snapshot(true),assets:assets.map(asset=>({...asset,sha256:'f'.repeat(64)}))};},timeoutMs:500,intervalMs:0}),/身份不一致/);
 assert.equal(wrongReads,1,'真正身份冲突不得靠轮询洗绿');
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const body=source.split('async function runDefaultMultiImageJourney')[1].split("test('[MVIS-003][MVIS-004]")[0];
 assert.match(body,/multi-image-reference-uploaded/);assert.match(body,/multi-image-persisted-reference-identities/);
 assert.ok(body.indexOf('waitForPersistedMultiImageReferences')<body.indexOf('submitDefaultMultiImageThroughUi'),'没有真实持久身份之前不得发送模型');
 assert.doesNotMatch(body,/canvas\.elements\.find\(item => item\.sha256 === sha256 && item\.name === file\.name\)/);
});

test('REG-multi-image-001 多图请求真实保留默认、逐张身份、重排和独立2或3图数量',()=>{
 const proof={pool:multiPool,selectedLabel:multiPool.name,request:multiRequest,references:multiReferences,prompt:'组合主色',size:'1024x1024'};
 assert.equal(typeof multiJourney.assertDefaultMultiImageRequest,'function');
 assert.doesNotThrow(()=>multiJourney.assertDefaultMultiImageRequest(proof));
 for(const patch of [{modelId:'other'},{platformId:'model-pool'},{size:'512x512'},{targetKey:''},{imageRefs:[...multiRequest.imageRefs].reverse()},
  {imageRefs:[multiRequest.imageRefs[0]]},{imageRefs:multiRequest.imageRefs.map(r=>({...r,label:'丢序号'}))},{prompt:'忽略图片'},{expectedImageRefCount:3}]){
  assert.throws(()=>multiJourney.assertDefaultMultiImageRequest({...proof,request:{...multiRequest,...patch}}));
 }
 assert.throws(()=>multiJourney.assertDefaultMultiImageRequest({...proof,references:[...multiReferences,multiReferences[0]]}));
 for(const pool of [{...multiPool,isDefault:false},{...multiPool,name:'图片生成默认池'}])assert.throws(()=>multiJourney.assertDefaultMultiImageRequest({...proof,pool}));
});

function multiUi(actual=multiRequest){
 const events=[];let labels=[];
 const chips={count:async()=>labels.length,allTextContents:async()=>labels};
 const input={count:async()=>1,pressSequentially:async text=>events.push(['prompt',text])};
 const page={url:()=> 'https://offline.invalid/visual-agent/owned',
  locator:selector=>selector==='.image-chip-node'?chips:selector.includes('contenteditable')?input:{click:async options=>{
   const name=selector.match(/alt="([^"]+)"/)[1];if(!options?.modifiers)labels=[];labels.push(name);events.push(['select',name,options?.modifiers||[]]);
  }},getByRole:(_role,{name})=>{
   if(name==='模型偏好')return {filter:()=>({waitFor:async()=>{}}),innerText:async()=>multiPool.name};
   if(name==='投稿已开启（点击关闭）')return {count:async()=>0};
   if(name==='尺寸比例')return {innerText:async()=> '1K · 1:1'};
   return {click:async()=>events.push(['click',name])};
  },waitForResponse:async predicate=>{
   const response={ok:()=>true,url:()=> 'https://offline.invalid/api/visual-agent/image-master/workspaces/owned/image-gen/runs',request:()=>({method:()=> 'POST',postDataJSON:()=>actual}),json:async()=>({success:true,data:{runId:'own-run'}})};
   assert.equal(predicate(response),true);return response;
  }};
 return {page,events};
}

test('REG-multi-image-001 真人选b再a保留chips，只点发送一次且先登记真实run再断言',async()=>{
 const {page,events}=multiUi();
 const result=await multiJourney.submitDefaultMultiImageThroughUi(page,{workspaceId:'owned',pool:multiPool,references:multiReferences,prompt:'组合主色',size:'1024x1024',onCreated:id=>events.push(['created',id])});
 assert.equal(result.runId,'own-run');assert.deepEqual(result.chipLabels,['b.png','a.png']);
 assert.deepEqual(events,[['select','b.png',[]],['select','a.png',['Shift']],['prompt','组合主色'],['click','发送'],['created','own-run']]);
 const drift=multiUi({...multiRequest,imageRefs:[]});let created='';
 await assert.rejects(()=>multiJourney.submitDefaultMultiImageThroughUi(drift.page,{workspaceId:'owned',pool:multiPool,references:multiReferences,prompt:'组合主色',size:'1024x1024',onCreated:id=>{created=id;}}));
 assert.equal(created,'own-run');
});

test('REG-multi-image-001 缺声明只保留soft红继续观察，错值/丢图不得进入观察分支',async()=>{
 const actual={...multiRequest,expectedImageRefCount:undefined};const failures=[];
 const options={workspaceId:'owned',pool:multiPool,references:multiReferences,prompt:'组合主色',size:'1024x1024',onCreated:()=>{},onMissingReferenceDeclaration:async proof=>failures.push(proof.request.expectedImageRefCount)};
 assert.equal((await multiJourney.submitDefaultMultiImageThroughUi(multiUi(actual).page,options)).runId,'own-run');
 assert.deepEqual(failures,[undefined]);assert.equal(actual.expectedImageRefCount,undefined);
 for(const patch of [{expectedImageRefCount:0},{expectedImageRefCount:null},{expectedImageRefCount:undefined,imageRefs:[]}]){
  failures.length=0;await assert.rejects(()=>multiJourney.submitDefaultMultiImageThroughUi(multiUi({...multiRequest,...patch}).page,options));assert.deepEqual(failures,[]);
 }
});

test('REG-multi-image-001 三图只能由独立三图请求核销，不能借两图或同一任务计两种通过',async()=>{
 const references=[...multiReferences,{name:'c.png',sha256:'c'.repeat(64),url:'https://offline.invalid/c.png',refId:3,mime:'image/png',bytes:702}];
 const request={...multiRequest,expectedImageRefCount:3,imageRefs:references.map((r,index)=>({refId:r.refId,assetSha256:r.sha256,url:r.url,label:`第${index+1}张图`}))};
 const {page,events}=multiUi(request);
 const options={workspaceId:'owned',pool:multiPool,references,prompt:'组合主色',size:'1024x1024',onCreated:()=>{}};
 assert.equal((await multiJourney.submitDefaultMultiImageThroughUi(page,options)).runId,'own-run');
 assert.equal(events.filter(event=>event[0]==='click'&&event[1]==='发送').length,1);
 assert.deepEqual(events.filter(event=>event[0]==='select').map(event=>event[1]),['b.png','a.png','c.png']);
 await assert.rejects(()=>multiJourney.submitDefaultMultiImageThroughUi(multiUi(request).page,{...options,references:multiReferences}));
});

test('REG-multi-image-001 实际请求范围守卫不造响应，只放本轮首个POST；拦重复也保留红计数',async()=>{
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const routeBody=source.split("await page.route('**/api/visual-agent/image-master/workspaces/*/image-gen/runs', async route => {")[1]?.split('\n        });')[0];
 assert.ok(routeBody);
 const guard=new Function('workspace',`let allowedCreates=0;return {handler:async route=>{${routeBody}},count:()=>allowedCreates};`)({id:'owned'});
 const run=async(path,method='POST')=>{const calls=[];await guard.handler({request:()=>({url:()=>`https://offline.invalid${path}`,method:()=>method}),continue:async()=>calls.push('continue'),abort:async()=>calls.push('abort')});return calls;};
 assert.deepEqual(await run('/api/visual-agent/image-master/workspaces/owned/image-gen/runs'),['continue']);
 assert.deepEqual(await run('/api/visual-agent/image-master/workspaces/owned/image-gen/runs'),['abort']);
 assert.deepEqual(await run('/api/visual-agent/image-master/workspaces/other/image-gen/runs'),['abort']);
 assert.equal(guard.count(),3,'重复和外空间请求不能从失败计数中抹掉');
 assert.deepEqual(await run('/api/visual-agent/image-master/workspaces/owned/image-gen/runs','GET'),['continue']);
 assert.match(source,/expect\(allowedCreates, '重复请求即使被零计费守卫拦截，也不得判业务通过'\)\.toBe\(1\)/);
});

test('REG-multi-image-002 实际multipart顺序、字节哈希、MIME或数量任一丢失都红',()=>{
 const wire={content_type:'multipart/form-data',endpoint_path:'/v1/images/edits',file_count:2,files:multiReferences.map(r=>({field:'image[]',sha256:r.sha256,mime_type:r.mime,size_bytes:r.bytes}))};
 const log={requestId:'own-run-0-0',logicalModelPublicId:multiPool.code,appCallerCode:'visual-agent.image.vision::generation',protocol:'openai',imageSuccessCount:1,answerText:'{"data":[{"url":"redacted"}]}',requestBodyRedacted:JSON.stringify(wire)};
 const check=(value)=>multiJourney.assertMultiImageWireReferences({log:value,requestId:log.requestId,modelId:multiPool.code,references:multiReferences});
 assert.equal(typeof multiJourney.assertMultiImageWireReferences,'function');assert.doesNotThrow(()=>check(log));
 for(const patch of [{file_count:1},{files:[...wire.files].reverse()},{files:wire.files.map(f=>({...f,mime_type:'image/jpeg'}))},{files:wire.files.map(f=>({...f,size_bytes:0}))},{endpoint_path:'/chat/completions'}])assert.throws(()=>check({...log,requestBodyRedacted:JSON.stringify({...wire,...patch})}));
 for(const patch of [{requestId:'other-run-0-0'},{logicalModelPublicId:'other'},{protocol:'openai-chat'},{imageSuccessCount:0},{answerText:'{"ok":true}'}])assert.throws(()=>check({...log,...patch}));
 const routerWire={input_references:multiReferences.map(r=>({type:'image_url',image_url:{url:`[BASE64_IMAGE:${r.sha256}:${r.mime}]`}}))};
 assert.doesNotThrow(()=>check({...log,protocol:'openrouter-image',requestBodyRedacted:JSON.stringify(routerWire)}));
 assert.throws(()=>check({...log,protocol:'openrouter-image',requestBodyRedacted:JSON.stringify({input_references:routerWire.input_references.slice(0,1)})}));
});

test('REG-multi-image-001 原旅程分开两图三图一次UI，默认适配、下载解码、语义和canonical清理均接线',()=>{
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const start=source.indexOf("test.describe('多图正常路径每组合最多一次");assert.ok(start>0);
 const body=source.slice(start,source.indexOf("test('[MVIS-003][MVIS-004]",start));
 for(const expected of ["test.describe.configure({ retries: 0 })","test('[MVIS-001]","test('[MVIS-002][MVIS-003]",'enterVisualFromHome(page)','createDefaultWorkspaceThroughUi(','submitDefaultMultiImageThroughUi(','assertMultiImageWireReferences(',"multi-image-run-created",'cleanupTrackedFixture(',"kind: 'run'",'decodeDownloadedImageDimensions','assertDefaultAspectArtifact','measureReferenceColorCoverage','onMissingReferenceDeclaration','expectedImageRefCount','page.reload(','createRequests','imageRefs','blue','yellow','red'])assert.ok(body.includes(expected),expected);
 assert.doesNotMatch(body,/createVisualWorkspace\(|page\.goto\(|readGatewayUpstreamIndex|gw\/logical-models|gw\/models|gw\/pools|1536x1024|wideThreeRunId|page\.request\.post\(/);
 assert.equal((body.match(/submitDefaultMultiImageThroughUi\(/g)||[]).length,1);
 const helper=readFileSync(new URL('../../e2e/utils/stableSmokeDefaultJourney.mjs',import.meta.url),'utf8').split('export async function submitDefaultMultiImageThroughUi')[1];
 assert.doesNotMatch(helper,/\.goto\(|\.route\(|\.fulfill\(|request\.(post|put)/);
});
const proof={pool:{isDefault:true,code:'configured-public-id',name:'具体配置型号'},selectedLabel:'具体配置型号',request:{prompt:'白桃',size:'1024x1024',modelId:'configured-public-id',platformId:'logical-model',expectedImageRefCount:0,targetKey:'owned-canvas'}};

const aspectCapability = { matched: true, modelId: proof.pool.code, sizesByResolution: {
 '1k': [{size:'1024x1024',aspectRatio:'1:1'},{size:'1344x768',aspectRatio:'16:9'},{size:'768x1344',aspectRatio:'9:16'}],
 '2k': [{size:'2048x2048',aspectRatio:'1:1'}],
} };
test('REG-visual-policy-001 VIS004当前默认能力选最低支持画幅，正式每commit只一张',()=>{
 assert.equal(typeof defaultJourney.planDefaultAspectJourney,'function');
 const cds=defaultJourney.planDefaultAspectJourney(aspectCapability,proof.pool.code,{environment:'cds',commit:'a'.repeat(40)});
 assert.deepEqual(cds.requested.map(x=>x.size),['1024x1024','1344x768','768x1344']);
 const seen=new Set();
 for(const char of ['a','b','c']){
  const plan=defaultJourney.planDefaultAspectJourney(aspectCapability,proof.pool.code,{environment:'production',commit:char+'a'.repeat(39)});
  assert.equal(plan.requested.length,1);seen.add(plan.requested[0].orientation);
  assert.deepEqual(plan,defaultJourney.planDefaultAspectJourney(aspectCapability,proof.pool.code,{environment:'production',commit:char+'a'.repeat(39)}));
 }
 assert.equal(seen.size,3);
 const partial=defaultJourney.planDefaultAspectJourney({...aspectCapability,sizesByResolution:{'1k':[aspectCapability.sizesByResolution['1k'][1]]}},proof.pool.code,{environment:'production',commit:'a'.repeat(40)});
 assert.deepEqual(partial.requested.map(x=>x.size),['1344x768']);
 assert.deepEqual(partial.unsupportedOrientations,['square','portrait']);
 for(const bad of [{...aspectCapability,matched:false},{...aspectCapability,modelId:'other'},{...aspectCapability,sizesNotApplicable:true},{...aspectCapability,sizesByResolution:{}}])assert.throws(()=>defaultJourney.planDefaultAspectJourney(bad,proof.pool.code,{environment:'production',commit:'a'.repeat(40)}));
});

function aspectUi(patch={}){
 const events=[];let selected=false;
 const requested={size:'1344x768',width:1344,height:768,aspectRatio:'16:9',tier:'1k',orientation:'landscape',prompt:'横版产品照，一枚蓝色陶瓷杯，纯白背景，不要文字'};
 const actual={...proof.request,prompt:requested.prompt,size:requested.size,...patch};
 const sizeButton={click:async()=>events.push('size-open'),innerText:async()=>selected?'1K · 16:9':'1K · 1:1'};
 const input={count:async()=>1,fill:async value=>events.push(['prompt',value])};
 const page={url:()=> 'https://example.invalid/visual-agent/owned-id',getByRole:(_role,{name})=>{
  if(name==='模型偏好')return {filter:()=>({waitFor:async()=>{}}),innerText:async()=>proof.pool.name};
  if(name==='投稿已开启（点击关闭）')return {count:async()=>0};
  if(name==='尺寸比例')return sizeButton;
  return {click:async()=>{events.push(name);if(name==='16:9')selected=true;}};
 },locator:()=>input,waitForResponse:async()=>({ok:()=>true,json:async()=>({success:true,data:{runId:'owned-run'}}),request:()=>({postDataJSON:()=>actual})})};
 return {page,requested,events};
}
test('REG-visual-policy-001 VIS004只点尺寸不换模型，真实UI仅发送一次并先登记任务',async()=>{
 const {page,requested,events}=aspectUi();
 const result=await defaultJourney.submitDefaultAspectThroughUi(page,{workspaceId:'owned-id',pool:proof.pool,requested,onCreated:id=>events.push(['created',id])});
 assert.equal(result.runId,'owned-run');assert.equal(result.request.size,requested.size);
 assert.deepEqual(events.filter(x=>typeof x==='string'),['size-open','1K','16:9','发送']);
 assert.ok(events.findIndex(x=>Array.isArray(x)&&x[0]==='created')>events.indexOf('发送'));
 for(const patch of [{modelId:'other'},{size:'1536x1024'},{targetKey:''},{imageRefs:[{refId:1}]},{prompt:'另一个输入'}]){
  const fixture=aspectUi(patch);let created='';
  await assert.rejects(()=>defaultJourney.submitDefaultAspectThroughUi(fixture.page,{workspaceId:'owned-id',pool:proof.pool,requested:fixture.requested,onCreated:id=>{created=id;}}));
  assert.equal(created,'owned-run','请求漂移也必须先登记真实任务供清理');
 }
 for(const pool of [{...proof.pool,isDefault:false},{...proof.pool,name:'图片生成默认池'}]){
  const fixture=aspectUi();
  await assert.rejects(()=>defaultJourney.submitDefaultAspectThroughUi(fixture.page,{workspaceId:'owned-id',pool,requested:fixture.requested,onCreated:()=>{}}));
  assert.deepEqual(fixture.events,[],'缺明确具体默认必须在任何选择或发送前停止');
 }
});
test('REG-visual-policy-001 VIS004原case接真人默认轮换、下载解码与canonical清理，不消费白桃融合任务',()=>{
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const body=source.split("test('[VIS-004]")[1].split("test('[VIS-003]")[0];
 assert.match(body,/loginAndReadToken\(page, request, '\/'\)/);
 assert.match(body,/createDefaultWorkspaceThroughUi\(/);assert.match(body,/enterVisualFromHome\(page\)/);
 assert.match(body,/planDefaultAspectJourney\(/);assert.match(body,/submitDefaultAspectThroughUi\(/);
 assert.match(body,/filter\(.*isDefault/);assert.match(body,/toHaveLength\(1\)/);
 for(const expected of ['readGeneratedImageBytes','decodeDownloadedImageDimensions','workspace.id','knownRunIds','cleanupTrackedFixture','vis004-run-created'])assert.ok(body.includes(expected),expected);
 assert.doesNotMatch(body,/createVisualWorkspace\(|page\.goto\(|page\.request\.post\(|submitDefaultPeachThroughUi\(|pools\.find\(/);
});
test('REG-visual-policy-001 VIS004以实际公布合同区分自适应画幅与固定像素，不洗绿白桃主例',()=>{
 const requested={width:1024,height:1024};
 const adaptive={isAdaptive:true,sizeParamFormat:'none',sizeConstraint:{type:'adaptive'}};
 assert.equal(defaultJourney.assertDefaultAspectArtifact(adaptive,requested,{width:1254,height:1254}).dimensionContract,'adaptive-aspect-only');
 for(const info of [{},{...adaptive,isAdaptive:false},{...adaptive,sizeParamFormat:'WxH'},{...adaptive,sizeConstraint:{type:'whitelist'}}])assert.throws(()=>defaultJourney.assertDefaultAspectArtifact(info,requested,{width:1254,height:1254}));
 for(const dimensions of [{width:1254,height:1000},{width:0,height:0},{width:1024.5,height:1024.5}])assert.throws(()=>defaultJourney.assertDefaultAspectArtifact(adaptive,requested,dimensions));
 assert.throws(()=>defaultJourney.assertDefaultAspectArtifact({...adaptive,limitations:{maxWidth:1200}},requested,{width:1254,height:1254}));
 assert.throws(()=>defaultJourney.assertDefaultAspectArtifact({...adaptive,limitations:{mustBeDivisibleBy:8}},requested,{width:1254,height:1254}));
 assert.equal(defaultJourney.assertDefaultAspectArtifact({},requested,requested).dimensionContract,'fixed-pixels');
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const aspect=source.split("test('[VIS-004]")[1].split("test('[VIS-003]")[0];
 assert.match(aspect,/assertDefaultAspectArtifact\(capability, requested, dimensions\)/);
 assert.match(aspect,/expect\.soft\(proof\.request\.expectedImageRefCount/);
 const jpeg=source.split("test('[VIS-003][REG-image-input-001]")[1].split("test('[MVIS-001]")[0];
 assert.match(jpeg,/toEqual\(\{ width: 1024, height: 1024 \}\)/);
 assert.throws(()=>assertDefaultPeachRequest({...proof,request:{...proof.request,size:'1254x1254'}}));
});
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

function missingDeclarationUi(patch={}) {
 const actual={...proof.request,x:1,y:2,w:1024,h:1024,expectedImageRefCount:undefined,...patch};
 const input={count:async()=>1,fill:async()=>{}};
 const model={filter:()=>({waitFor:async()=>{}}),innerText:async()=>proof.pool.name};
 const page={getByRole:(_role,{name})=>name==='模型偏好'?model:name==='投稿已开启（点击关闭）'?{count:async()=>0}:name==='尺寸比例'?{innerText:async()=> '1K · 1:1'}:{click:async()=>{}},locator:()=>input,
  waitForResponse:async()=>({ok:()=>true,json:async()=>({success:true,data:{runId:'owned-run'}}),request:()=>({postDataJSON:()=>actual})})};
 return {page,actual};
}
test('REG-visual-policy-001 缺声明原严格判据仍红，软断言消费者可继续观察真实零引用任务',async()=>{
 const {page,actual}=missingDeclarationUi();const errors=[];
 assert.throws(()=>assertDefaultPeachRequest({...proof,request:actual}),/无参考主例/);
 await assert.rejects(()=>submitDefaultPeachThroughUi(page,{workspaceId:'owned-id',pool:proof.pool,onCreated:()=>{}}),/无参考主例/);
 const observed=await submitDefaultPeachThroughUi(page,{workspaceId:'owned-id',pool:proof.pool,onCreated:()=>{},onMissingReferenceDeclaration:async p=>{
  try{assert.equal(p.request.expectedImageRefCount,0);}catch(error){errors.push(error);}
 }});
 assert.equal(errors.length,1,'缺字段必须保留红色判据，不能改成默认0');assert.equal(observed.runId,'owned-run');
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 assert.match(source,/onMissingReferenceDeclaration:[\s\S]*?expect\.soft\(proof\.request\.expectedImageRefCount,[\s\S]*?\)\.toBe\(0\)/);
});
test('REG-visual-policy-001 非缺失声明、非空引用和其他请求漂移不能进入继续取证分支',async()=>{
 for(const patch of [{expectedImageRefCount:1},{expectedImageRefCount:null},{imageRefs:[{refId:1}]},{size:'512x512'},{modelId:'other'},{targetKey:''}]){
  const {page}=missingDeclarationUi(patch);let callbacks=0;
  await assert.rejects(()=>submitDefaultPeachThroughUi(page,{workspaceId:'owned-id',pool:proof.pool,onCreated:()=>{},onMissingReferenceDeclaration:async()=>{callbacks++;}}));
  assert.equal(callbacks,0,'不能靠观察回调跳过真实输入或模型合同');
 }
});

test('REG-visual-policy-001 页面失败先观察已接收主任务再清理，既不加调用也不吞原红项',()=>{
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const body=source.split("test('[CORE-004][GW-005][GW-008]")[1].split("test('[VIS-008]")[0];
 const observe=body.slice(body.indexOf('// 页面状态判据失败仍保留原红项'),body.indexOf('// 失败也保留真实页面'));
 const verify=text=>{
  assert.match(text,/waitForImageRun\(page, token, runId, 600_000\)/);
  assert.match(text,/assertImageArtifact\(page, observed\.detail\)/);
  assert.match(text,/readGeneratedImageBytes\(page, observed\.detail\)/);
  assert.match(text,/decodeDownloadedImageDimensions/);
  assert.match(text,/width: 1024, height: 1024/);
  assert.match(text,/waitForGatewayLog\(request, `\$\{runId\}-0-0`/);
  assert.match(text,/default-submitted-task-observation-incomplete/);
  assert.doesNotMatch(text,/request\.(post|put)|\/cancel|create.*run/i);
 };
 verify(observe);
 assert.throws(()=>verify(observe.replace('await waitForImageRun(page, token, runId, 600_000)','undefined')));
 assert.throws(()=>verify(observe.replace('width: 1024, height: 1024','width: 1, height: 1')));
 assert.match(body,/\/\/ 失败也保留真实页面[\s\S]*throw error;[\s\S]*finally[\s\S]*\/cancel/);
});
