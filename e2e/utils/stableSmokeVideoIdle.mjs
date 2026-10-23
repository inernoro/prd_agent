import assert from 'node:assert/strict';

export const videoIdleRevision = '9b076cd909985f806d4c58aaa11007a712a68f81';
export const videoIdleStory = '小林在车站拾起一封信，读完后抬头看见晨光，微笑着走向站台。';
const idPattern = /^[a-f0-9]{32}$/;
const terminal = value => ['Cancelled', 'Failed', 'Completed'].includes(value);

export const makeVideoIdleAttachment = testInfo => (name, value) => testInfo.attach(name,
  { body: JSON.stringify(value), contentType: 'application/json' });

export async function assertVideoIdleDeployment(getVersion) {
  const response = await getVersion();
  assert.equal(response.status(), 200, '修复定向前必须读取公开版本');
  const value = await response.json();
  assert.equal(value.actualCommit, videoIdleRevision, '本定向只验已审9b修复，不猜当前版本');
  assert.equal(value.expectedCommit, videoIdleRevision);
  assert.equal(value.commitMatch, 'match');
  return { actualCommit: value.actualCommit, expectedCommit: value.expectedCommit, commitMatch: value.commitMatch };
}

export function createVideoIdleScope({ origin, inspectionRunId, title, story = videoIdleStory }) {
  const base = new URL(origin);
  assert.equal(base.protocol, 'https:');
  assert.match(inspectionRunId, /^stsmk-[a-z0-9-]+$/i);
  assert.ok(title.startsWith(`${inspectionRunId}-`));
  let ownerId = '', defaultModel = '', projectId = '', runId = '';
  let projectPosts = 0, projectPuts = 0, runPosts = 0;
  const blocked = [];
  const own = value => {
    assert.ok(ownerId && value.ownerAdminId === ownerId, '只读/清理必须绑定本轮登录owner');
    assert.equal(value.appKey, 'video-agent');
  };
  const projectInput = body => {
    assert.equal(body.title, title);
    assert.equal(body.sourceMarkdown, story);
    assert.equal(body.defaultVideoModel, defaultModel, '不得换掉页面自然选中的既有默认');
    assert.equal(body.styleDescription, '智能匹配');
    assert.deepEqual(body.assets, []);
    assert.ok(Array.isArray(body.timelineTracks) && body.timelineTracks.every(track => Array.isArray(track.clips) && track.clips.length === 0));
  };
  return {
    title, story,
    setOwner(value) { assert.ok(typeof value === 'string' && value.length > 0); ownerId = value; },
    setModels(models) {
      assert.ok(Array.isArray(models));
      defaultModel = models.find(model => model.healthStatus !== 'Unavailable')?.id || '';
      assert.ok(defaultModel, '既有页面没有可用默认时零创建停止，不能另选型号');
      return defaultModel;
    },
    registerProject(value) {
      own(value); assert.match(value.id || '', idPattern); projectId = value.id;
      return { inspectionRunId, projectId };
    },
    assertOwnedProject(value) { own(value); assert.equal(value.id, projectId); },
    assertOwnedRun(value) { own(value); assert.equal(value.id, runId); assert.equal(value.projectId, projectId); },
    assertProject(value) { own(value); assert.equal(value.id, projectId); projectInput(value); },
    registerRun(value) {
      assert.match(value.runId || '', idPattern); runId = value.runId;
      return { inspectionRunId, projectId, runId };
    },
    assertRun(value, { idle = false } = {}) {
      own(value); assert.equal(value.id, runId); assert.equal(value.projectId, projectId);
      assert.equal(value.mode, 'storyboard'); assert.equal(value.articleMarkdown, story);
      assert.equal(value.directVideoModel, defaultModel);
      assert.ok(!value.videoAssetUrl && !value.directVideoJobId && !value.latestExportTaskId && !value.exportRequested);
      assert.ok(Array.isArray(value.scenes));
      assert.ok(value.scenes.every(scene => !scene.videoUrl && !scene.jobId && !scene.offeringId && (!scene.versions || scene.versions.length === 0)), '本旅程不能提交视频或生成版本');
      if (idle) {
        assert.equal(value.status, 'Editing'); assert.equal(value.currentPhase, 'editing');
        assert.equal(value.phaseProgress, 100); assert.ok(value.scenes.length > 0);
        assert.ok(value.scenes.every(scene => scene.status === 'Draft' && scene.topic?.trim() && scene.prompt?.trim()));
      }
    },
    decide({ method, url, body }) {
      const target = new URL(url);
      if (!target.pathname.startsWith('/api/video-agent/')) return true;
      if (method === 'GET' && target.origin === base.origin) return true;
      try {
        assert.equal(target.origin, base.origin); assert.equal(target.search, '');
        if (method === 'POST' && target.pathname === '/api/video-agent/projects') {
          assert.equal(projectPosts, 0); assert.ok(ownerId && defaultModel); projectInput(body); projectPosts++; return true;
        }
        if (method === 'PUT' && projectId && target.pathname === `/api/video-agent/projects/${projectId}`) {
          assert.equal(projectPuts, 0); assert.equal(runPosts, 0); projectInput(body); projectPuts++; return true;
        }
        if (method === 'POST' && target.pathname === '/api/video-agent/runs') {
          assert.equal(runPosts, 0); assert.ok(projectId && projectPuts === 1);
          assert.deepEqual(Object.keys(body).sort(), ['mode', 'projectId']);
          assert.equal(body.projectId, projectId); assert.equal(body.mode, 'storyboard'); runPosts++; return true;
        }
        // Even known own scene/export/cancel writes are not browser actions in this Editing-only journey.
        throw Error('本次只允许新草稿、同草稿保存及唯一storyboard提交');
      } catch {
        blocked.push({ method, path: target.pathname }); return false;
      }
    },
    snapshot: () => ({ inspectionRunId, projectId, runId, defaultVideoModel: defaultModel,
      projectPosts, projectPuts, storyboardRunPosts: runPosts, blockedRequests: [...blocked],
      proofBoundary: '一个storyboard业务run，不等于一个计费attempt；实际网关重试/型号仍需原调用链证据。零视频提交只涵盖本次受控页面/原run状态。' }),
    resources: () => [
      ...(projectId ? [{ kind: 'video-project', id: projectId, path: `/api/video-agent/projects/${projectId}` }] : []),
      ...(runId ? [{ kind: 'video-run', id: runId, path: `/api/video-agent/runs/${runId}` }] : []),
    ],
    assertWrites() { assert.equal(projectPosts, 1); assert.equal(projectPuts, 1); assert.equal(runPosts, 1); assert.deepEqual(blocked, []); },
  };
}

