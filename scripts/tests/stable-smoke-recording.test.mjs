import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const title = "test('[REC-003][REC-007][REC-011][REC-012] 页面选择音频、显示阶段、真实转写、可选整理、回读与清理'";
  assert.equal(spec.split(title).length - 1, 1, '保留原唯一旅程及四个caseId');
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
