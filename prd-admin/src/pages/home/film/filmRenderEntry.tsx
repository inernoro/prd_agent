import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';

import { translations } from '../i18n/landing';
import { FilmStage } from './FilmStage';
import { renderScoreOffline } from './filmScore';
import { FILM_DURATION, POSTER_TIME } from './filmTimeline';

/**
 * 片花导出入口：只给 `scripts/render-landing-film.mjs` 用，不进生产构建
 * （`scripts/film/render.html` 引用它，而那个 html 不在 vite build 的入口里）。
 *
 * 它把 FilmStage 裸挂在 1920×1080 的页面上，并暴露两件事给无头浏览器：
 *   · seek(t)：同步画出 t 时刻那一帧，等两次 rAF 保证已经上屏再返回；
 *   · renderAudio()：用 OfflineAudioContext 逐样本渲染整段配乐，返回 WAV 的 base64。
 * 与首页上播放的是同一个组件、同一份乐谱，导出的 MP4 与页面所见一帧不差。
 */

declare global {
  interface Window {
    __film?: {
      duration: number;
      poster: number;
      seek: (t: number) => Promise<void>;
      renderAudio: () => Promise<string>;
    };
  }
}

const lang = new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh';
const tr = translations[lang];
const roster = tr.tail.toolbox.groups.flatMap((g) => g.items);
const mount = document.getElementById('film');
if (!mount) throw new Error('#film mount point missing');
const root = ReactDOM.createRoot(mount);

function draw(t: number) {
  flushSync(() => root.render(<FilmStage t={t} copy={tr.film} roster={roster} />));
}

function wavBase64(buf: AudioBuffer): string {
  const channels = buf.numberOfChannels;
  const frames = buf.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + frames * channels * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      offset += 2;
    }
  }
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

window.__film = {
  duration: FILM_DURATION,
  poster: POSTER_TIME,
  seek: (t) =>
    new Promise((resolve) => {
      draw(t);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
  renderAudio: async () => wavBase64(await renderScoreOffline(48000)),
};
draw(0);
