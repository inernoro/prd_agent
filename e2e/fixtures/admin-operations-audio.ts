import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';

/** Records only the CI virtual speaker monitor, never an input microphone. */
export async function captureSpeaker(testInfo: TestInfo, label: string, audible: boolean, action: () => Promise<void>) {
  const monitor = process.env.GATEWAY_AUDIO_MONITOR;
  if (!monitor) { await action(); return; }
  if (monitor !== 'gateway_acceptance.monitor') throw new Error('只允许录制验收专用扬声器');
  const recorder = spawn('parec', [`--device=${monitor}`, '--raw', '--format=s16le', '--rate=48000', '--channels=1', '--latency-msec=20', '--process-time-msec=10'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let diagnostics = '';
  recorder.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  recorder.stderr.on('data', chunk => { diagnostics += chunk; });
  const closed = new Promise<void>(resolve => recorder.once('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`扬声器录制未就绪: ${diagnostics}`)), 5000);
      recorder.stdout.once('data', () => resolve());
      recorder.once('error', reject);
      recorder.once('exit', code => reject(new Error(`扬声器录制提前退出: ${code} ${diagnostics}`)));
    });
    clearTimeout(timer);
    await action();
  } finally {
    clearTimeout(timer);
    recorder.kill('SIGINT');
    await closed;
    const pcm = Buffer.concat(chunks);
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    const output = testInfo.outputPath(`${label}.wav`);
    await writeFile(output, Buffer.concat([header, pcm]));
    await testInfo.attach(label, { path: output, contentType: 'audio/wav' });
  }
  const pcm = Buffer.concat(chunks);
  let peak = 0, energy = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const value = pcm.readInt16LE(i) / 32768; peak = Math.max(peak, Math.abs(value)); energy += value * value; }
  const evidence = { label, audible, samples: pcm.length / 2, peak, rms: Math.sqrt(energy / Math.max(1, pcm.length / 2)) };
  console.log('Speaker output evidence:', JSON.stringify(evidence));
  await testInfo.attach(`${label}-signal`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  expect(pcm.length).toBeGreaterThan(9600);
  if (audible) { expect(peak).toBeGreaterThan(.005); expect(peak).toBeLessThan(.99); }
  else expect(peak).toBeLessThan(.0001);
}

export async function observeNativeAudio(page: Page) {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    const contexts: AudioContext[] = [];
    Reflect.set(window, 'gatewayNativeAudioContexts', contexts);
    document.addEventListener('visibilitychange', () => events.push({ event: 'visibility', value: document.visibilityState }));
    Reflect.set(window, 'gatewayNativeAudio', events);
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      const requestedAt = performance.now();
      if (!contexts.includes(this)) contexts.push(this);
      events.push({ event: 'resume', state: this.state, rate: this.sampleRate, visibility: document.visibilityState, activated: navigator.userActivation?.isActive });
      this.addEventListener('statechange', () => events.push({ event: 'state', state: this.state, time: this.currentTime }));
      return resume.call(this).then(() => { events.push({ event: 'resumed', waitMs: performance.now() - requestedAt, state: this.state, time: this.currentTime }); }, error => { events.push({ event: 'resume-error', error: String(error) }); throw error; });
    };
    const decode = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (bytes: ArrayBuffer) {
      events.push({ event: 'decode', bytes: bytes.byteLength });
      return decode.call(this, bytes).then(buffer => { events.push({ event: 'decoded', duration: buffer.duration }); return buffer; }, error => { events.push({ event: 'decode-error', error: String(error) }); throw error; });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<AudioBufferSourceNode['start']>) {
      const duration = this.buffer?.duration;
      const began = this.context.currentTime;
      start.apply(this, args);
      events.push({ event: 'started', state: this.context.state, duration, time: began });
      this.addEventListener('ended', () => events.push({ event: 'ended', duration, elapsed: this.context.currentTime - began }));
    };
  });
}

export async function nativeAudioEvidence(page: Page) {
  return page.evaluate(() => ({
    visibility: document.visibilityState,
    events: Reflect.get(window, 'gatewayNativeAudio'),
    contexts: (Reflect.get(window, 'gatewayNativeAudioContexts') || []).map((context: AudioContext) => ({ state: context.state, time: context.currentTime, rate: context.sampleRate })),
  }));
}
