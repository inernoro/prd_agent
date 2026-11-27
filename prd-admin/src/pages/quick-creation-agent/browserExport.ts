import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, EncodedAudioPacketSource, EncodedPacketSink,
  Input, Mp4OutputFormat, Output, WebMOutputFormat, canEncodeVideo } from 'mediabunny';
import type { QcPlayBundle } from './types';

export type ExportContainer = 'mp4' | 'webm';
export interface ExportProgress { frame: number; frames: number; elapsedSec: number; remainSec?: number }

const bitrate = 6_000_000;

export async function detectBrowserExport(): Promise<ExportContainer | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  const config = { width: 1920, height: 1080, bitrate };
  if (await canEncodeVideo('avc', config).catch(() => false)) return 'mp4';
  if (await canEncodeVideo('vp9', config).catch(() => false)) return 'webm';
  return null;
}

async function canvasFrame(frameWindow: Window, time: number, signal: AbortSignal): Promise<ImageBitmap> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => {
      window.removeEventListener('message', onReply);
      signal.removeEventListener('abort', onAbort);
      window.clearTimeout(timer);
    };
    const onAbort = () => { finish(); reject(signal.reason); };
    const timer = window.setTimeout(() => { finish(); reject(new Error('画面没有返回，请保持页面在前台后重试')); }, 20_000);
    const onReply = (event: MessageEvent) => {
      if (event.source !== frameWindow || event.data?.id !== id) return;
      if (event.data.type === 'map-film-frame-error') { finish(); reject(new Error('这一帧画面无法绘制')); }
      if (event.data.type === 'map-film-bitmap' && event.data.bitmap instanceof ImageBitmap) { finish(); resolve(event.data.bitmap); }
    };
    window.addEventListener('message', onReply);
    signal.addEventListener('abort', onAbort, { once: true });
    frameWindow.postMessage({ type: 'map-film-frame', id, time }, '*');
  });
}

function audioBlob(data: string, container: ExportContainer) {
  return new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))],
    { type: container === 'mp4' ? 'audio/mp4' : 'audio/webm' });
}

export async function exportFilmInBrowser(bundle: QcPlayBundle, frameWindow: Window, container: ExportContainer,
    onProgress: (progress: ExportProgress) => void, signal: AbortSignal): Promise<Blob> {
  const mp4 = container === 'mp4';
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(audioBlob(mp4 ? bundle.aac : bundle.opus, container)) });
  const target = new BufferTarget();
  const output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target });
  const canvas = document.createElement('canvas');
  canvas.width = bundle.width;
  canvas.height = bundle.height;
  const context = canvas.getContext('2d');
  if (!context) { input.dispose(); throw new Error('浏览器无法创建导出画布'); }
  const frames = Math.ceil(bundle.durationSec * bundle.fps);
  const video = new CanvasSource(canvas, { codec: mp4 ? 'avc' : 'vp9', bitrate });
  const audio = new EncodedAudioPacketSource(mp4 ? 'aac' : 'opus');
  let frame = 0;
  try {
    const track = await input.getPrimaryAudioTrack();
    const decoderConfig = await track?.getDecoderConfig();
    if (!track || !decoderConfig) throw new Error('成片包没有可封装的配音轨');
    output.addVideoTrack(video, { frameRate: bundle.fps });
    output.addAudioTrack(audio);
    await output.start();
    const audioPackets = new EncodedPacketSink(track).packets();
    let packet = await audioPackets.next();
    let first = true;
    const startedAt = performance.now();
    for (frame = 0; frame < frames; frame++) {
      signal.throwIfAborted();
      const time = frame / bundle.fps;
      const bitmap = await canvasFrame(frameWindow, time, signal);
      try { context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
      const cue = bundle.captions.find(item => item.fromSec <= time && time < item.toSec);
      if (cue) {
        context.font = '36px sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        for (const [index, line] of cue.text.split('\n').entries()) {
          const y = canvas.height * 0.91 + index * 40;
          const width = Math.min(canvas.width * 0.8, context.measureText(line).width) + 34;
          context.fillStyle = 'black';
          context.globalAlpha = 0.9;
          context.fillRect((canvas.width - width) / 2, y - 22, width, 44);
          context.globalAlpha = 1;
          context.fillStyle = 'white';
          context.fillText(line, canvas.width / 2, y, canvas.width * 0.8);
        }
      }
      await video.add(time, Math.min(1 / bundle.fps, bundle.durationSec - time));
      while (!packet.done && packet.value.timestamp <= time + 1) {
        await audio.add(packet.value, first ? { decoderConfig } : undefined);
        first = false;
        packet = await audioPackets.next();
      }
      if (frame % bundle.fps === 0 || frame + 1 === frames) {
        const elapsedSec = (performance.now() - startedAt) / 1000;
        onProgress({ frame: frame + 1, frames, elapsedSec, remainSec: elapsedSec * (frames - frame - 1) / (frame + 1) });
      }
    }
    while (!packet.done) {
      signal.throwIfAborted();
      await audio.add(packet.value, first ? { decoderConfig } : undefined);
      first = false;
      packet = await audioPackets.next();
    }
    await output.finalize();
    if (!target.buffer) throw new Error('导出没有返回完整文件');
    return new Blob([target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' });
  } catch (error) {
    await output.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    throw new Error(`第 ${Math.min(frame + 1, frames)} 帧：${error instanceof Error ? error.message : '视频导出未完成'}`);
  } finally {
    input.dispose();
  }
}
