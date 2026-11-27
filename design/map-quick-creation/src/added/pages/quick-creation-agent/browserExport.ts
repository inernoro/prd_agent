/**
 * 在用户浏览器里把成片导出成视频文件，服务器不渲染。
 *
 * 为什么物理上可行：成片的画面是 Canvas / WebGL 代码按时间逐帧画出来的（Lemo-Opuscar 的风格本来就这样做），
 * 每一帧就是画布上的像素，可以直接交给浏览器的硬件编码器（WebCodecs VideoEncoder），不需要把 HTML 截图。
 *
 * 正式实现（实现方照此替换 exportFilmInBrowser 的原型部分，依赖 Mediabunny，MPL-2.0，可商用；详见设计文档《成片时长与浏览器渲染》）：
 *   1. 取成片包：画面代码模块（导出 renderFrame(ctx, t)，同一个 t 永远画同一帧）、配音音轨、时间轴；先等字体与图片加载完。
 *   2. 画面：OffscreenCanvas 1920×1080；第 i 帧 t = i / fps，renderFrame 画完后 new VideoFrame(canvas, { timestamp })，
 *      交给 Mediabunny 的 CanvasSource / VideoSampleSource 编码（H.264，浏览器不支持时退到 VP9 + WebM），帧用完立即 close()。
 *      编码队列超过约 30 帧就等一等（encodeQueueSize），防止内存涨满。
 *   3. 声音不在浏览器里编码：服务端生成配音时顺手编好 AAC（m4a）与 Opus（webm）各一份，导出时把已编码的音频包直接写进文件
 *      （Mediabunny 的 EncodedAudioPacketSource）。这样 Safari 16.4 起就能导出（它的音频编码器到 26 才有），也避开 Firefox 编不了 AAC。
 *   4. Mediabunny 的 Output + Mp4OutputFormat（或 WebMOutputFormat）+ BufferTarget 封装，得到 Blob，生成下载。
 *   5. 渲染循环放在 Worker 里（OffscreenCanvas），不用 requestAnimationFrame：页面在后台时 rAF 会停，导出会卡住。
 *   6. 每 24 帧回报一次进度；可取消（AbortSignal）；失败要说清卡在哪一帧、是编码器不支持还是内存不足。
 */
import type { QcPlayBundle } from './types';

export type ExportContainer = 'mp4' | 'webm';

/** 这个浏览器能不能在本机合成：先试 H.264 + MP4，再试 VP9 + WebM；都不行返回 null（走「请服务器导出」兜底） */
export async function detectBrowserExport(bundle: Pick<QcPlayBundle, 'width' | 'height' | 'fps'>): Promise<ExportContainer | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  const tryCodec = async (codec: string) => {
    try { return (await VideoEncoder.isConfigSupported({ codec, width: bundle.width, height: bundle.height, framerate: bundle.fps, bitrate: 6_000_000 })).supported === true; } catch { return false; }
  };
  if (await tryCodec('avc1.640028')) return 'mp4';
  if (await tryCodec('vp09.00.40.08')) return 'webm';
  return null;
}

export interface ExportProgress { frame: number; frames: number; elapsedSec: number; remainSec?: number }
export interface ExportResult { url: string; fileName: string; bytes: number; container: ExportContainer }

/** 预估本机导出要多久：桌面浏览器硬件编码通常比实时快，按约 2 倍速估；手机按 1 倍速估 */
export function exportPlan(bundle: QcPlayBundle, durationSec: number, phone: boolean) {
  const frames = Math.round(durationSec * bundle.fps);
  return { frames, estSec: Math.max(5, Math.round(durationSec / (phone ? 1 : 2))) };
}

/**
 * 原型：不真正编码，按 exportPlan 的速度推进进度（演示时间压缩 25 倍），产物用演示成片文件。
 * 正式实现见文件头的六步；签名不变，页面不用改。
 */
export function exportFilmInBrowser(input: { bundle: QcPlayBundle; durationSec: number; title: string; container: ExportContainer; phone: boolean; mediaUrl?: string },
  onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  const { frames, estSec } = exportPlan(input.bundle, input.durationSec, input.phone);
  const demoMs = Math.max(2500, (estSec * 1000) / 25);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = window.setInterval(() => {
      if (signal.aborted) { window.clearInterval(timer); reject(new DOMException('已取消', 'AbortError')); return; }
      const ratio = Math.min(1, (Date.now() - started) / demoMs);
      const elapsedSec = Math.round(ratio * estSec);
      onProgress({ frame: Math.round(ratio * frames), frames, elapsedSec, remainSec: Math.max(0, estSec - elapsedSec) });
      if (ratio >= 1) {
        window.clearInterval(timer);
        resolve({ url: input.mediaUrl ?? '', fileName: `${input.title}.${input.container}`, bytes: Math.round(input.durationSec * 750_000), container: input.container });
      }
    }, 200);
  });
}
