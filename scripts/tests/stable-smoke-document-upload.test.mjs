import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findDocumentUploadCard, observeDocumentUploadPhases, readDocumentUploadView, releaseDocumentUploadResponse } from '../../e2e/utils/stableSmokeDocumentUpload.mjs';

const fileName = 'stsmk-own-progress-长文件名.txt';
function fixture({ modern = false, phase = 'uploading', duplicate = false, text, titleFile = fileName } = {}) {
  const expectedTitle = `${phase === 'uploading' ? '正在上传' : '正在解析'} ${titleFile}`;
  const card = {
    count: async () => 1, waitFor: async () => {},
    innerText: async () => text ?? `${expectedTitle}\n${phase === 'uploading' ? '99%' : '解析中 · 已等待 1 秒'}`,
    getByText: value => ({ count: async () => value === expectedTitle ? 1 : 0 }),
  };
  const title = { count: async () => duplicate ? 2 : 1, waitFor: async () => {}, locator: () => ({ locator: () => card }) };
  return { card, page: {
    getByText: value => { assert.equal(value, expectedTitle); return title; },
    getByTestId: value => { assert.equal(value, 'document-upload-progress'); return { ...card, count: async () => modern ? 1 : 0 }; },
  } };
}

test('REG-stsmk-file-phase-observer-001 新卡优先testid，1678旧卡按同一本轮完整文件名定位，不把缺hook当无UI', async () => {
  for (const modern of [false, true]) {
    const { page, card } = fixture({ modern });
    const found = await findDocumentUploadCard(page, { fileName, phase: 'uploading' });
    assert.deepEqual(await readDocumentUploadView(found, { fileName, phase: 'uploading' }), { phase: 'uploading', percent: 99 });
    if (!modern) assert.equal(found, card);
  }
  const inline = fixture({ text: `正在上传 ${fileName}99%` });
  assert.equal((await readDocumentUploadView(inline.card, { fileName, phase: 'uploading' })).percent, 99);
  // 旧执行体只认testid，在同一1678旧卡夹具上为红；修正定位后同一真实卡可观察。
  await assert.rejects(async () => assert.equal(await fixture().page.getByTestId('document-upload-progress').count(), 1));
});

test('REG-stsmk-file-phase-observer-001 完整文件名、唯一卡和真实阶段不可放宽；99%和其他模块解析文字仍红', async () => {
  await assert.rejects(() => findDocumentUploadCard(fixture({ duplicate: true }).page, { fileName, phase: 'uploading' }), /唯一/);
  const duplicateCards = fixture({ modern: true });
  duplicateCards.page.getByTestId = () => ({ count: async () => 2 });
  await assert.rejects(() => findDocumentUploadCard(duplicateCards.page, { fileName, phase: 'uploading' }), /多张进度卡/);
  for (const options of [
    { phase: 'parsing', text: `正在解析 ${fileName}\n99%` },
    { phase: 'parsing', text: `正在解析 ${fileName}\n正在解析短视频链接` },
    { phase: 'parsing', titleFile: 'stsmk-other.txt' },
    { phase: 'uploading', text: `正在上传 ${fileName}\n101%` },
  ]) {
    const { card } = fixture(options);
    await assert.rejects(() => readDocumentUploadView(card, { fileName, phase: options.phase }));
  }
  await assert.rejects(() => findDocumentUploadCard(fixture().page, { fileName: '真实用户文档.txt', phase: 'uploading' }), /本轮完整文件名/);
});

test('REG-stsmk-file-phase-observer-001 明确解析阶段必须提供同卡等待秒数，读数可用于机械递增断言', async () => {
  const { card } = fixture({ phase: 'parsing' });
  assert.deepEqual(await readDocumentUploadView(card, { fileName, phase: 'parsing' }), { phase: 'parsing', parsingSeconds: 1 });
  card.innerText = async () => `正在解析 ${fileName}\n解析中 · 已等待 2 秒`;
  assert.equal((await readDocumentUploadView(card, { fileName, phase: 'parsing' })).parsingSeconds, 2);
});

test('REG-stsmk-file-phase-observer-001 阶段失败仍fail并先释放原回调，后续可取真实终态；释放失败不吞掉', async () => {
  const events = [];
  const result = await observeDocumentUploadPhases({ observe: async () => { events.push('phase'); throw Error('原解析阶段缺失'); }, onFailure: async () => events.push('failure-evidence'), releaseResponse: async () => events.push('release') });
  events.push('real-terminal-observation');
  assert.equal(result.status, 'fail'); assert.match(result.failure.message, /原解析阶段缺失/);
  assert.deepEqual(events, ['phase', 'failure-evidence', 'release', 'real-terminal-observation']);
  const green = await observeDocumentUploadPhases({ observe: async () => {}, releaseResponse: async () => {} });
  assert.equal(green.status, 'pass'); assert.equal(green.failure, null);
  await assert.rejects(() => observeDocumentUploadPhases({ observe: async () => {}, releaseResponse: async () => { throw Error('release failed'); } }), /release failed/);
  const evidenceError = await observeDocumentUploadPhases({ observe: async () => { throw Error('stage red'); }, onFailure: async () => { throw Error('screenshot failed'); }, releaseResponse: async () => {} });
  assert.equal(evidenceError.status, 'fail'); assert.equal(evidenceError.failure.message, 'stage red'); assert.equal(evidenceError.evidenceFailure, 'screenshot failed');
});

test('REG-stsmk-file-phase-observer-001 释放只调用既有浏览器函数，不替造网络/进度/正文', async () => {
  const previous = globalThis.window;
  let releases = 0;
  try {
    globalThis.window = { __stableSmokeResumeDocumentUpload: () => { releases++; } };
    await releaseDocumentUploadResponse({ evaluate: async fn => fn() });
    assert.equal(releases, 1);
    globalThis.window = {};
    await assert.rejects(() => releaseDocumentUploadResponse({ evaluate: async fn => fn() }), /释放函数缺失/);
  } finally { globalThis.window = previous; }
});

test('REG-stsmk-file-phase-observer-001 原FILE003消费语义守卫，阶段红不短路产物/刷新，清理回读独立', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const body = source.split("test('[FILE-003] 文件上传后明确切换解析阶段并回读结果'")[1].split("test('[FILE-004][FILE-008]")[0];
  assert.match(body, /findDocumentUploadCard\(/); assert.match(body, /observeDocumentUploadPhases\(/);
  assert.match(body, /expect\.soft\(phaseResult\.status[\s\S]*?\.toBe\('pass'\)/);
  assert.match(body, /readDocumentUploadView\([\s\S]*?toBeGreaterThan\(initialParsingSeconds\)/);
  assert.match(body, /releaseResponse:[\s\S]*?releaseControlledResponse/);
  assert.match(body, /onFailure:[\s\S]*?file-upload-phase-failure-before-release/);
  assert.match(body, /phaseResult[\s\S]*?const uploadResponse = await uploadResponsePromise[\s\S]*?page\.reload/);
  assert.match(body, /file-upload-cleanup/); assert.match(body, /storeReadback\.status\(\)\)\.toBe\(404\)/);
  assert.match(body, /searchParams\.get\('entry'\)\)\.toBe\(entryId\)/);
  assert.match(body, /entryReadback\.status\(\)\)\.toBe\(404\)/);
  assert.doesNotMatch(body, /99.*(?:===|toBe).*parsing/);
});
