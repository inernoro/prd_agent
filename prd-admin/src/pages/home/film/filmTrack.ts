/**
 * 片花的成品配乐：从 Suno 原曲剪出来的那一段（public/film/landing-score.mp3）。
 *
 * 剪法写在 scoreEdit.json（现行是原曲连续一整段 29 小节，不拼接），剪辑脚本是
 * scripts/film/build-score.py，逐样本对齐片长。时间轴的拍速也读那份 JSON，所以画面与这段音频天然同拍。
 *
 * 播放器与 filmScore 的 FilmScorePlayer 同一个接口（FilmAudio）：音频文件取不到、解不开时，
 * 播放器退回代码合成的那一版，并在控制条上写明（降级必须留痕，不许悄悄换一首歌）。
 */

/** 播放器对外的最小接口：片内时间以音频时钟为准，画面反过来读它。 */
export interface FilmAudio {
  /** 片内时间（秒） */
  readonly time: number;
  start(from: number): void;
  stop(): void;
  setMuted(muted: boolean): void;
}

export const FILM_TRACK_URL = `${import.meta.env.BASE_URL}film/landing-score.mp3`;

// 用 MP3 而不是 AAC：开源版 Chromium 解不开 AAC（见 build-score.py 头注释）

/** 主音量：成品已限幅到 -0.2 dBFS 左右，这里再让一点，和页面上其它声音不打架 */
const LEVEL = 0.9;

let pending: Promise<AudioBuffer> | null = null;

/**
 * 取回并解码成品配乐。只取一次，重复调用共用同一个 Promise。
 * 用 OfflineAudioContext 解码：它不需要用户手势，所以可以在片花滚进视口之前就解好，
 * 点播放时音乐立刻出声（AudioBuffer 不绑定上下文，解出来的可以交给任何一个 AudioContext 播）。
 * 失败时把 Promise 清掉，下一次还能重试。
 */
export function loadFilmTrack(): Promise<AudioBuffer> {
  if (pending) return pending;
  const job = (async () => {
    const res = await fetch(FILM_TRACK_URL);
    if (!res.ok) throw new Error(`配乐取回失败：HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    const Offline = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Offline) throw new Error('当前浏览器没有 OfflineAudioContext');
    const decoder = new Offline(2, 1, 48000);
    return await decoder.decodeAudioData(data);
  })();
  pending = job;
  job.catch(() => {
    if (pending === job) pending = null;
  });
  return job;
}

export class FilmTrackPlayer implements FilmAudio {
  private readonly out: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private startAt = 0;

  constructor(
    readonly ctx: AudioContext,
    private readonly buffer: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = LEVEL;
    this.out.connect(ctx.destination);
  }

  get time(): number {
    return this.ctx.currentTime - this.startAt;
  }

  setMuted(muted: boolean): void {
    const g = this.out.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(muted ? 0 : LEVEL, now + 0.08);
  }

  start(from: number): void {
    this.stop();
    // 留 60ms 让音频线程接住，和合成版同一个提前量
    const when = this.ctx.currentTime + 0.06;
    this.startAt = when - from;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.out);
    source.start(when, Math.max(0, Math.min(from, this.buffer.duration)));
    this.source = source;
  }

  stop(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    try {
      source.stop();
    } catch {
      // 还没开始就被停掉时有的浏览器会抛，无害
    }
    source.disconnect();
  }
}
