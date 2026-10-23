import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { redactStableSmokeDiagnosticText } from '../../e2e/utils/stableSmokeDiagnostics.mjs';
import { assertDefaultJpegPrimary, assertJpegUploadRequest, assertDefaultJpegRequest, jpegReferencePrompt, submitDefaultJpegThroughUi } from '../../e2e/utils/stableSmokeJpegJourney.mjs';

const pool = { isDefault: true, code: 'existing-default', name: '明确配置型号' };
// 这里只验证原始字节合同；实际旅程用浏览器canvas产出且上传后真实decode。
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const asset = { sha256, url: 'https://example.invalid/stsmk-reference.jpg' };
const uploadRequest = { data: `data:image/jpeg;base64,${bytes.toString('base64')}` };
const request = { prompt: jpegReferencePrompt, size: '1024x1024', targetKey: 'owned-frame', modelId: pool.code, platformId: 'logical-model', expectedImageRefCount: 1, imageRefs: [{ refId: 1, assetSha256: sha256, url: asset.url }] };
const primary = { pool, logicalModelPublicId: pool.code, primaryProtocol: 'openai' };

test('REG-image-input-001 只接受当前具体默认的JPEG主路，不挑别的可用型号', () => {
  assert.doesNotThrow(() => assertDefaultJpegPrimary(primary));
  for (const mutation of [
    { pool: { ...pool, isDefault: false } }, { pool: { ...pool, name: '图片生成默认池' } },
    { logicalModelPublicId: 'other-healthy-openai' }, { primaryProtocol: 'openrouter-image' }, { primaryProtocol: undefined },
  ]) assert.throws(() => assertDefaultJpegPrimary({ ...primary, ...mutation }), /configuration\/jpeg-default/);
});

test('REG-image-input-001 JPEG真实POST字节、SHA和声明一致；错标PNG/改字节/换资产都红', () => {
  assert.deepEqual(assertJpegUploadRequest({ jpegBytes: bytes, request: uploadRequest, asset }), { sha256, bytes: bytes.length, mime: 'image/jpeg', extension: '.jpg' });
  for (const mutation of [
    { request: { data: uploadRequest.data.replace('image/jpeg', 'image/png') } },
    { request: { data: 'data:image/jpeg;base64,/9j/AA==' } },
    { asset: { ...asset, sha256: '0'.repeat(64) } },
    { jpegBytes: Buffer.from('not jpeg') },
  ]) assert.throws(() => assertJpegUploadRequest({ jpegBytes: bytes, request: uploadRequest, asset, ...mutation }));
});

test('REG-image-input-001 请求必须保持具体默认、1024、同一JPEG引用及精确数量', () => {
  const proof = { pool, selectedLabel: pool.name, request, referenceSha256: sha256 };
  assert.doesNotThrow(() => assertDefaultJpegRequest(proof));
  for (const mutation of [
    { modelId: 'another' }, { expectedImageRefCount: 0 }, { expectedImageRefCount: undefined },
    { imageRefs: [] }, { imageRefs: [...request.imageRefs, ...request.imageRefs] },
    { imageRefs: [{ ...request.imageRefs[0], assetSha256: '0'.repeat(64) }] },
    { size: '512x512' }, { targetKey: '' }, { prompt: '忽略参考图' },
  ]) assert.throws(() => assertDefaultJpegRequest({ ...proof, request: { ...request, ...mutation } }));
  assert.throws(() => assertDefaultJpegRequest({ ...proof, selectedLabel: '另一个型号' }));
});

function uiFixture(actualRequest = request, actualUpload = uploadRequest) {
  const events = [];
  let responseIndex = 0;
  const button = name => ({
    count: async () => 1, waitFor: async () => {}, and() { return this; },
    filter() { return this; }, innerText: async () => name === '尺寸比例' ? '1K · 1:1' : pool.name,
    click: async () => events.push(`click:${name}`),
  });
  const input = { count: async () => 1, fill: async text => { assert.equal(text, jpegReferencePrompt); events.push('fill:prompt'); } };
  const referenceImage = { count: async () => 1, waitFor: async () => {}, evaluate: async fn => { await fn({ decode: async () => events.push('decode:reference') }); } };
  const responses = [
    { path: '/api/visual-agent/image-master/workspaces/owned/assets', payload: { asset }, sent: actualUpload },
    { path: '/api/visual-agent/image-master/workspaces/owned/image-gen/runs', payload: { runId: 'owned-run' }, sent: actualRequest },
  ];
  const page = {
    url: () => 'https://example.invalid/visual-agent/owned',
    getByRole: (_role, { name }) => name === '投稿已开启（点击关闭）' ? { count: async () => 0 } : button(name),
    locator: selector => selector.includes('contenteditable') ? input : selector.includes('canvas-image') ? referenceImage : {},
    waitForEvent: async name => {
      assert.equal(name, 'filechooser');
      return { setFiles: async file => { assert.equal(file.name, 'stsmk-jpeg-reference.jpg'); assert.equal(file.mimeType, 'image/jpeg'); assert.deepEqual(file.buffer, bytes); events.push('choose:jpeg'); } };
    },
    waitForResponse: async predicate => {
      const item = responses[responseIndex++];
      const response = { ok: () => true, url: () => 'https://example.invalid' + item.path, json: async () => ({ success: true, data: item.payload }), request: () => ({ method: () => 'POST', postDataJSON: () => item.sent }) };
      assert.equal(predicate(response), true); return response;
    },
  };
  return { page, events };
}

