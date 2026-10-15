import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
