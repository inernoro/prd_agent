import { execFile, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutablePath } from '../quality/browser-runner.js';

const exec = promisify(execFile);
const fps = 24;
export interface BrowserFilmExportRequest {
  html: string;
  aac: string;
  durationSec: number;
}
export interface ExportIsolation { uid: number; gid: number; home: string }

export function parseBrowserFilmExport(value: unknown): BrowserFilmExportRequest {
  const request = value as Partial<BrowserFilmExportRequest> | null;
  if (request == null || typeof request.html !== 'string' || !request.html.startsWith('<!doctype html>')
      || request.html.length > 22 * 1024 * 1024 || typeof request.aac !== 'string' || request.aac.length > 12 * 1024 * 1024
      || !/^[A-Za-z0-9+/=]+$/.test(request.aac) || typeof request.durationSec !== 'number'
      || !Number.isFinite(request.durationSec) || request.durationSec <= 0 || request.durationSec > 690) {
    throw new Error('Browser film export input is invalid');
  }
  return { html: request.html, aac: request.aac, durationSec: request.durationSec };
}

export async function runBrowserFilmExport(job: BrowserFilmExportRequest, work: string, isolation: ExportIsolation, signal: AbortSignal) {
  signal.throwIfAborted();
  if (process.getuid?.() === 0) fs.chownSync(work, isolation.uid, isolation.gid);
  const browserWorker = fork(new URL('./browser-film-export.js', import.meta.url), [], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH ?? '', HOME: isolation.home, MAP_FILM_EXPORT: '1',
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
      ...(process.env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH
        ? { DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH: process.env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH } : {}) },
    ...(process.getuid?.() === 0 ? { uid: isolation.uid, gid: isolation.gid } : {}),
  });
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (browserWorker.connected) browserWorker.disconnect();
      if (browserWorker.pid) {
        try { process.kill(-browserWorker.pid, 'SIGKILL'); } catch { /* already closed */ }
      }
      if (error) reject(error);
      else resolve(path.join(work, 'film.mp4'));
    };
    const abort = () => finish(new DOMException('Film export cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    browserWorker.once('error', error => finish(error));
    browserWorker.once('exit', () => finish(new Error('Film export worker stopped')));
    browserWorker.once('message', (message: unknown) => {
      const result = message as { ok?: boolean; frame?: number };
      finish(result.ok ? undefined : new Error(`Film export failed at frame ${result.frame ?? 0}`));
    });
    if (signal.aborted) abort();
    else browserWorker.send({ job, work });
  });
}

async function renderInIsolatedWorker(job: BrowserFilmExportRequest, work: string) {
  const audio = Buffer.from(job.aac, 'base64');
  if (audio.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid film audio');
  const audioPath = path.join(work, 'voice.m4a');
  fs.writeFileSync(audioPath, audio, { flag: 'wx' });
  const browser = await chromium.launch({ headless: true, executablePath: resolveBrowserExecutablePath(),
    args: ['--disable-dev-shm-usage', '--disable-background-networking'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1920, height: 1080 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const output = path.join(work, 'film.mp4');
  const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'png', '-i', 'pipe:0', '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', output],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  const encoderDone = once(ffmpeg, 'exit');
  ffmpeg.stdin.on('error', () => { /* encoderDone reports the cause */ });
  let frame = 0;
  try {
    await page.setContent('<!doctype html><iframe sandbox="allow-scripts" hidden></iframe><canvas width="1920" height="1080"></canvas>');
    await page.evaluate(html => new Promise<void>((resolve, reject) => {
      const iframe = document.querySelector('iframe')!;
      const timeout = setTimeout(() => { removeEventListener('message', ready); reject(new Error('Playback renderer unavailable')); }, 15_000);
      const ready = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow || event.data?.type !== 'map-film-ready') return;
        clearTimeout(timeout); removeEventListener('message', ready); resolve();
      };
      addEventListener('message', ready);
      iframe.srcdoc = html;
    }), job.html);
    for (frame = 0; frame < Math.ceil(job.durationSec * fps); frame++) {
      const png = await page.evaluate(({ time, id }) => new Promise<string>((resolve, reject) => {
        const iframe = document.querySelector('iframe')!;
        const canvas = document.querySelector('canvas')!;
        const context = canvas.getContext('2d')!;
        const cleanup = () => { clearTimeout(timeout); removeEventListener('message', receive); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Playback frame timed out')); }, 15_000);
        const receive = (event: MessageEvent) => {
          if (event.source !== iframe.contentWindow || event.data?.id !== id) return;
          cleanup();
          const bitmap = event.data.bitmap;
          if (event.data.type !== 'map-film-bitmap' || !(bitmap instanceof ImageBitmap)) { reject(new Error('Invalid frame')); return; }
          try {
            context.drawImage(bitmap, 0, 0);
            const cue: string = typeof event.data.caption === 'string' ? event.data.caption : '';
            context.font = '36px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
            for (const [index, line] of cue.split('\n').filter(Boolean).entries()) {
              const y = 980 + index * 40;
              const width = Math.min(canvas.width * .8, context.measureText(line).width) + 34;
              context.fillStyle = '#171819e6'; context.fillRect((canvas.width - width) / 2, y - 22, width, 44);
              context.fillStyle = '#fff'; context.fillText(line, canvas.width / 2, y, canvas.width * .8);
            }
            resolve(canvas.toDataURL('image/png').split(',')[1]);
          } finally { bitmap.close(); }
        };
        addEventListener('message', receive);
        iframe.contentWindow!.postMessage({ type: 'map-film-frame', id, time }, '*');
      }), { time: frame / fps, id: randomUUID() });
      await new Promise<void>((resolve, reject) => ffmpeg.stdin.write(Buffer.from(png, 'base64'), error => error ? reject(error) : resolve()));
    }
    ffmpeg.stdin.end();
    const [exit] = await encoderDone;
    if (exit !== 0) throw new Error('FFmpeg could not finish the video');
    const probe = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'stream=codec_type', '-of', 'csv=p=0', output], { timeout: 8_000, maxBuffer: 16_384 });
    if (!probe.stdout.includes('video') || !probe.stdout.includes('audio')) throw new Error('Export is missing media tracks');
    return { ok: true };
  } catch {
    return { ok: false, frame };
  } finally {
    ffmpeg.kill('SIGKILL');
    await browser.close();
  }
}

if (process.env.MAP_FILM_EXPORT === '1') {
  process.once('message', async (value: { job: BrowserFilmExportRequest; work: string }) => {
    const result = await renderInIsolatedWorker(value.job, value.work).catch(() => ({ ok: false }));
    process.send?.(result);
  });
}