test('REG-image-input-001 实际调用上传按钮/文件选择/发送，并捕获页面POST而非API代造', async () => {
  const { page, events } = uiFixture();
  const proof = await submitDefaultJpegThroughUi(page, { workspaceId: 'owned', pool, jpegBytes: bytes, onCreated: id => events.push('created:' + id), onUploaded: async value => { assert.equal(value.sha256, sha256); }, onSubmitted: async value => events.push('proof:' + value.runId) });
  assert.equal(proof.request.expectedImageRefCount, 1);
  assert.deepEqual(events, ['click:上传图片', 'choose:jpeg', 'decode:reference', 'fill:prompt', 'click:发送', 'created:owned-run', 'proof:owned-run']);
});

test('REG-image-input-001 请求断言失败前登记真实run供清理，并保留实际发送证据', async () => {
  const { page, events } = uiFixture({ ...request, expectedImageRefCount: 0 });
  await assert.rejects(() => submitDefaultJpegThroughUi(page, { workspaceId: 'owned', pool, jpegBytes: bytes, onCreated: id => events.push('created:' + id), onSubmitted: async value => events.push('observed:' + value.request.expectedImageRefCount) }), /jpeg\/reference/);
  assert.ok(events.includes('created:owned-run')); assert.ok(events.includes('observed:0'));
});

test('REG-image-input-001 页面上传错标或丢字节时在发送生图前失败', async () => {
  for (const actualUpload of [
    { data: uploadRequest.data.replace('image/jpeg', 'image/png') },
    { data: 'data:image/jpeg;base64,/9j/AA==' },
  ]) {
    const { page, events } = uiFixture(request, actualUpload);
    await assert.rejects(() => submitDefaultJpegThroughUi(page, { workspaceId: 'owned', pool, jpegBytes: bytes, onCreated: () => assert.fail('不应创建生成任务') }), /jpeg\/upload/);
    assert.ok(!events.includes('click:发送'));
  }
});

test('REG-image-input-001 仅缺数量声明可保留红项后继续观察，原POST保持缺失', async () => {
  const actualRequest = { ...request, expectedImageRefCount: undefined };
  const { page } = uiFixture(actualRequest);
  const failures = [];
  const result = await submitDefaultJpegThroughUi(page, {
    workspaceId: 'owned', pool, jpegBytes: bytes, onCreated: () => {},
    onMissingReferenceDeclaration: async proof => { failures.push({ actual: proof.request.expectedImageRefCount, expected: 1, verdict: 'fail' }); },
  });
  assert.deepEqual(failures, [{ actual: undefined, expected: 1, verdict: 'fail' }]);
  assert.equal(result.runId, 'owned-run'); assert.equal(actualRequest.expectedImageRefCount, undefined);
  await assert.rejects(() => submitDefaultJpegThroughUi(uiFixture(actualRequest).page, { workspaceId: 'owned', pool, jpegBytes: bytes, onCreated: () => {} }), /jpeg\/reference/);
});

test('REG-image-input-001 缺声明观察不得吞掉数量错/null或任一其他请求漂移', async () => {
  for (const mutation of [
    { expectedImageRefCount: 0 }, { expectedImageRefCount: null },
    ...[{ modelId: 'other' }, { imageRefs: [] }, { imageRefs: [{ ...request.imageRefs[0], url: '' }] },
      { imageRefs: [{ ...request.imageRefs[0], assetSha256: '0'.repeat(64) }] }, { prompt: '丢引用' }, { size: '512x512' }, { targetKey: '' }]
      .map(value => ({ ...value, expectedImageRefCount: undefined })),
  ]) {
    const { page } = uiFixture({ ...request, ...mutation });
    let observationCalls = 0;
    await assert.rejects(() => submitDefaultJpegThroughUi(page, { workspaceId: 'owned', pool, jpegBytes: bytes, onCreated: () => {}, onMissingReferenceDeclaration: async () => { observationCalls++; } }));
    assert.equal(observationCalls, 0, '其他漂移不得进入仅缺声明观察');
  }
});

