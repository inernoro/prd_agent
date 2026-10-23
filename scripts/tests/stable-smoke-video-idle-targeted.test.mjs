import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createVideoIdleScope, installVideoIdleScope, assertVideoIdleDeployment, videoIdleRevision, videoIdleStory, removeVideoIdleResources } from '../../e2e/utils/stableSmokeVideoIdle.mjs';

const inspectionRunId = 'stsmk-20261024-offline-video';
const projectId = 'a'.repeat(32), runId = 'b'.repeat(32), ownerId = 'synthetic-owner';
const title = `${inspectionRunId}-video-idle`;
const project = { id: projectId, ownerAdminId: ownerId, appKey: 'video-agent', title,
  sourceMarkdown: videoIdleStory, defaultVideoModel: 'configured-default', styleDescription: '智能匹配', assets: [], timelineTracks: [{ clips: [] }] };
const body = Object.fromEntries(Object.entries(project).filter(([key]) => !['id', 'ownerAdminId', 'appKey'].includes(key)));
const request = (method, path, value) => ({ method, url: `https://offline.invalid/api/video-agent/${path}`, body: value });
const ready = () => {
  const scope = createVideoIdleScope({ origin: 'https://offline.invalid', inspectionRunId, title });
  scope.setOwner(ownerId); scope.setModels([{ id: 'configured-default', healthStatus: 'Healthy' }, { id: 'other', healthStatus: 'Healthy' }]);
  assert.equal(scope.decide(request('POST', 'projects', body)), true);
  scope.registerProject(project);
  assert.equal(scope.decide(request('PUT', `projects/${projectId}`, body)), true);
  return scope;
};
const envelope = data => ({ status: () => 200, json: async () => ({ success: true, data }) });

test('9b部署版本必须actual/expected/match，旧版和漂移在认证前红', async () => {
  const good = { actualCommit: videoIdleRevision, expectedCommit: videoIdleRevision, commitMatch: 'match' };
  assert.equal((await assertVideoIdleDeployment(async () => ({ status: () => 200, json: async () => good }))).actualCommit, videoIdleRevision);
  for (const value of [{ ...good, actualCommit: 'f'.repeat(40) }, { ...good, expectedCommit: 'c'.repeat(40) }, { ...good, commitMatch: 'mismatch' }])
    await assert.rejects(assertVideoIdleDeployment(async () => ({ status: () => 200, json: async () => value })));
});

test('scope消费真实POST形状，只允许一次storyboard；second/direct/换型/scene/export均红', () => {
  const scope = ready();
  assert.equal(scope.decide(request('POST', 'runs', { projectId, mode: 'storyboard' })), true);
  scope.registerRun({ runId }); scope.assertWrites();
  for (const value of [request('POST', 'runs', { projectId, mode: 'storyboard' }), request('POST', 'runs', { projectId, mode: 'direct' }),
    request('POST', `runs/${runId}/scenes/0/render`), request('POST', `runs/${runId}/export`),
    request('PUT', `projects/${projectId}`, { ...body, defaultVideoModel: 'other' })]) assert.equal(scope.decide(value), false);
  assert.throws(() => scope.assertWrites());
  for (const payload of [{ projectId, mode: 'direct' }, { projectId, mode: 'storyboard', directVideoModel: 'other' }, { projectId: 'c'.repeat(32), mode: 'storyboard' }]) {
    const fresh = ready(); assert.equal(fresh.decide(request('POST', 'runs', payload)), false);
    assert.equal(fresh.snapshot().storyboardRunPosts, 0);
  }
});

