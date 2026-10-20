import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { collectPlaywrightCases, selectRequiredCaseIds } from '../stable-smoke-results.mjs';
import * as recording from '../../e2e/utils/stableSmokeRecording.mjs';
import { readRecordingTranscriptRows, validateRecordingTranscriptRows, assertRecordingTranscriptEquals, loadStableSmokeSpeechReference, validateSpeechReference, assertSpeechMatchesReference } from '../../e2e/utils/stableSmokeRecording.mjs';

function row(index, body, timestamp = '') {
  return {
    textContent: `${timestamp}Speaker ${body}`,
    getAttribute: name => name === 'data-transcript-row' ? String(index) : null,
    querySelectorAll: selector => selector === 'span.block.min-w-0.break-words' ? [{ textContent: body }]
      : selector === 'span.font-mono.tabular-nums' ? [{ textContent: timestamp }] : [],
  };
}
async function readRows(elements) {
  return readRecordingTranscriptRows({ locator: selector => {
    assert.equal(selector, '[data-transcript-row]');
    return { evaluateAll: async callback => callback(elements) };
  } });
}

test('REG-rec-transcript-body-001 正文与00:00和说话人严格分离，刷新不放宽原文相等', async () => {
  const body = 'The white peach is on the table.';
  const rows = await readRows([row(0, body, '00:00')]);
  assert.equal(rows[0].body, body);
  assert.equal(rows[0].timestamp, '00:00');
  assert.deepEqual(assertRecordingTranscriptEquals(rows, [body], { timestamps: 'required' }), { lineCount: 1, timestampCount: 1 });
  assert.throws(() => assertRecordingTranscriptEquals(rows, ['The white peaches are on the table.']), /不相等/);
  assert.throws(() => assertRecordingTranscriptEquals(rows, [body.toLowerCase()]), /不相等/);
  const clockInBody = await readRows([row(0, 'The clock reads 00:00.', '00:00')]);
  assertRecordingTranscriptEquals(clockInBody, ['The clock reads 00:00.']);
});

test('REG-rec-transcript-body-001 无时间戳及多句保留真实行序，不猜断句或只取首行', async () => {
  const rows = await readRows([row(0, 'First sentence.'), row(1, 'Second sentence.')]);
  assert.deepEqual(assertRecordingTranscriptEquals(rows, ['First sentence.', 'Second sentence.']), { lineCount: 2, timestampCount: 0 });
  assert.throws(() => assertRecordingTranscriptEquals(rows, ['First sentence.']), /不相等/);
  assert.throws(() => assertRecordingTranscriptEquals(rows, ['Second sentence.', 'First sentence.']), /不相等/);
  assert.throws(() => assertRecordingTranscriptEquals(rows, ['First sentence.', 'Second sentence.'], { timestamps: 'required' }), /时间戳未显示/);
});

test('REG-rec-transcript-body-001 缺正文、重复正文、错行号、时间倒退与格式错误均变红', () => {
  const valid = { index: 0, bodies: ['Actual original.'], timestamps: ['00:02'] };
  assert.throws(() => validateRecordingTranscriptRows([]), /没有/);
  for (const bad of [{ bodies: [] }, { bodies: ['A', 'B'] }, { bodies: [' '] }, { index: 1 }, { timestamps: [] }, { timestamps: ['00:70'] }, { timestamps: ['00:aa'] }]) {
    assert.throws(() => validateRecordingTranscriptRows([{ ...valid, ...bad }]));
  }
  assert.throws(() => validateRecordingTranscriptRows([valid, { index: 1, bodies: ['Next.'], timestamps: ['00:01'] }]), /倒退/);
});