test('REG-image-input-001 原JPEG旅程接真人入口且不另选模型，下载解码与网关合同不减', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const body = source.split("test('[VIS-003][REG-image-input-001]")[1].split("test('[MVIS-001]")[0];
  assert.match(body, /loginAndReadToken\(page, request, '\/'\)/);
  assert.match(body, /enterVisualFromHome\(page\)/); assert.match(body, /createDefaultWorkspaceThroughUi\(/);
  assert.match(body, /submitDefaultJpegThroughUi\(/); assert.match(body, /assertDefaultJpegPrimary\(/);
  assert.doesNotMatch(body, /createVisualWorkspace\(|STABLE_SMOKE_IMAGE_MODEL_ID|page\.request\.post\([\s\S]*?\/assets/);
  assert.match(body, /item\.publicId === pool\.code/); assert.match(body, /decodeDownloadedImageDimensions/);
  assert.match(body, /width: 1024, height: 1024/); assert.match(body, /field: 'image\[\]'/);
  assert.match(body, /log\.isFallback/); assert.match(body, /expectDeleteSucceeded/);
  assert.match(body, /onMissingReferenceDeclaration:[\s\S]*?expect\.soft\(proof\.request\.expectedImageRefCount,[\s\S]*?\)\.toBe\(1\)/);
  assert.match(body, /cleanupTrackedFixture\(page, token/);
  const helper = readFileSync(new URL('../../e2e/utils/stableSmokeJpegJourney.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /request\.(?:post|put)|\.goto\(|\.route\(|\.fulfill\(/);
});

test('REG-image-input-001 JPEG硬失败须先留脱敏原因，清理独立回读detail404', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const body = source.split("test('[VIS-003][REG-image-input-001]")[1].split("test('[MVIS-001]")[0];
  const catchBody = body.split('} catch (error) {')[1]?.split('} finally {')[0];
  assert.ok(catchBody, 'finally覆盖前必须保存原始业务硬失败');
  assert.match(catchBody, /testInfo\.attach\('jpeg-original-hard-failure'/);
  assert.match(catchBody, /redactStableSmokeDiagnosticText\(/);
  assert.match(catchBody, /throw error/);
  const cleanup = body.split('} finally {')[1];
  assert.match(cleanup, /kind: 'workspace', id: workspace\.id, path: `\/api\/visual-agent\/image-master\/workspaces\/\$\{workspace\.id\}\/detail`/);
  assert.match(cleanup, /kind: 'run', id: runId, path: `\/api\/visual-agent\/image-gen\/runs\/\$\{runId\}`/);
  assert.match(cleanup, /cleanupTrackedFixture\(page, token/);
  assert.doesNotMatch(cleanup, /get\(`\/api\/visual-agent\/image-master\/workspaces\/\$\{workspace\.id\}`/);
  assert.match(body, /expect\.soft\(completed\.detail\.run\.expectedImageRefCount,[\s\S]*?\)\.toBe\(1\)/);
  assert.match(body, /expect\(completed\.detail\.run\.imageRefs\)\.toHaveLength\(1\)/);
  assert.match(body, /expect\(completed\.detail\.run\.imageRefs\?\.\[0\]\.assetSha256\)\.toBe\(created\.reference\.sha256\)/);
  assert.match(body, /width: 1024, height: 1024/);
  assert.match(body, /field: 'image\[\]'/);
});

test('REG-image-input-001 真实JPEG catch在finally再失败前仍保留原硬断言与脱敏回执', async () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const body = source.split("test('[VIS-003][REG-image-input-001]")[1].split("test('[MVIS-001]")[0];
  const catchBody = body.split('} catch (error) {')[1].split('} finally {')[0];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('testInfo', 'error', 'workspace', 'runId', 'redactStableSmokeDiagnosticText', catchBody);
  const original = new Error('原始imageRefs硬断言失败，token=offline-canary');
  const cleanup = new Error('后续清理失败');
  const attachments = [];
  await assert.rejects(async () => {
    try {
      await execute({ attach: async (name, value) => attachments.push({ name, body: value.body }) }, original, { id: 'own-workspace' }, 'own-run', redactStableSmokeDiagnosticText);
    } finally { throw cleanup; }
  }, error => error === cleanup);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].name, 'jpeg-original-hard-failure');
  assert.match(attachments[0].body, /原始imageRefs硬断言失败/);
  assert.doesNotMatch(attachments[0].body, /offline-canary/);
  assert.equal(JSON.parse(attachments[0].body).workspaceId, 'own-workspace');
});