test('真实路由handler在网络前abort，禁止项不会continue或被包装成绿', async () => {
  let handler, continued = 0, aborted = 0;
  const page = { route: async (_pattern, callback) => { handler = callback; }, unroute: async () => {} };
  const scope = await installVideoIdleScope(page, { origin: 'https://offline.invalid', inspectionRunId, title });
  scope.setOwner(ownerId); scope.setModels([{ id: 'configured-default', healthStatus: 'Healthy' }]);
  const route = value => ({ request: () => ({ method: () => value.method, url: () => value.url, postDataJSON: () => value.body }),
    continue: async () => { continued++; }, abort: async () => { aborted++; } });
  await handler(route(request('POST', 'projects', body))); scope.registerProject(project);
  await handler(route(request('PUT', `projects/${projectId}`, body)));
  await handler(route(request('POST', 'runs', { projectId, mode: 'storyboard' })));
  await handler(route(request('POST', 'runs', { projectId, mode: 'storyboard' })));
  await handler(route(request('POST', `runs/${runId}/scenes/0/render`)));
  assert.equal(continued, 3); assert.equal(aborted, 2);
  assert.throws(() => scope.assertWrites());
});

test('本轮资源归属/文稿/自然Editing/零视频产物为真实函数断言，任一漂移红', () => {
  const scope = ready(); scope.decide(request('POST', 'runs', { projectId, mode: 'storyboard' })); scope.registerRun({ runId });
  const run = { id: runId, projectId, ownerAdminId: ownerId, appKey: 'video-agent', mode: 'storyboard',
    articleMarkdown: videoIdleStory, directVideoModel: 'configured-default', status: 'Editing', currentPhase: 'editing', phaseProgress: 100,
    scenes: [{ index: 0, status: 'Draft', topic: '晨光', prompt: '车站', versions: [] }] };
  scope.assertProject(project); scope.assertRun(run, { idle: true });
  for (const delta of [{ ownerAdminId: 'foreign' }, { projectId: 'c'.repeat(32) }, { status: 'Failed' }, { directVideoModel: 'other' },
    { videoAssetUrl: 'https://offline.invalid/video' }, { scenes: [{ ...run.scenes[0], jobId: 'unexpected-video-job' }] }])
    assert.throws(() => scope.assertRun({ ...run, ...delta }, { idle: true }));
});