export async function installVideoIdleScope(page, options) {
  const scope = createVideoIdleScope(options);
  const pattern = '**/api/video-agent/**';
  const handler = async route => {
    const request = route.request();
    let body;
    try { body = request.postDataJSON(); } catch { body = undefined; }
    if (scope.decide({ method: request.method(), url: request.url(), body })) await route.continue();
    else await route.abort('blockedbyclient');
  };
  await page.route(pattern, handler);
  return { ...scope, dispose: () => page.unroute(pattern, handler) };
}

async function unique(locator) {
  await locator.first().waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await locator.count(), 1, '真实页面操作锚点必须唯一');
  return locator;
}

async function envelope(response) {
  assert.equal(response.status(), 200, '本轮资源API必须成功');
  const body = await response.json(); assert.equal(body.success, true); return body.data;
}

export async function runVideoIdleUi({ page, scope, headers, dismissTutorial, attach, capture, getVersion }) {
  assert.equal(new URL(page.url()).pathname, '/', '必须从真实登录首页开始，不能深链替代导航');
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints), 0, '9b声明视频pc-only，本次仅桌面子合同');
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), false, 'Service Worker不得绕过本次页面写入护栏');
  const modelResponse = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/video-agent/models');
  const entry = page.locator('button.home-desk-tile')
    .filter({ has: page.getByText('视频创作智能体', { exact: true }) }).and(page.locator(':visible'));
  await (await unique(entry)).click();
  await page.waitForURL(url => url.pathname === '/video-agent');
  const defaultModel = scope.setModels(await envelope(await modelResponse));
  const studio = await unique(page.getByTestId('video-project-studio'));
  await (await unique(page.getByRole('button', { name: '新项目', exact: true }))).click();
  const name = page.getByLabel('项目名称', { exact: true });
  await page.waitForFunction(() => document.querySelector('input[aria-label="项目名称"]')?.value === '', undefined, { timeout: 30_000 });
  assert.equal(await name.inputValue(), '', '必须等新项目表单清空，不能覆盖已存在项目');
  await name.fill(scope.title);
  await page.getByLabel('文学稿内容', { exact: true }).fill(scope.story);
  await (await unique(page.getByRole('button', { name: '设置', exact: true }))).click();
  assert.equal(await page.getByLabel('视频模型', { exact: true }).inputValue(), defaultModel);
  await assertVideoIdleDeployment(getVersion);
  await capture({ name: 'video-idle-input', target: studio,
    caption: '桌面首页真实进入视频创作，输入本轮自有文稿并只读取自然默认；不证明视频生成或手机入口。' });
  const projectResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/video-agent/projects');
  await (await unique(page.getByTitle('保存草稿', { exact: true }))).click();
  const project = await envelope(await projectResponse);
  await attach('video-idle-project-created', scope.registerProject(project)); // Before any model action/assertion.
  scope.assertProject(project);
  // Save explicitly first so creation is registered before analyzeProject can issue its run POST.
  const runResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/video-agent/runs');
  await (await unique(page.getByRole('button', { name: '生成故事分镜', exact: true }))).click();
  await attach('video-idle-run-created', scope.registerRun(await envelope(await runResponse)));
  const readRun = () => page.request.get(`/api/video-agent/runs/${scope.snapshot().runId}`, { headers });
  const states = [];
  const deadline = Date.now() + 150_000;
  let run;
  do {
    run = await envelope(await readRun()); scope.assertRun(run);
    states.push({ status: run.status, phase: run.currentPhase, progress: run.phaseProgress });
    if (run.status === 'Editing') break;
    assert.ok(['Queued', 'Scripting'].includes(run.status), '自然拆镜失败必须红，不重提任务');
    assert.ok(Date.now() < deadline, '自然拆镜有界等待超时，不追加run');
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
  scope.assertRun(run, { idle: true });
  const editor = await unique(page.getByTestId('video-console'));
  await page.getByText('镜头可编辑', { exact: true }).waitFor({ state: 'visible' });
  assert.ok((await editor.innerText()).includes(run.scenes[0].topic));
  assert.equal(await page.getByRole('button', { name: '停止任务', exact: true }).count(), 0, '9b Editing无取消按钮，不能伪称按钮通过');
  await capture({ name: 'video-idle-editing', target: editor,
    caption: '唯一真实storyboard run自然进入分镜编辑，镜头有描述且没有视频版本；Editing没有停止按钮，取消仅另验API。' });
  const before = new URL(page.url());
  assert.equal(before.pathname, '/video-agent'); assert.equal(before.searchParams.get('run'), run.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissTutorial();
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), false);
  await unique(page.getByTestId('video-console'));
  const after = new URL(page.url());
  assert.equal(after.pathname + after.search + after.hash, before.pathname + before.search + before.hash);
  const restored = await envelope(await readRun()); scope.assertRun(restored, { idle: true });
  assert.deepEqual(restored.scenes.map(scene => ({ index: scene.index, topic: scene.topic, prompt: scene.prompt })),
    run.scenes.map(scene => ({ index: scene.index, topic: scene.topic, prompt: scene.prompt })));
  await page.getByText('镜头可编辑', { exact: true }).waitFor({ state: 'visible' });
  await capture({ name: 'video-idle-refresh', target: page.getByTestId('video-console'),
    caption: '刷新恢复同一run、同一项目及同一组分镜正文；仅VIDEO002/009子合同，不证明脚本创作、手机或关键帧/视频成片。' });
  scope.assertWrites();
  return { ...scope.snapshot(), states, restoredSameRun: true, cancelUiAvailable: false, deleteUiAvailable: false };
}