test('REG-rec-transcript-body-001 选择器绑定当前组件实际正文与独立时间列', () => {
  const source = readFileSync(new URL('../../prd-admin/src/components/doc-browser/TranscriptKaraoke.tsx', import.meta.url), 'utf8');
  assert.match(source, /data-transcript-row=\{i\}/);
  assert.match(source, /className="block min-w-0 break-words">\{highlightKeyword\(s.text, keyword\)\}/);
  assert.match(source, /font-mono[^"\n]*tabular-nums/);
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /scripts\/tests\/\*\.test\.mjs/);
  assert.match(workflow, /'e2e\/utils\/stableSmoke\*\.mjs'/);
  for (const input of ['e2e/fixtures/stable-smoke-clear-speech.reference.json', 'e2e/fixtures/stable-smoke-clear-speech.wav.b64', 'prd-admin/src/components/doc-browser/TranscriptKaraoke.tsx']) {
    assert.ok(workflow.includes(`- '${input}'`), `仅改被守输入也须触发CI：${input}`);
  }
});

test('REG-rec-transcript-body-001 原REC四项旅程真实消费独立参考、逐行正文与刷新清理合同', () => {
  const spec = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const title = 'test(recordingJourneyPlan.title';
  assert.equal(spec.split(title).length - 1, 1, '保留原唯一旅程，标题必须消费同一冻结计划');
  const journey = spec.split(title)[1].split("test('[REC-004]")[0];
  assert.match(journey, /const speechReference = loadStableSmokeSpeechReference\(\)/);
  assert.match(journey, /mimeType: speechReference\.mimeType,[\s\S]*buffer: speechReference\.audio/);
  assert.doesNotMatch(journey, /speechFixture|speech\.m4a|getByText\(transcriptText/);
  assert.match(journey, /assertSpeechMatchesReference\(transcriptText, speechReference\.reference\)/);
  assert.match(journey, /const expectedLines = transcriptText\.split\('\\n'\)/);
  assert.match(journey, /const originalRows = await readRecordingTranscriptRows\(page\)/);
  assert.match(journey, /assertRecordingTranscriptEquals\(originalRows, expectedLines\)/);
  const refresh = journey.split("await page.reload({ waitUntil: 'domcontentloaded' });")[1];
  assert.ok(refresh, '必须真的刷新整个页面');
  assert.match(refresh, /const persistedRows = await readRecordingTranscriptRows\(page\)/);
  assert.match(refresh, /assertRecordingTranscriptEquals\(persistedRows, expectedLines\)/);
  assert.match(refresh, /expect\(persistedRows\)\.toEqual\(originalRows\)/);
  assert.match(journey, /expect\(new URL\(page\.url\(\)\)\.searchParams\.get\('entry'\)\)\.toBe\(entryId\)/);
  for (const [assignment, assertion] of [
    ['storeId = storeBody.data?.id', 'expect(storeResponse.ok()'],
    ['entryId = uploadBody.data?.entry?.id', 'expect(uploadResponse.ok()'],
    ['runId = transcribeBody.data?.runId', 'expect(transcribeResponse.ok()'],
    ['restyleRunId = restyleBody.data?.runId', 'expect(restyleResponse.ok()'],
  ]) {
    assert.ok(journey.indexOf(assignment) >= 0 && journey.indexOf(assignment) < journey.indexOf(assertion), '断言失败前必须先登记本轮资源');
  }
  const cleanup = journey.split('} finally {')[1];
  for (const resource of ['stores/${storeId}', 'entries/${entryId}', 'agent-runs/${runId}', 'agent-runs/${restyleRunId}']) {
    assert.ok(cleanup.includes(resource), `清理必须回读：${resource}`);
  }
  assert.equal((cleanup.match(/\.toBe\(404\)/g) || []).length, 4, '空间、条目和两个任务均须404回读');
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("- 'e2e/specs/stable-smoke.spec.ts'"), '只改原旅程也须触发机械守卫');
});

const recordingSpec = () => readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
const plannedEnv = (environment, allowedCaseIds) => ({ STABLE_SMOKE_RUN: '1', STABLE_SMOKE_ENVIRONMENT: environment,
  STABLE_SMOKE_ALLOWED_CASE_IDS_JSON: JSON.stringify({ environment, allowedCaseIds }) });

function discoveredRecordingTitle(source, env) {
  const initializer = source.match(/^const recordingJourneyPlan = (.+);$/m)?.[1];
  if (!initializer) return source.match(/test\('([^']+页面选择音频、显示阶段、真实转写、可选整理、回读与清理)'/)?.[1];
  assert.match(source, /test\(recordingJourneyPlan\.title,/);
  return new Function('readRecordingJourneyPlan', 'process', `return (${initializer}).title;`)(recording.readRecordingJourneyPlan, { env });
}

test('REG-rec-transcript-body-001 冻结标题与collector仅在本环境选中时包含REC-011', () => {
  for (const environment of ['production', 'cds']) {
    for (const selected of [false, true]) {
      const ids = selected ? ['REC-003', 'REC-007', 'REC-011', 'REC-012'] : ['REC-003', 'REC-007', 'REC-012'];
      const title = discoveredRecordingTitle(recordingSpec(), plannedEnv(environment, ids));
      const rows = collectPlaywrightCases({ suites: [{ specs: [{ title, tests: [{ results: [{ status: 'passed' }] }] }] }] }, environment);
      assert.deepEqual(rows.map(row => row.caseId), ids, '实际标题不得靠collector过滤隐藏越界');
    }
  }
  const ordinary = discoveredRecordingTitle(recordingSpec(), {});
  assert.match(ordinary, /\[REC-011\]/, '非巡检普通发现保留既有suite行为');
  const env = plannedEnv('production', ['REC-003', 'REC-007', 'REC-012']);
  const snapshot = recording.readRecordingJourneyPlan(env);
  env.STABLE_SMOKE_ALLOWED_CASE_IDS_JSON = plannedEnv('production', ['REC-011']).STABLE_SMOKE_ALLOWED_CASE_IDS_JSON;
  assert.equal(snapshot.restyleSelected, false, '发现与执行必须消费同一个不可变决定');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(recording.readRecordingJourneyPlan(plannedEnv('production', ['REC-011-extra'])).restyleSelected, false, '不接受同义文本或前缀匹配');
});

test('REG-rec-transcript-body-001 巡检坏计划在发现阶段拒绝，普通发现不受影响', () => {
  const source = recordingSpec();
  const valid = plannedEnv('production', ['REC-003', 'REC-007', 'REC-012']);
  for (const json of [undefined, '', '{', '[]', 'null', JSON.stringify({ environment: 'cds', allowedCaseIds: ['REC-011'] }),
    JSON.stringify({ environment: 'production' }), JSON.stringify({ environment: 'production', allowedCaseIds: ['REC-011', 'REC-011'] }),
    JSON.stringify({ environment: 'production', allowedCaseIds: [11] }), JSON.stringify({ environment: 'production', allowedCaseIds: [' REC-011'] })]) {
    assert.throws(() => discoveredRecordingTitle(source, { ...valid, STABLE_SMOKE_ALLOWED_CASE_IDS_JSON: json }), /冻结|清单|环境/);
  }
  assert.throws(() => discoveredRecordingTitle(source, { ...valid, STABLE_SMOKE_ENVIRONMENT: 'unknown' }), /环境/);
  assert.doesNotThrow(() => discoveredRecordingTitle(source, { STABLE_SMOKE_ALLOWED_CASE_IDS_JSON: '{' }));
  const definition = source.indexOf('const recordingJourneyPlan =');
  assert.ok(definition >= 0 && definition < source.indexOf("test.describe('稳定冒烟"), '坏计划必须先于任何beforeEach或鉴权');
});

async function executeActualRestyleBlock(source, plan, overrides = {}) {
  const journey = source.split('页面选择音频、显示阶段、真实转写、可选整理、回读与清理')[1]
    || source.split('test(recordingJourneyPlan.title')[1];
  assert.ok(journey);
  const stylesStart = journey.indexOf('      const styles =');
  const gateStart = journey.lastIndexOf('      if (recordingJourneyPlan.restyleSelected) {', stylesStart);
  let body = journey.slice(gateStart >= 0 ? gateStart : stylesStart, journey.indexOf('      const openOriginal ='));
  // 只擦除该原始块的TS类型，不改条件、请求或业务断言。
  body = body.replace('readEnvelope<{ items: Array<{ key: string; label: string }> }>', 'readEnvelope')
    .replace(' as ApiEnvelope<{ runId: string }>', '').replace(/let restyled!:\s*\{[^}]+\};/, 'let restyled;')
    .replace('readEnvelope<typeof restyled>', 'readEnvelope').replace('readEnvelope<{ transcriptText?: string }>', 'readEnvelope')
    .replaceAll('style!.key', 'style.key');
  const calls = [];
  const response = data => ({ ok: () => true, json: async () => ({ success: true, data }) });
  const page = { request: {
    get: async path => { calls.push(['GET', path]); return response(path.endsWith('transcribe-styles') ? { items: [{ key: 'notes' }] }
      : path.endsWith('/restyled') ? { status: 'done', restyleOfRunId: 'original', outputEntryId: 'entry', transcriptText: '原文', generatedText: '整理结果', ...overrides }
        : { transcriptText: '原文' }); },
    post: async path => { calls.push(['POST', path]); return response({ runId: 'restyled' }); },
  } };
  const expect = actual => ({ toBe: expected => assert.equal(actual, expected), toBeTruthy: () => assert.ok(actual),
    toBeGreaterThan: minimum => assert.ok(actual > minimum), not: { toBe: expected => assert.notEqual(actual, expected) } });
  expect.poll = fn => ({ toBe: async expected => assert.equal(await fn(), expected) });
  const run = new Function('recordingJourneyPlan', 'page', 'readEnvelope', 'expect', 'authHeaders',
    `return (async () => { const token='scoped'; const runId='original'; const entryId='entry'; const transcriptText='原文'; const stableSmokeCleanupTimeoutMs=1; let restyleRunId=''; ${body} })();`);
  await run(plan, page, async response => (await response.json()).data, expect, () => ({}));
  return calls;
}

test('REG-rec-transcript-body-001 原整理执行体未选时零请求，选中仍保留全部业务断言', async () => {
  const source = recordingSpec();
  assert.deepEqual(await executeActualRestyleBlock(source, { restyleSelected: false }), []);
  const calls = await executeActualRestyleBlock(source, { restyleSelected: true });
  assert.deepEqual(calls, [['GET', '/api/document-store/transcribe-styles'], ['POST', '/api/document-store/agent-runs/original/restyle'],
    ['GET', '/api/document-store/agent-runs/restyled'], ['GET', '/api/document-store/agent-runs/original']]);
  for (const wrong of [{ status: 'failed' }, { restyleOfRunId: 'other' }, { outputEntryId: 'other' }, { transcriptText: '变更原文' }, { generatedText: '' }]) {
    await assert.rejects(executeActualRestyleBlock(source, { restyleSelected: true }, wrong));
  }
});

test('REG-rec-transcript-body-001 runner覆盖继承清单且两个真实spawn均显式传入范围', () => {
  const source = readFileSync(new URL('../stable-smoke-run.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('function runPlaywright('), source.indexOf('\nconst folderRegressionCaseIds'));
  const captured = [];
  const env = { STABLE_SMOKE_ALLOWED_CASE_IDS_JSON: JSON.stringify({ environment: 'production', allowedCaseIds: ['REC-011'] }) };
  const execute = new Function('process', 'resolve', 'rmSync', 'command', 'sanitizeStableSmokeArtifactTree', 'freezeRecordingCasePlanEnvironment', 'ensurePlaywrightDependencies',
    `${run}; return runPlaywright;`)({ env }, (...parts) => parts.join('/'), () => {}, (...args) => { captured.push(args); return { status: 0 }; },
    () => ({ scanned: 0, changed: 0 }), recording.freezeRecordingCasePlanEnvironment, () => ({ status: 0 }));
  execute('production', {}, '/temporary', ['REC-003', 'REC-007', 'REC-012']);
  const actual = captured[0][2].env;
  assert.deepEqual(JSON.parse(actual.STABLE_SMOKE_ALLOWED_CASE_IDS_JSON), { environment: 'production', allowedCaseIds: ['REC-003', 'REC-007', 'REC-012'] });
  assert.throws(() => execute('production', {}, '/temporary'), /冻结|清单/);
  assert.equal(captured.length, 1, '缺失范围不能启动Playwright');
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(main, /runPlaywright\(\s*'production',\s*values,\s*runDir,\s*grepCaseIds\(productionReadOnlyGrep\)/);
  assert.match(main, /runPlaywright\(\s*environment,\s*values,\s*runDir,\s*frozenAllowedCaseIds/);
  assert.match(main, /const frozenEnvironmentCases = plan\?\.requiredCaseIdsByEnvironment\?\.\[environment\]/);
  assert.match(main, /const frozenAllowedCaseIds = selectRequiredCaseIds\(frozenEnvironmentCases,/);
  const selection = main.slice(main.indexOf('      const frozenEnvironmentCases ='), main.indexOf('      const execution = runPlaywright(\n        environment,'));
  const select = new Function('plan', 'environment', 'productionSafetyGate', 'grep', 'selectRequiredCaseIds', `${selection}; return frozenAllowedCaseIds;`);
  const plan = { requiredCaseIds: ['REC-011'], requiredCaseIdsByEnvironment: { production: ['REC-003', 'REC-007', 'REC-012'], cds: ['REC-003', 'REC-011'] } };
  assert.deepEqual(select(plan, 'production', { restricted: false }, '\\[REC-003\\]|\\[REC-011\\]', selectRequiredCaseIds), ['REC-003']);
  assert.deepEqual(select(plan, 'cds', { restricted: false }, '\\[REC-011\\]', selectRequiredCaseIds), ['REC-011']);
  assert.deepEqual(select(plan, 'production', { restricted: true, grep: '\\[CORE-001\\]' }, '', selectRequiredCaseIds), []);
  assert.throws(() => select({ requiredCaseIds: ['REC-011'] }, 'production', { restricted: false }, '', selectRequiredCaseIds), /冻结/);
});

test('REG-rec-asr-reference-001 独立源文绑定完整清晰短句WAV而非ASR输出', () => {
  const { reference, audio, signal } = loadStableSmokeSpeechReference();
  assert.equal(reference.sourceText, 'The white peach is on the table.');
  assert.equal(reference.expectedTranscript, reference.sourceText);
  assert.equal(signal.humanListeningVerified, false);
  assert.equal(audio.length, reference.byteLength);
  assert.deepEqual(assertSpeechMatchesReference('the white peach is on the table', reference), {
    referenceId: reference.fixtureId, comparison: 'complete-normalized-equality', humanListeningVerified: false,
  });
  for (const actual of ['', 'The white peaches are on the table.', 'The white peach is on the table. Extra sentence.', 'white peach table']) {
    assert.throws(() => assertSpeechMatchesReference(actual, reference));
  }
});

test('REG-rec-asr-reference-001 词形不能靠归一化变绿，JFK旧输出不能充当真值', () => {
  const { reference } = loadStableSmokeSpeechReference();
  const source = 'And so, my fellow Americans,';
  const independent = { ...reference, sourceText: source, expectedTranscript: source };
  assert.throws(() => assertSpeechMatchesReference('And so, my fellow American,', independent), /不相等/);
  assert.throws(() => assertSpeechMatchesReference(reference.sourceText, { ...reference, provenance: { ...reference.provenance, referenceBasis: 'previous-cds-asr-output' } }), /独立/);
  assert.throws(() => assertSpeechMatchesReference(reference.sourceText, { ...reference, expectedTranscript: 'another expected answer' }), /独立/);
});

test('REG-rec-asr-reference-001 截断、改字节、改源文、假听审和静音夹具均拒收', () => {
  const { reference, audio } = loadStableSmokeSpeechReference();
  for (const bad of [{ language: 'zh-CN' }, { sha256: '0'.repeat(64) }, { expectedTranscript: 'ASR answer' }, { sourceText: 'ASR answer', expectedTranscript: 'ASR answer' }, { provenance: { ...reference.provenance, humanListeningVerified: true } }]) {
    assert.throws(() => validateSpeechReference({ ...reference, ...bad }, audio));
  }
  assert.throws(() => validateSpeechReference(reference, audio.subarray(0, -2)));
  const changed = Buffer.from(audio); changed[changed.length - 1] ^= 1;
  assert.throws(() => validateSpeechReference(reference, changed));
  const silent = Buffer.from(audio); silent.fill(0, 44);
  const silentReference = { ...reference, sha256: createHash('sha256').update(silent).digest('hex') };
  assert.throws(() => validateSpeechReference(silentReference, silent), /静音/);
});