test('原执行前缀正式skip先于公开版本/auth/guard；只读接线不允许goto和不存在的data属性', async () => {
  const spec = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const start = spec.indexOf("test.describe('CDS视频闲置取消修复定向子证据'");
  const end = spec.indexOf("\n  test('[VIDEO-002][VIDEO-009] 移动端", start);
  assert.ok(start >= 0 && end > start);
  const source = spec.slice(start, end);
  let action, calls = 0;
  const skip = Error('production-skip');
  const register = (_name, _options, fn) => { action = fn; };
  register.describe = (_name, fn) => fn(); register.describe.configure = () => {};
  register.skip = condition => { if (condition) throw skip; };
  const trap = () => { calls++; throw Error('must not execute'); };
  vm.runInNewContext(source, { test: register, requiredEnv: () => 'production', assertVideoIdleDeployment: trap,
    installVideoIdleScope: trap, loginAndReadToken: trap });
  await assert.rejects(action({}, {}), error => error === skip); assert.equal(calls, 0);
  assert.match(source, /retries: 0/); assert.match(source, /loginAndReadToken\(page, request, '\/'\)/);
  assert.match(source, /runVideoIdleUi\(/); assert.match(source, /removeVideoIdleResources\(/);
  const helper = readFileSync(new URL('../../e2e/utils/stableSmokeVideoIdle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /page\.goto|route\.fulfill|selectOption|data-run-id|data-run-status|data-phase|data-progress/);
  assert.ok(helper.indexOf("attach('video-idle-project-created'") < helper.indexOf("name: '生成故事分镜'"));
});

test('无run孤立project也走正常DELETE和canonical；未知创建ID不能当清理绿', async () => {
  const scope = ready(); let deleted = false, canonical = false;
  const api = { get: async path => { assert.equal(path, `/api/video-agent/projects/${projectId}`); return envelope(project); },
    delete: async path => { assert.equal(path, `/api/video-agent/projects/${projectId}`); deleted = true; return envelope(true); } };
  await removeVideoIdleResources({ scope, request: api, headers: {}, attach: async () => {},
    assertCanonicalCleanup: async (rows, remove) => { assert.deepEqual(rows, scope.resources()); await remove(); canonical = true; } });
  assert.equal(deleted && canonical, true);
  const unknown = createVideoIdleScope({ origin: 'https://offline.invalid', inspectionRunId, title });
  unknown.setOwner(ownerId); unknown.setModels([{ id: 'configured-default', healthStatus: 'Healthy' }]);
  unknown.decide(request('POST', 'projects', body));
  await assert.rejects(removeVideoIdleResources({ scope: unknown }), /精确ID/);
});

test('取消与删除消费实际canonical函数，逐run/project404；仅DELETE200或残留仍红', async () => {
  const { cleanupAndReadBackResources } = await import('../../e2e/utils/stableSmokeCleanupSafety.mjs');
  for (const leaveRun of [false, true]) {
    const scope = ready(); scope.decide(request('POST', 'runs', { projectId, mode: 'storyboard' })); scope.registerRun({ runId });
    let run = { id: runId, projectId, ownerAdminId: ownerId, appKey: 'video-agent', mode: 'storyboard', articleMarkdown: videoIdleStory,
      directVideoModel: 'unexpected-default', status: 'Editing', scenes: [{ status: 'Draft', topic: '晨光', prompt: '车站', versions: [] }] };
    assert.throws(() => scope.assertRun(run), '业务默认漂移仍红，但必须继续清理已知自有ID');
    let existingProject = project, receipt, cancellations = 0;
    const missing = { status: () => 404 };
    const api = {
      get: async path => path === `/api/video-agent/runs/${runId}` ? (run ? envelope(run) : missing)
        : (existingProject ? envelope(existingProject) : missing),
      post: async path => { assert.equal(path, `/api/video-agent/runs/${runId}/cancel`); cancellations++;
        run = { ...run, status: 'Cancelled', cancelRequested: true, endedAt: '2026-10-24T00:00:00Z' }; return envelope(true); },
      delete: async path => { if (path.includes('/runs/')) { assert.equal(path, `/api/video-agent/runs/${runId}?deleteEmptyProject=true`); if (!leaveRun) run = null; existingProject = null; }
        else existingProject = null; return envelope(true); },
    };
    const execute = () => removeVideoIdleResources({ scope, request: api, headers: {}, attach: async () => {},
      assertCanonicalCleanup: (resources, remove) => cleanupAndReadBackResources({ resources, remove,
        read: async row => (await api.get(row.path)).status(), attach: async value => { receipt = value; },
        inspectionRunId, environment: 'cds', testId: 'offline-video', retry: 0 }) });
    if (leaveRun) { await assert.rejects(execute(), /清理回读未闭环/); assert.ok(receipt.errors.length > 0); }
    else { assert.equal((await execute()).status, 'Cancelled'); assert.deepEqual(receipt.resources.map(row => row.readbackStatus), [404, 404]); }
    assert.equal(cancellations, 1);
  }
});

 test('新视频project/run创建回执必须同时进入原清理熔断判据，漏run不能借project404核销', async () => {
  const {knownCreatedResources,cleanupFailureFromAttachments}=await import('../../e2e/utils/stableSmokeCleanupSafety.mjs');
  const created=[{name:'video-idle-project-created',body:JSON.stringify({inspectionRunId,projectId})},
    {name:'video-idle-run-created',body:JSON.stringify({inspectionRunId,projectId,runId})}];
  const known=knownCreatedResources(created,inspectionRunId);
  assert.deepEqual(known.map(row=>row.id),[projectId,runId]);
  assert.deepEqual(cleanupFailureFromAttachments(created,inspectionRunId).resourceIds,[projectId,runId]);
  const resources=known.map(row=>({...row,kind:row.id===projectId?'video-project':'video-run',readbackStatus:404}));
  const canonical={name:'stable-smoke-cleanup-receipt',body:JSON.stringify({schemaVersion:1,inspectionRunId,environment:'cds',testId:'video',retry:0,errors:[],resources})};
  assert.equal(cleanupFailureFromAttachments([...created,canonical],inspectionRunId),undefined);
  const missingRun={...canonical,body:JSON.stringify({...JSON.parse(canonical.body),resources:resources.slice(0,1)})};
  assert.ok(cleanupFailureFromAttachments([...created,missingRun],inspectionRunId));
});
