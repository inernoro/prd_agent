import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertRealLiteraryMarkerStream, assertLiteraryWorkspacePersisted, deleteAndVerifyLiteraryWorkspace, createLiterarySingleImagePolicy, readLiterarySingleImagePrompt, assertLiteraryImageInsertion, readLiteraryImagePlacement } from '../../e2e/utils/stableSmokeLiterary.mjs';
import { knownCreatedResources, validCleanupReceipt } from '../../e2e/utils/stableSmokeCleanupSafety.mjs';
import { createRequire } from 'node:module';
import { collectPlaywrightCases } from '../stable-smoke-results.mjs';

const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
const mobileStart = source.indexOf("test('[LIT-009]");
const mobileEnd = source.indexOf("test('[PARSE-001]", mobileStart);
assert.ok(mobileStart >= 0 && mobileEnd > mobileStart);
const mobile = source.slice(mobileStart, mobileEnd);

const desktopStart = source.indexOf("test('[LIT-001][LIT-002]");
const desktopEnd = source.indexOf("test('[LIT-007]", desktopStart);
const desktopAndBoundary = source.slice(desktopStart, desktopEnd);
const desktop = desktopAndBoundary.split("test('[LIT-006]")[0];

function assertDesktopWiring(body) {
  assert.match(body, /loginAndReadToken\(page, request, '\/'\)/);
  assert.ok(body.includes("getByRole('button', { name: /^文学创作智能体 任务：撰写完整文章/ })"));
  assert.match(body, /await entry\.click\(\)/);
  assert.doesNotMatch(body, /installLiteraryMarkerStream|resumeLiteraryMarkerStream|page\.route\(|\.fulfill\(|window\.fetch\s*=|page\.goto\(|page\.request\.(?:post|put|patch)\(|\.selectOption\(/);
  assert.match(body, /pendingCreation = page\.waitForResponse[\s\S]*?\.then\(/);
  assert.match(body, /workspaceId = body\.data\.workspace\.id;[\s\S]*?literary-workspace-created[\s\S]*?name: '创建'/);
  assert.match(body, /\/api\/literary-agent\/config\/models\/chat/);
  assert.match(body, /defaults[\s\S]*?isDefault/);
  assert.match(body, /expect\(submitted\.modelId[^;]*\.toBe\(defaultChat\.code\)/);
  assert.equal((body.match(/name: '生成配图标记', exact: true \}\)\.click\(\)/g) || []).length, 1);
  assert.match(body, /MutationObserver/);
  assert.match(body, /if \(await streamOutput\.isVisible\(\)\)/);
  assert.match(body, /literary-desktop-transient-visual-gap/);
  assert.match(body, /assertRealLiteraryMarkerStream/);
  assert.equal((body.match(/assertLiteraryWorkspacePersisted\(/g) || []).length, 2);
  assert.match(body, /cleanupTrackedFixture[\s\S]*?deleteAndVerifyLiteraryWorkspace/);
  assert.doesNotMatch(body, /\[LIT-006\]/, '标记生成不能冒充真实插图通过');
}

test('LIT-002 桌面原融合体只走真实首页默认原生流、全文持久化与canonical清理', () => {
  assertDesktopWiring(desktop);
  for (const [from, to] of [
    ["loginAndReadToken(page, request, '/')", "loginAndReadToken(page, request, '/literary-agent')"],
    ['assertRealLiteraryMarkerStream(', 'fakeMarkerStream('],
    ['cleanupTrackedFixture(', 'fakeCleanup('],
  ]) assert.throws(() => assertDesktopWiring(desktop.replaceAll(from, to)));
  for (const slot of ['01','04','05','06','07','08','09','12']) assert.ok(desktop.includes(`CDS-VISUAL-LITERARY-CREATION-${slot}`));
});

test('LIT-006 必须独立真实单卡生图与插入，不能沿用未执行占位或借标记流洗绿', () => {
  const boundary = desktopAndBoundary.split("test('[LIT-006]")[1];
  assert.ok(boundary, '原LIT006必须保留独立执行体');
  assert.doesNotMatch(boundary, /test\.skip\(true,/);
  assert.match(boundary, /createLiterarySingleImagePolicy/);
  assert.match(boundary, /name: '生成图片', exact: true/);
  assert.match(boundary, /assertLiteraryImageInsertion/);
  assert.match(boundary, /literary-image-run-created/);
  assert.match(boundary, /literary-image-asset-created/);
  assert.match(boundary, /cleanupTrackedFixture/);
  assert.match(boundary, /page\.reload/);
  const title = desktop.slice(0, desktop.indexOf("',"));
  const report = {suites:[{specs:[
    {title, tests:[{results:[{status:'passed'}]}]},
    {title:'[LIT-006] 文章真实配图与插入位置待验证',tests:[{results:[{status:'skipped',annotations:[{type:'skip',description:'真实图片插入未执行；标记不能替代'}]}]}]},
  ]}]};
  const rows=collectPlaywrightCases(report,'production');
  assert.deepEqual(rows.filter(row=>row.caseId==='LIT-006').map(row=>row.status),['not-run']);
  assert.ok(rows.some(row=>row.caseId==='LIT-002'&&row.status==='pass'));
});

test('LIT-002 桌面创建观察失败也清理已登记原workspace，删除失败仍红', async () => {
  const cleanupStart=desktop.indexOf('    } finally {')+'    } finally {'.length;
  const cleanup = desktop.slice(cleanupStart, desktop.indexOf('\n    }\n  });', cleanupStart))
    .split('\n').filter(line=>!line.includes('__stableSmokeLiteraryDesktop?.stop()')).join('\n');
  assert.ok(cleanup.includes('cleanupTrackedFixture'));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('pendingCreation', 'workspaceId', 'page', 'token', 'testInfo', 'cleanupTrackedFixture', 'deleteAndVerifyLiteraryWorkspace', 'authHeaders', 'stableSmokeCleanupTimeoutMs', 'redactStableSmokeDiagnosticText', cleanup);
  for (const scenario of ['before-created','created','observation-failed','observation-attachment-failed','delete-failed']) {
    const calls=[], attachments=[];
    const id=scenario==='before-created'?'':'a'.repeat(32);
    const page={request:{
      delete:async path=>{calls.push(['DELETE',path]);return {ok:()=>scenario!=='delete-failed',json:async()=>({success:true,data:{deleted:true}})};},
      get:async path=>{calls.push(['GET',path]);return {status:()=>404};},
    }};
    const info={attach:async (name)=>{attachments.push(name);if(scenario==='observation-attachment-failed'&&name==='literary-desktop-create-observation-failure')throw Error('attachment-failed');}};
    const canonical=async (_page,_token,resources,remove,context)=>{
      assert.equal(context,info);
      assert.deepEqual(resources,[{kind:'workspace',id,path:`/api/literary-agent/workspaces/${id}/detail`}]);
      calls.push(['canonical',id]);await remove();
    };
    const pending=scenario.startsWith('observation-')?Promise.reject(Error('observation-failed')):undefined;
    const action=()=>execute(pending,id,page,'offline-only',info,canonical,deleteAndVerifyLiteraryWorkspace,()=>({}),60_000,String);
    if(scenario==='delete-failed')await assert.rejects(action,/删除本轮工作区失败/);
    else if(scenario==='observation-attachment-failed')await assert.rejects(action,/attachment-failed/);
    else await action();
    if(scenario==='before-created')assert.deepEqual(calls,[]);
    else {
      assert.deepEqual(calls.slice(0,2),[['canonical',id],['DELETE',`/api/literary-agent/workspaces/${id}`]]);
      if(scenario!=='delete-failed')assert.deepEqual(calls[2],['GET',`/api/literary-agent/workspaces/${id}/detail`]);
    }
    if(scenario==='observation-failed')assert.ok(attachments.includes('literary-desktop-create-observation-failure'));
  }
});

test('LIT-009 必须从真实手机首页触控进入，不得伪造或节流成功流', () => {
  assert.match(mobile, /loginAndReadToken\(page, request, '\/'\)/);
  assert.match(mobile, /getByRole\('button', \{ name: '文学创作', exact: true \}\)[\s\S]*?\.tap\(\)/);
  assert.doesNotMatch(mobile, /installLiteraryMarkerStream|resumeLiteraryMarkerStream|mock-success|page\.route\(|\.fulfill\(|window\.fetch\s*=|addInitScript/);
  assert.doesNotMatch(mobile, /page\.request\.(?:post|put|patch)\(|\.selectOption\(/, '业务只能由原页面提交，不能API代造或改选模型');
  assert.match(mobile, /requiredEnv\('STABLE_SMOKE_RUN_ID'\)[\s\S]*?testInfo\.retry/);
  assert.match(mobile, /waitForResponse[\s\S]*?generate-markers[\s\S]*?生成配图标记[\s\S]*?\.tap\(\)/);
  assert.match(mobile, /assertRealLiteraryMarkerStream/);
});

test('LIT-009 原文和完整真实标记必须在保存与同空间刷新后两次严格回读', () => {
  assert.match(mobile, /setInputFiles[\s\S]*?Buffer\.from\(article, 'utf8'\)/);
  assert.equal((mobile.match(/assertLiteraryWorkspacePersisted\(/g) ?? []).length, 2);
  assert.match(mobile, /assertLiteraryWorkspacePersisted[\s\S]*?page\.reload[\s\S]*?assertLiteraryWorkspacePersisted/);
  assert.match(mobile, /waitForURL[\s\S]*?workspaceId/);
  assert.match(mobile, /不证明实际插图/);
});

test('LIT-009 finally必须真实删除且独立详情404，再关闭手机上下文', () => {
  assert.match(mobile, /catch \(error\)[\s\S]*?literary-mobile-original-hard-failure[\s\S]*?redactStableSmokeDiagnosticText[\s\S]*?throw error;[\s\S]*?finally/);
  assert.match(mobile, /finally[\s\S]*?deleteAndVerifyLiteraryWorkspace\(page\.request,[\s\S]*?finally[\s\S]*?mobileContext\.close\(\)/);
  assert.match(source, /import \{[^}]*deleteAndVerifyLiteraryWorkspace[^}]*\} from '\.\.\/utils\/stableSmokeLiterary\.mjs'/);
});

const article = '# 移动文章\n\n白桃放在蓝色长椅上。';
const fullText = `${article}\n\n[插图]: 白桃与长椅`;
const events = [
  { type: 'progress', message: '正在准备文章配图标记' },
  { type: 'delta', text: '正在识别正文中的场景' },
  { type: 'marker', index: 0, text: '白桃与长椅', anchor: '白桃放在蓝色长椅上。' },
  { type: 'done', fullText, markerCount: 1 },
];
const sse = items => items.map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join('');

test('LIT-009 读取原生SSE的真实阶段、增量与完整终态，不把配图标记称图片', () => {
  assert.deepEqual(assertRealLiteraryMarkerStream(sse(events), article), {
    fullText, markerCount: 1, eventTypes: ['progress', 'delta', 'marker', 'done'],
  });
  for (const broken of [
    events.slice(1), events.filter(event => !['delta', 'marker'].includes(event.type)),
    events.slice(0, -1), [...events, events.at(-1)], [...events, { type: 'delta', text: '过晚正文' }],
    [...events.slice(0, -1), { type: 'error', message: '不可用' }],
    [...events.slice(0, -1), { type: 'done', fullText: article }],
    [...events.slice(0, -1), { type: 'done', fullText: '[插图]: 另一篇正文' }],
    [...events.slice(0, -1), { type: 'done', fullText, markerCount: 0 }],
    [...events.slice(0, -1), { type: 'done', fullText }],
  ]) assert.throws(() => assertRealLiteraryMarkerStream(sse(broken), article), /LIT-009/);
  assert.throws(() => assertRealLiteraryMarkerStream('data: invalid\n\n', article), /无法解析/);
});

const workspaceId = 'abcdef0123456789abcdef0123456789';
const title = 'stsmk-own-run-移动文学-r0';
const expected = { workspaceId, title, article, fullText };
const workspace = { id: workspaceId, title, articleContent: article, articleContentWithMarkers: fullText };
test('LIT-009 同workspace、标题、原文、标记全文必须精确相等，截断或别的作品均红', () => {
  assert.equal(assertLiteraryWorkspacePersisted({ workspace }, expected), workspace);
  for (const mutation of [
    { id: 'other' }, { title: '旧作品' }, { articleContent: article.slice(0, -1) },
    { articleContentWithMarkers: fullText.slice(0, -1) }, { articleContentWithMarkers: '' },
  ]) assert.throws(() => assertLiteraryWorkspacePersisted({ workspace: { ...workspace, ...mutation } }, expected), /LIT-009/);
  assert.throws(() => assertLiteraryWorkspacePersisted({}, expected), /同一工作区/);
});

function cleanupFixture({ deleteOk = true, success = true, deleted = true, status = 404 } = {}) {
  const calls = [];
  const request = {
    delete: async (path, options) => {
      calls.push({ method: 'DELETE', path, options });
      return { ok: () => deleteOk, json: async () => ({ success, data: { deleted } }) };
    },
    get: async (path, options) => { calls.push({ method: 'GET', path, options }); return { status: () => status }; },
  };
  return { request, calls };
}

test('LIT-009 清理真实调用DELETE与独立detail GET，200删除回执不能替代404', async () => {
  const options = { workspaceId, headers: { Authorization: 'fixture-only' }, timeout: 60_000 };
  const { request, calls } = cleanupFixture();
  assert.deepEqual(await deleteAndVerifyLiteraryWorkspace(request, options), { workspaceId, deleted: true, detailStatus: 404 });
  assert.deepEqual(calls, [
    { method: 'DELETE', path: `/api/literary-agent/workspaces/${workspaceId}`, options: { headers: options.headers, timeout: 60_000 } },
    { method: 'GET', path: `/api/literary-agent/workspaces/${workspaceId}/detail`, options: { headers: options.headers, timeout: 60_000 } },
  ]);
  for (const broken of [{ deleteOk: false }, { success: false }, { deleted: false }, { status: 200 }, { status: 403 }, { status: 500 }]) {
    await assert.rejects(() => deleteAndVerifyLiteraryWorkspace(cleanupFixture(broken).request, options), /LIT-009/);
  }
  await assert.rejects(() => deleteAndVerifyLiteraryWorkspace(request, { ...options, workspaceId: '../other' }), /标识无效/);
});

const singleImageStart = source.indexOf("test('[LIT-006]");
const singleImageBody = source.slice(singleImageStart, source.indexOf("test('[LIT-007]", singleImageStart));
function assertSingleImageWiring(body) {
  for (const expression of [/createLiterarySingleImagePolicy/, /policy\.inspect/, /route\.abort\('blockedbyclient'\)/,
    /自动投稿已关闭/, /publication\.click\(\)/, /minimumSizes/, /assertRealLiteraryMarkerStream/,
    /\.marker-status--parsed/, /readLiterarySingleImagePrompt\(before/, /literary-marker-before-image/, /literary-image-run-created/,
    /literary-image-asset-created/, /readLiteraryImagePlacement/, /assertLiteraryImageInsertion/,
    /assertDefaultAspectArtifact/, /waitForGatewayLog\(request, `\$\{imageRunId\}-0-0`\)/,
    /cleanupTrackedFixture/, /kind: 'asset'/, /kind: 'run'/, /deleteAndVerifyLiteraryWorkspace/,
    /policy\.assertNoViolations/]) assert.match(body, expression);
  assert.equal((body.match(/name: '生成配图标记', exact: true \}\)\.click\(\)/g)||[]).length,1);
  assert.equal((body.match(/name: '生成图片', exact: true \}\)\.click\(\)/g)||[]).length,1);
  assert.doesNotMatch(body,/name: '一键生图'|\.fulfill\(|\.selectOption\(|window\.fetch\s*=|page\.request\.(?:put|patch)\(/);
  assert.ok(body.indexOf('policy.inspect') < body.indexOf('loginAndReadToken'));
  assert.ok(body.indexOf('literary-image-run-created') < body.indexOf("name: '生成图片'"));
  assert.match(body,/persistedTitle = uploaded\.workspace\.title/);
  assert.match(body,/page\.reload[\s\S]*?verifyInsertion\(\)/);
  assert.ok(body.indexOf('literary-image-terminal-state') >= 0 && body.indexOf('literary-image-terminal-state') < body.indexOf('await assertImageArtifact(page, generated.detail)'), '失败终态必须在产物断言抛错前保存');
  assert.ok(body.indexOf('literary-image-failure-before-cleanup') >= 0 && body.indexOf('literary-image-failure-before-cleanup') < body.indexOf('let discoveryError'), '失败页面必须在finally回收前取证');
}
test('LIT-006 原case消费真实页面、单次预算、无投稿、精确路由、插入与完整清理，缺接线必须红',()=>{
  assertSingleImageWiring(singleImageBody);
  for(const token of ['policy.inspect','readLiterarySingleImagePrompt','literary-marker-before-image','readLiteraryImagePlacement','assertLiteraryImageInsertion','cleanupTrackedFixture','literary-image-run-created','literary-image-asset-created','literary-image-terminal-state','literary-image-failure-before-cleanup']) {
    assert.throws(()=>assertSingleImageWiring(singleImageBody.replaceAll(token,'missingBinding')));
  }
});

test('LIT-006 f711实际标记只存index/text时仍按页面既有缓存路径取本轮真实prompt，不要求虚构planItemJson',()=>{
  const expected={workspaceId:'a'.repeat(32),title:'stsmk-literary.md',article:'前段\n\n后段',fullText:'前段\n\n[插图]: 蓝色长椅\n\n后段',markerIndex:0};
  const detail={workspace:{id:expected.workspaceId,title:expected.title,articleContent:expected.article,articleContentWithMarkers:expected.fullText,articleWorkflow:{phase:2,markers:[{index:0,text:'蓝色长椅',planItem:null,draftText:null,status:null}]}}};
  assert.equal(detail.workspace.articleWorkflow.markers[0].planItem?.prompt,undefined); // 旧真实失败点：不是字段改名。
  assert.deepEqual(readLiterarySingleImagePrompt(detail,expected),{markerIndex:0,prompt:'蓝色长椅',source:'text'});
  for(const [patch,source]of [[{draftText:'蓝色长椅'},'draftText'],[{draftText:'蓝色长椅',planItem:{prompt:'蓝色长椅',count:1,size:'1024x1024'}},'planItem.prompt']]){
    const candidate=structuredClone(detail);Object.assign(candidate.workspace.articleWorkflow.markers[0],patch);
    assert.deepEqual(readLiterarySingleImagePrompt(candidate,expected),{markerIndex:0,prompt:'蓝色长椅',source});
  }
  for(const change of [
    value=>{value.workspace.id='b'.repeat(32);},value=>{value.workspace.articleContentWithMarkers+='篡改';},
    value=>{value.workspace.articleWorkflow.phase=1;},value=>{value.workspace.articleWorkflow.markers=[];},
    value=>{value.workspace.articleWorkflow.markers.push({...value.workspace.articleWorkflow.markers[0]});},
    value=>{value.workspace.articleWorkflow.markers[0].text='其他标记';},
    value=>{value.workspace.articleWorkflow.markers[0].draftText='不同提示词';},
    value=>{value.workspace.articleWorkflow.markers[0].planItem={prompt:'不同提示词'};},
    value=>{value.workspace.articleWorkflow.markers[0].planItem='{"prompt":"蓝色长椅"}';},
    value=>{value.workspace.articleWorkflow.markers[0].text='';value.workspace.articleWorkflow.markers[0].planItemJson='{"prompt":"蓝色长椅"}';},
  ]){const broken=structuredClone(detail);change(broken);assert.throws(()=>readLiterarySingleImagePrompt(broken,expected),/LIT-00[69]/);}
  assert.throws(()=>readLiterarySingleImagePrompt(detail,{...expected,markerIndex:1}),/LIT-006/);
  const second=structuredClone(detail);second.workspace.articleContentWithMarkers+='\n\n[插图]: 红色落叶';second.workspace.articleWorkflow.markers.push({index:1,text:'红色落叶'});
  assert.deepEqual(readLiterarySingleImagePrompt(second,{...expected,fullText:second.workspace.articleContentWithMarkers,markerIndex:1}),{markerIndex:1,prompt:'红色落叶',source:'text'});
});

const illustrationScope={workspaceId:'a'.repeat(32),article:'# 文章\n\n前段\n\n后段',chatModelId:'chat-default',imageModelId:'image-default',platformId:'logical-model',markerIndex:0,prompt:'蓝色长椅',minimumSizes:['1024x1024'],publicationDisabled:true};
const markerPath=`/api/visual-agent/image-master/workspaces/${illustrationScope.workspaceId}/article/generate-markers`;
const markerInput={articleContent:illustrationScope.article,modelId:illustrationScope.chatModelId};
const imageInput={workspaceId:illustrationScope.workspaceId,appKey:'literary-agent',modelId:'image-default',platformId:'logical-model',articleMarkerIndex:0,maxConcurrency:1,size:'1024x1024',items:[{prompt:'蓝色长椅',count:1,size:'1024x1024'}]};
const imagePolicy=()=>{const policy=createLiterarySingleImagePolicy('stsmk-literary-fixture');policy.configure(illustrationScope);return policy;};
test('LIT-006 单卡预算允许真实1chat+1image，第二次和投稿尝试在发送前变红',()=>{
  const policy=imagePolicy();
  assert.equal(policy.inspect('POST',markerPath,markerInput),true);
  assert.equal(policy.inspect('POST','/api/literary-agent/image-gen/runs',imageInput),true);
  policy.assertNoViolations();
  for(const [path,body]of [[markerPath,markerInput],['/api/literary-agent/image-gen/runs',imageInput],['/api/submissions',{workspaceId:illustrationScope.workspaceId}],['/api/visual-agent/image-gen/plan',{text:'意图解析'}]]){
    const scoped=imagePolicy();scoped.inspect('POST',markerPath,markerInput);scoped.inspect('POST','/api/literary-agent/image-gen/runs',imageInput);
    assert.equal(scoped.inspect('POST',path,body),false);assert.throws(()=>scoped.assertNoViolations(),/LIT-006/);
  }
});
test('LIT-006 错作品/默认/标记/提示词/数量/大档/未关投稿/缺真实marker均不能发送',()=>{
  for(const patch of [{workspaceId:'b'.repeat(32)},{modelId:'manual-other'},{platformId:'other'},{articleMarkerIndex:1},{maxConcurrency:2},{size:'2048x2048'},
    {items:[{...imageInput.items[0],prompt:'不同提示词'}]}, {items:[{...imageInput.items[0],count:2}]}, {items:[imageInput.items[0],imageInput.items[0]]}]){
    const policy=imagePolicy();policy.inspect('POST',markerPath,markerInput);
    assert.equal(policy.inspect('POST','/api/literary-agent/image-gen/runs',{...imageInput,...patch}),false);assert.throws(()=>policy.assertNoViolations());
  }
  const unclosed=imagePolicy();unclosed.configure({publicationDisabled:false});unclosed.inspect('POST',markerPath,markerInput);assert.equal(unclosed.inspect('POST','/api/literary-agent/image-gen/runs',imageInput),false);
  assert.equal(imagePolicy().inspect('POST','/api/literary-agent/image-gen/runs',imageInput),false);
  for(const [path,body]of [[markerPath,{...markerInput,modelId:'other'}],['/api/visual-agent/image-master/workspaces/'+ 'b'.repeat(32)+'/article/generate-markers',markerInput]])assert.equal(imagePolicy().inspect('POST',path,body),false);
});

test('LIT-006 run和资产创建附件均须被canonical逐项覆盖，缺任一个不能洗绿',()=>{
  const inspectionRunId='stsmk-literary-fixture',runId='b'.repeat(32),assetId='c'.repeat(32);
  const items=[{name:'literary-workspace-created',body:JSON.stringify({inspectionRunId,workspaceId:illustrationScope.workspaceId})},
    {name:'literary-image-run-created',body:JSON.stringify({inspectionRunId,runId})},{name:'literary-image-asset-created',body:JSON.stringify({inspectionRunId,assetId})}];
  const known=knownCreatedResources(items,inspectionRunId);assert.equal(known.length,3);
  const resources=known.map((row,i)=>({...row,kind:['workspace','run','asset'][i],readbackStatus:404}));
  const receipt={schemaVersion:1,inspectionRunId,environment:'production',testId:'original-LIT006',retry:0,resources,errors:[]};
  const scope={inspectionRunId,environment:'production',testId:'original-LIT006',retry:0,knownResources:known};
  assert.equal(validCleanupReceipt(receipt,scope),true);
  for(const resource of resources)assert.equal(validCleanupReceipt({...receipt,resources:resources.filter(row=>row!==resource)},scope),false);
  assert.equal(validCleanupReceipt({...receipt,resources:resources.map(row=>({...row,readbackStatus:200}))},scope),false);
});

test('LIT-006 离线真实DOM验证图片位于原段落之间，错误位置/截断/错run/未解码均红',async()=>{
  const require=createRequire(new URL('../../e2e/package.json',import.meta.url));
  const {chromium}=require('@playwright/test');const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();const url='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>');
    const fullText='# 文章\n\n前段\n\n[插图]: 蓝色长椅\n\n后段';
    const runId='b'.repeat(32),assetId='c'.repeat(32),workspaceId=illustrationScope.workspaceId;
    // f711的真实单卡结构：只有已解析卡可进入本例，不使用全局“一键生图”。
    await page.setContent('<div data-tour-id="literary-editor-root"><div class="surface-inset"><div class="marker-card-wrap"><span class="marker-card-title">配图 1</span><div class="marker-status marker-status--idle">等待</div></div><button>生成图片</button></div><div class="surface-inset"><div class="marker-card-wrap"><span class="marker-card-title">配图 2</span><div class="marker-status marker-status--parsed">已解析</div></div><button>生成图片</button></div></div>');
    const parsedCard=page.locator('[data-tour-id="literary-editor-root"] .surface-inset:has(> .marker-card-wrap)').filter({has:page.locator('.marker-status--parsed')}).first();
    assert.equal(await parsedCard.locator('.marker-card-title').innerText(),'配图 2');
    assert.equal(await parsedCard.getByRole('button',{name:'生成图片',exact:true}).count(),1);
    assert.equal(Number((await parsedCard.locator('.marker-card-title').innerText()).match(/配图\s*(\d+)/)[1])-1,1);
    const expected={workspaceId,title:'stsmk-literary-fixture.md',article:illustrationScope.article,fullText,markerIndex:0,runId};
    const detail={workspace:{id:workspaceId,title:expected.title,articleContent:expected.article,articleContentWithMarkers:fullText,
      articleWorkflow:{doneImageCount:1,assetIdByMarkerIndex:{'0':assetId},markers:[{index:0,text:'蓝色长椅',status:'done',runId}]}},assets:[{id:assetId,workspaceId,articleInsertionIndex:0,url}]};
    await page.setContent(`<div data-tour-id="literary-editor-content"><h1>文章</h1><p>前段</p><p><img data-marker-idx="0" src="${url}"></p><p>后段</p></div>`);
    const content=page.locator('[data-tour-id="literary-editor-content"]');
    const placement=await readLiteraryImagePlacement(content,0);assert.equal(assertLiteraryImageInsertion(detail,expected,placement).assetId,assetId);
    for(const patch of [{width:0},{src:'another-image'},{beforeText:''},{afterText:''},{allText:'前段'}])assert.throws(()=>assertLiteraryImageInsertion(detail,expected,{...placement,...patch}));
    for(const mutate of [d=>d.workspace.articleContent='截断',d=>d.workspace.title='另一篇',d=>d.workspace.articleWorkflow.markers[0].runId='wrong',d=>d.workspace.articleWorkflow.doneImageCount=2,d=>d.assets[0].articleInsertionIndex=1]){const d=structuredClone(detail);mutate(d);assert.throws(()=>assertLiteraryImageInsertion(d,expected,placement));}
    await page.locator('img').evaluate(img=>img.closest('[data-tour-id]').append(img));
    const misplaced=await readLiteraryImagePlacement(content,0);
    assert.throws(()=>assertLiteraryImageInsertion(detail,expected,misplaced),/错误段落/);
    await page.locator('img').evaluate(img=>img.remove());
    await assert.rejects(()=>readLiteraryImagePlacement(content,0),/对应位置/);
  } finally {await browser.close();}
});
