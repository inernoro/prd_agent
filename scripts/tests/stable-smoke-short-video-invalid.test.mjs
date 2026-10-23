import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installInvalidShortVideoRunGuard, observeInvalidShortVideoInput } from '../../e2e/utils/stableSmokeInvalidShortVideo.mjs';
import { collectPlaywrightCases } from '../stable-smoke-results.mjs';

const specUrl = new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url);
const title = '[PARSE-003][REG-short-video-input-001] 非法短视频文本在真实页面前置拒绝且不创建任务';

test('REG-short-video-input-001 真实恢复未执行，CDS机械绿不得核销PARSE004', () => {
  const source = readFileSync(specUrl, 'utf8');
  const naturalTitle = '[PARSE-004] 失效链接真实恢复需本轮自然样本';
  const childTitle = 'CDS 短视频非法API400与受控长文案机械子项（不计业务验收）';
  const start = source.indexOf(`  test('${naturalTitle}'`);
  assert.ok(start >= 0, '原PARSE004缺少真实自然样本未执行占位');
  const natural = source.slice(start, source.indexOf(`  test('${childTitle}'`, start));
  assert.match(natural, /test\.skip\(true,.*两环境.*自然失效链接样本/);
  assert.doesNotMatch(natural, /loginAndReadToken|request\.post|route\.fulfill/);
  assert.ok(source.includes(`  test('${childTitle}'`));
  for (const environment of ['cds', 'production']) {
    const report = { suites: [{ specs: [
      { title: naturalTitle, tests: [{ results: [{ status: 'skipped', annotations: [{ type: 'skip', description: '两环境缺本轮自然样本' }] }] }] },
      { title: childTitle, tests: [{ results: [{ status: 'passed' }] }] },
    ] }] };
    const rows = collectPlaywrightCases(report, environment);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].caseId, 'PARSE-004');
    assert.equal(rows[0].status, 'not-run');
    assert.match(rows[0].error, /自然样本/);
  }
});

