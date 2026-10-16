import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function assertRecordingIdempotencyRuns(firstRunId, secondRunId) {
  if (typeof firstRunId !== 'string' || !firstRunId.trim()
    || typeof secondRunId !== 'string' || !secondRunId.trim()) throw Error('完成响应缺少真实deferredTranscriptionRunId，无法核销转录任务');
  if (firstRunId !== secondRunId) throw Error('重复complete产生了不同的转录任务');
}

export async function waitForRecordingIdempotencySettlement({
  sessionId, storeId, entryId, runIds, readSession, readRun,
  timeoutMs = 30_000, intervalMs = 1_000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const observations = [];
  const errors = [];
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000
    || !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('录音收尾轮询必须使用不超过30秒的正有界预算');
  if (!sessionId || !storeId || !entryId || !Array.isArray(runIds) || runIds.length === 0
    || runIds.some(id => typeof id !== 'string' || !id.trim())) {
    return { settled: false, observations, errors: ['缺少本轮会话、条目或真实转录run身份，不能证明收尾完成'] };
  }
  const deadline = now() + timeoutMs;
  // 同时约束时钟与轮数；网络回读只消费剩余预算，不重新complete或触发转录。
  const maxPolls = Math.ceil(timeoutMs / intervalMs);
  for (let index = 0; index < maxPolls && now() < deadline; index += 1) {
    const session = await readSession(Math.max(1, deadline - now()));
    const observation = { sessionStatus: session.status, archiveStatus: session.archiveStatus, runs: [] };
    observations.push(observation);
    if (session.sessionId !== sessionId || session.entryId !== entryId) {
      errors.push('精确会话回读的条目身份不匹配'); break;
    }
    for (const runId of new Set(runIds)) {
      if (now() >= deadline) break;
      const run = await readRun(runId, Math.max(1, deadline - now()));
      observation.runs.push({ id: run.id, status: run.status, automaticRetryNextAt: run.automaticRetryNextAt ?? null });
      if (run.id !== runId || run.storeId !== storeId || run.sourceEntryId !== entryId || run.kind !== 'transcribe') {
        errors.push('已知转录run回读不属于本轮知识库/条目或种类不匹配'); break;
      }
      if (['cancelled', 'failed'].includes(run.status) && !run.automaticRetryNextAt) errors.push('本轮转录run以失败或取消收尾，不能记为完成');
    }
    if (errors.length) break;
    if (session.status === 'completed' && session.archiveStatus === 'completed'
      && observation.runs.length === new Set(runIds).size && observation.runs.every(run => run.status === 'done')) {
      return { settled: true, observations, errors };
    }
    if (now() < deadline) await sleep(Math.min(intervalMs, deadline - now()));
  }
  if (!errors.length) errors.push('有界等待后归档或已知转录run仍未完成，可能保留活分片/后台重试，不能清理判绿');
  return { settled: false, observations, errors };
}

function validateRecordingCasePlan(plan, environment) {
  if (!['cds', 'production'].includes(environment) || plan?.environment !== environment) {
    throw Error('录音冻结清单环境缺失或与当前巡检环境不一致');
  }
  if (!Array.isArray(plan.allowedCaseIds) || plan.allowedCaseIds.some(id => typeof id !== 'string' || !id || id !== id.trim())
    || new Set(plan.allowedCaseIds).size !== plan.allowedCaseIds.length) {
    throw Error('录音冻结清单必须是无重复的精确caseId数组');
  }
  return Object.freeze({ environment, allowedCaseIds: Object.freeze([...plan.allowedCaseIds]) });
}

export function freezeRecordingCasePlanEnvironment(environment, allowedCaseIds) {
  const plan = validateRecordingCasePlan({ environment, allowedCaseIds }, environment);
  return { STABLE_SMOKE_ALLOWED_CASE_IDS_JSON: JSON.stringify(plan) };
}

export function readRecordingJourneyPlan(env = process.env) {
  let restyleSelected = true;
  if (env.STABLE_SMOKE_RUN === '1') {
    let parsed;
    try { parsed = JSON.parse(env.STABLE_SMOKE_ALLOWED_CASE_IDS_JSON); }
    catch { throw Error('巡检启用时必须显式传入有效的录音冻结清单JSON'); }
    const plan = validateRecordingCasePlan(parsed, env.STABLE_SMOKE_ENVIRONMENT);
    // 仅精确REC-011授权本旅程的已知付费整理动作，不从标题或grep猜授权。
    restyleSelected = plan.allowedCaseIds.includes('REC-011');
  }
  return Object.freeze({
    title: `[REC-003][REC-007]${restyleSelected ? '[REC-011]' : ''}[REC-012] 页面选择音频、显示阶段、真实转写、可选整理、回读与清理`,
    restyleSelected,
  });
}

export async function readRecordingTranscriptRows(surface) {
  const rows = await surface.locator('[data-transcript-row]').evaluateAll(elements => elements.map(row => ({
    index: Number(row.getAttribute('data-transcript-row')),
    bodies: [...row.querySelectorAll('span.block.min-w-0.break-words')].map(span => span.textContent?.trim() || ''),
    timestamps: [...row.querySelectorAll('span.font-mono.tabular-nums')].map(span => span.textContent?.trim() || ''),
  })));
  return validateRecordingTranscriptRows(rows);
}

export function validateRecordingTranscriptRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw Error('没有可读取的原文行');
  let lastTime = -1;
  return rows.map((row, index) => {
    if (row.index !== index || !Array.isArray(row.bodies) || row.bodies.length !== 1 || !row.bodies[0]?.trim()) {
      throw Error('原文行身份、唯一正文或顺序不符合页面契约');
    }
    if (!Array.isArray(row.timestamps) || row.timestamps.length !== 1) throw Error('原文时间列缺失或重复');
    const timestamp = row.timestamps[0];
    if (timestamp) {
      if (!/^\d{2,}:\d{2}(?::\d{2})?$/.test(timestamp)) throw Error('时间戳格式不符合契约');
      const parts = timestamp.split(':').map(Number);
      if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) throw Error('时间戳分秒越界');
      const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
      if (seconds < lastTime) throw Error('时间戳顺序倒退');
      lastTime = seconds;
    }
    return { index, body: row.bodies[0].trim(), timestamp };
  });
}