export async function removeVideoIdleResources({ scope, request, headers, assertCanonicalCleanup, attach }) {
  const known = scope.snapshot();
  let cancellation;
  const read = async path => request.get(path, { headers, timeout: 15_000 });
  if (known.storyboardRunPosts && !known.runId) throw Error('已尝试创建run但未取得精确ID，清理未知；不能靠project404冒充清完');
  if (known.projectPosts && !known.projectId) throw Error('已尝试创建project但未取得精确ID，清理未知');
  if (!scope.resources().length) return;
  await assertCanonicalCleanup(scope.resources(), async () => {
    if (known.runId) {
      const path = `/api/video-agent/runs/${known.runId}`;
      const initial = await read(path);
      if (initial.status() !== 404) {
        let run = await envelope(initial); scope.assertOwnedRun(run);
        if (!terminal(run.status)) {
          await envelope(await request.post(`${path}/cancel`, { headers, timeout: 15_000 }));
          const deadline = Date.now() + 60_000;
          do {
            run = await envelope(await read(path)); scope.assertOwnedRun(run);
            if (terminal(run.status)) break;
            assert.ok(Date.now() < deadline, '取消未收敛；不能继续DELETE或新收费旅程');
            await new Promise(resolve => setTimeout(resolve, 1000));
          } while (true);
        }
        cancellation = { inspectionRunId: known.inspectionRunId, projectId: known.projectId,
          runId: known.runId, status: run.status, cancelRequested: run.cancelRequested,
          endedAt: run.endedAt, proofBoundary: '原API取消内部佐证，不是Editing按钮验收' };
        await attach('video-idle-api-cancel', cancellation);
        // Delete even if the business result was Failed/Completed; the caller retains its original red.
        await envelope(await request.delete(`${path}?deleteEmptyProject=true`, { headers, timeout: 60_000 }));
      }
    }
    const path = `/api/video-agent/projects/${known.projectId}`;
    const project = await read(path);
    if (project.status() !== 404) {
      scope.assertOwnedProject(await envelope(project));
      await envelope(await request.delete(path, { headers, timeout: 60_000 }));
    }
  });
  return cancellation;
}