function assertOriginalJourneyWiring(source) {
  const start = source.indexOf(`  test('${title}'`);
  assert.ok(start >= 0, '缺少原PARSE003/REG的独立真人执行体');
  const body = source.slice(start, source.indexOf('\n  test(', start + 1));
  assert.doesNotMatch(body, /requireShortVideoCleanupCapability|route\.fulfill|example\.test|PARSE-004/);
  assert.match(body, /loginAndReadToken\(page, request, '\/'\)/);
  assert.match(body, /getByRole\('button', \{ name: '知识库', exact: true \}\)\.click/);
  assert.match(body, /observeInvalidShortVideoInput\(/);
  assert.match(body, /scope\.assertNoRunRequests\(/);
  assert.match(body, /short-video-invalid-store-created/);
  assert.match(body, /short-video-invalid-cleanup|cleanupTrackedFixture/);
  assert.match(body, /storeReadbackStatus|kind: 'store'/);
  assert.doesNotMatch(body, /page\.goto|request\.post/);
  assert.match(body, /pendingCreation[\s\S]*?short-video-invalid-store-created[\s\S]*?name: '创建'/);
}

test('REG-short-video-input-001 原正式零任务旅程必须独立于失效链接夹具和合法任务清理能力', () => {
  assertOriginalJourneyWiring(readFileSync(specUrl, 'utf8'));
});

test('REG-short-video-input-001 删除真实消费、改直达或恢复mock混合均使原接线变红', () => {
  const source = readFileSync(specUrl, 'utf8');
  for (const [from, to] of [
    ['const proof = await observeInvalidShortVideoInput({', 'const proof = await fakeInvalidInput({'],
    ["await page.getByRole('button', { name: '知识库', exact: true }).click();", "await page.goto('/document-store');"],
    ["const scope = await installInvalidShortVideoRunGuard(page, inspectionRunId);", 'await requireShortVideoCleanupCapability(request, testInfo);'],
  ]) {
    assert.ok(source.includes(from));
    assert.throws(() => assertOriginalJourneyWiring(source.replaceAll(from, to)));
  }
});

test('REG-short-video-input-001 创建请求在网络前abort且即便页面仍显示toast也不能过；其它读不伪造', async () => {
  let handler, aborted = 0, continued = 0, removed = false;
  const page = {
    route: async (_pattern, fn) => { handler = fn; },
    unroute: async (_pattern, fn) => { assert.equal(fn, handler); removed = true; },
  };
  await assert.rejects(installInvalidShortVideoRunGuard(page, 'real-user'), /stsmk/);
  const scope = await installInvalidShortVideoRunGuard(page, 'stsmk-20261024-offline');
  const route = (method, path) => ({
    request: () => ({ method: () => method, url: () => `https://offline.invalid${path}` }),
    abort: async reason => { assert.equal(reason, 'blockedbyclient'); aborted++; },
    continue: async () => { continued++; },
  });
  await handler(route('GET', '/api/short-video-materials/runs/exact-owned-id'));
  assert.equal(continued, 1);
  scope.assertNoRunRequests();
  for (const path of ['/api/short-video-materials/runs', '/api/short-video-materials/runs/?x=1']) {
    await handler(route('POST', path));
  }
  assert.equal(aborted, 2);
  assert.equal(continued, 1);
  assert.throws(() => scope.assertNoRunRequests(), /任何任务创建请求/);
  assert.equal(scope.snapshot().runCreateRequests, 2);
  await scope.dispose();
  assert.equal(removed, true);
});

test('REG-short-video-input-001 保留CDS原API400边界断言且正式自然失效样本在认证前阻断', () => {
  const source = readFileSync(specUrl, 'utf8');
  const fixture = source.split("test('CDS 短视频非法API400与受控长文案机械子项（不计业务验收）'")[1].split("test('[VIDEO-001]")[0];
  assert.ok(fixture.indexOf("=== 'production'") < fixture.indexOf('loginAndReadToken'));
  assert.match(fixture, /videoUrl: '这不是链接'/);
  assert.match(fixture, /expect\(response\.status\(\)\)\.toBe\(400\)/);
  assert.match(fixture, /expect\(body\.success\)\.toBe\(false\)/);
  assert.match(fixture, /完整的公开视频链接/);
  const controller = readFileSync(new URL('../../prd-api/src/PrdAgent.Api/Controllers/Api/ShortVideoMaterialController.cs', import.meta.url), 'utf8');
  const handler = controller.split('CreateRun([FromBody]')[1].split('[HttpGet(')[0];
  assert.ok(handler.indexOf('if (!ShortVideoMaterialProcessor.IsHttpUrl(videoUrl))') < handler.indexOf('InsertOneAsync(run'));
  assert.match(handler, /return BadRequest[\s\S]*完整的公开视频链接/);
});

test('REG-short-video-input-001 零请求、恢复文案与保留原输入分别判定，任一缺失变红', async () => {
  for (const mode of ['valid', 'request', 'leak', 'clear']) {
    let handler, inputValue = '';
    const scope = await installInvalidShortVideoRunGuard({ route: async (_pattern, fn) => { handler = fn; }, unroute: async () => {} }, 'stsmk-20261024-unit');
    const action = () => observeInvalidShortVideoInput({
      input: { fill: async value => { inputValue = value; }, inputValue: async () => inputValue },
      submit: { click: async () => {
        if (mode === 'clear') inputValue = '';
        if (mode === 'request') await handler({ request: () => ({ method: () => 'POST', url: () => 'https://offline.invalid/api/short-video-materials/runs' }), abort: async () => {} });
      } },
      errorTitle: { waitFor: async () => {}, innerText: async () => '没有识别到短视频链接' },
      errorDetail: { waitFor: async () => {}, innerText: async () => '请粘贴抖音、TikTok、快手或 B 站等短视频链接' + (mode === 'leak' ? ' Provider HTTP 502' : '') }, scope,
    });
    if (mode === 'valid') assert.equal((await action()).runCreateRequests, 0);
    else await assert.rejects(action(), mode === 'request' ? /任何任务创建请求/ : mode === 'clear' ? /保留原输入/ : /HTTP|Provider/);
    await scope.dispose();
  }
});