export function assertRecordingTranscriptEquals(rows, expectedLines, { timestamps = 'optional' } = {}) {
  if (!['optional', 'required'].includes(timestamps)) throw Error('时间戳策略未登记');
  if (!Array.isArray(expectedLines) || expectedLines.length === 0 || expectedLines.some(line => typeof line !== 'string' || !line.trim())) {
    throw Error('必须提供来自持久化原文的完整预期行');
  }
  if (rows.length !== expectedLines.length || rows.some((row, index) => row.body !== expectedLines[index].trim())) {
    throw Error('页面原文与持久化原文不相等');
  }
  if (timestamps === 'required' && rows.some(row => !row.timestamp)) throw Error('本场景要求的时间戳未显示');
  return { lineCount: rows.length, timestampCount: rows.filter(row => row.timestamp).length };
}

export function normalizeSpeechReference(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('转写正文为空');
  // 只规范呈现差异；不删除词、不做词干化、不接受同义词或子串命中。
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.!?。！？]+$/u, '').replace(/[A-Z]/g, letter => letter.toLowerCase());
}

export function assertSpeechMatchesReference(actual, reference) {
  if (reference?.provenance?.referenceBasis !== 'synthesis-input-not-asr'
    || reference?.normalization !== 'nfkc-space-ascii-case-terminal-punctuation-v1'
    || reference.expectedTranscript !== reference.sourceText) throw Error('缺少独立合成源文真值');
  if (normalizeSpeechReference(actual) !== normalizeSpeechReference(reference.sourceText)) throw Error('转写内容与独立合成源文不相等');
  return { referenceId: reference.fixtureId, comparison: 'complete-normalized-equality', humanListeningVerified: false };
}

export function validateSpeechReference(reference, audio) {
  if (reference?.schemaVersion !== 1 || reference.fixtureId !== 'stsmk-clear-en-say-v1'
    || reference.language !== 'en-US' || reference.mimeType !== 'audio/wav'
    || reference.sourceText !== 'The white peach is on the table.'
    || reference.provenance?.engine !== 'macos-say' || reference.provenance?.voice !== 'Samantha'
    || reference.provenance?.humanListeningVerified !== false) throw Error('合成语音来源或语言契约缺失');
  assertSpeechMatchesReference(reference.expectedTranscript, reference);
  if (!Buffer.isBuffer(audio) || audio.length !== reference.byteLength
    || createHash('sha256').update(audio).digest('hex') !== reference.sha256) throw Error('语音夹具字节与来源契约不匹配');
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.readUInt32LE(4) + 8 !== audio.length) throw Error('语音夹具不是完整WAV');
  let format;
  let pcm;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > audio.length) throw Error('WAV数据被截断');
    const kind = audio.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') format = audio.subarray(offset + 8, end);
    if (kind === 'data') pcm = audio.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
    || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16 || !pcm?.length || pcm.length % 2) {
    throw Error('语音夹具必须为16kHz单声道PCM16且有完整采样');
  }
  const durationSeconds = pcm.length / 32000;
  if (Math.abs(durationSeconds - reference.durationSeconds) > 0.000001 || durationSeconds < 1 || durationSeconds > 8) throw Error('语音夹具时长不符合完整短句契约');
  let squareSum = 0;
  let clipped = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    squareSum += (sample / 32768) ** 2;
    if (Math.abs(sample) >= 32760) clipped += 1;
  }
  const rms = Math.sqrt(squareSum / (pcm.length / 2));
  if (rms < 0.003 || clipped / (pcm.length / 2) > 0.01) throw Error('语音夹具静音或明显削波');
  return { durationSeconds, rms, humanListeningVerified: false };
}

export function loadStableSmokeSpeechReference() {
  const reference = JSON.parse(readFileSync(new URL('../fixtures/stable-smoke-clear-speech.reference.json', import.meta.url), 'utf8'));
  const audio = Buffer.from(readFileSync(new URL('../fixtures/stable-smoke-clear-speech.wav.b64', import.meta.url), 'utf8').trim(), 'base64');
  const signal = validateSpeechReference(reference, audio);
  return { reference, audio, signal, fileName: `${reference.fixtureId}.wav`, mimeType: reference.mimeType };
}
