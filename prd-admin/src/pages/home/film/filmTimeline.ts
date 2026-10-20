/**
 * 首页片花的时间轴（SSOT）。
 *
 * 画面、配乐、进度条章节刻度、导出脚本全部从这一份表取时间——片花最容易坏的地方
 * 是「鼓点和切镜对不上」，而对不上的根因总是同一个：画面按秒写、音乐按拍写，
 * 两边各抄一份，改一处忘一处（`predicate-and-wiring-discipline` 形状 3）。
 * 所以这里只用一个单位：**小节**。拍速取自配乐（4/4 拍），任何一幕的起止都落在小节线上，
 * 切镜天然踩在强拍；配乐的剪接点也全部落在幕与幕之间（见 scoreEdit.json 与守卫测试）。
 *
 * 画面是时间的纯函数：给定 t 就只有一种画法，没有 CSS 动画、没有 setTimeout。
 * 这是它能被拖动进度条、能被逐帧导出成 MP4、并且两者一帧不差的前提。
 */
import scoreEdit from './scoreEdit.json';

/**
 * 拍速取自配乐剪辑表（scoreEdit.json）：片子按那首歌的小节来切，不是歌去迁就片子。
 * 121.5 BPM 下一小节 ≈ 1.975 秒；各幕仍按小节计长，换一首歌只改那份 JSON。
 */
export const BPM = scoreEdit.source.bpm;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

/** 片花的幕。`bars` 是这一幕占几个小节，起止秒数由累加得出，不手写。 */
export type FilmSceneId =
  | 'open'
  | 'partMap'
  | 'visual'
  | 'writing'
  | 'toolbox'
  | 'workflow'
  | 'partGateway'
  | 'models'
  | 'partCds'
  | 'cds'
  | 'montage'
  | 'finale';

/**
 * 片子里的功能分属三个产品：MAP（智能体平台）、LLMGW（模型网关）、CDS（分支预览）。
 * 每个产品的第一幕之前插一张分幕卡，报出「接下来是谁」；各功能幕顶上也挂着所属产品的小标签。
 * part 是 i18n `film.parts` 的下标——幕属于哪个产品只在这张表里声明一次。
 */
export type FilmPart = 0 | 1 | 2;

const SCENE_BARS: Array<{ id: FilmSceneId; bars: number; part?: FilmPart; partCard?: boolean }> = [
  { id: 'open', bars: 4 },
  { id: 'partMap', bars: 1, part: 0, partCard: true },
  { id: 'visual', bars: 4, part: 0 },
  { id: 'writing', bars: 2, part: 0 },
  { id: 'toolbox', bars: 2, part: 0 },
  { id: 'workflow', bars: 2, part: 0 },
  { id: 'partGateway', bars: 1, part: 1, partCard: true },
  { id: 'models', bars: 2, part: 1 },
  { id: 'partCds', bars: 1, part: 2, partCard: true },
  { id: 'cds', bars: 4, part: 2 },
  { id: 'montage', bars: 2 },
  { id: 'finale', bars: 4 },
];

export interface FilmScene {
  id: FilmSceneId;
  /** 起始小节（含） */
  bar: number;
  bars: number;
  from: number;
  to: number;
  /** 属于哪个产品（开场、快切、收口不属于任何一个） */
  part?: FilmPart;
  /** 是不是分幕卡 */
  partCard: boolean;
}

export const FILM_SCENES: FilmScene[] = (() => {
  let bar = 0;
  return SCENE_BARS.map(({ id, bars, part, partCard }) => {
    const scene = { id, bar, bars, from: bar * BAR, to: (bar + bars) * BAR, part, partCard: Boolean(partCard) };
    bar += bars;
    return scene;
  });
})();

export const TOTAL_BARS = FILM_SCENES[FILM_SCENES.length - 1].bar + FILM_SCENES[FILM_SCENES.length - 1].bars;
export const FILM_DURATION = TOTAL_BARS * BAR;

/** 某一幕的起点秒数。拿不到就抛——幕名写错不许静默落到 0 秒。 */
export function sceneStart(id: FilmSceneId): number {
  const scene = FILM_SCENES.find((s) => s.id === id);
  if (!scene) throw new Error(`unknown film scene: ${id}`);
  return scene.from;
}

/**
 * 海报帧：未播放时停在收口那一幕 logo 与标语已落定、片内「进入 MAP」按钮还没出现的那一刻。
 * 按钮那块位置留给播放器的播放键——海报上若同时有一颗画出来的按钮，看着能点、点了却只是播放，是个假按钮。
 */
export const POSTER_TIME = sceneStart('finale') + BAR * 1.5;

/** 收口那一幕里「进入 MAP」按钮出现的时刻（相对收口起点）。画面与海报帧共用这一个数。 */
export const FINALE_CTA_AT = BAR * 1.75;

export function sceneAt(t: number): FilmScene {
  for (const scene of FILM_SCENES) {
    if (t < scene.to) return scene;
  }
  return FILM_SCENES[FILM_SCENES.length - 1];
}

// ── 动画小工具：全部是 t 的纯函数 ──

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** t 在 [a, b] 里走到了几成（0~1，两端夹住）。 */
export function span(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  return clamp01((t - a) / (b - a));
}

export function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - clamp01(x), 3);
}

export function easeInOutCubic(x: number): number {
  const c = clamp01(x);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** 回弹出场：冲过头一点再回来，给「落定」的质感。 */
export function easeOutBack(x: number): number {
  const c = clamp01(x);
  const k = 1.70158;
  return 1 + (k + 1) * Math.pow(c - 1, 3) + k * Math.pow(c - 1, 2);
}

export function lerp(a: number, b: number, x: number): number {
  return a + (b - a) * x;
}

/** 距离最近一个拍点过去了多久的衰减脉冲（拍点上为 1，半拍内衰减到 0）。 */
export function beatPulse(t: number, sharpness = 7): number {
  const phase = ((t % BEAT) + BEAT) % BEAT;
  return Math.exp(-phase * sharpness);
}

/** 确定性伪随机（mulberry32）：同一个种子永远同一串数，导出与在线播放一帧不差。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 打字效果：t 时刻该显示前几个字符。 */
export function typed(text: string, t: number, a: number, cps: number): string {
  const n = Math.max(0, Math.floor((t - a) * cps));
  return Array.from(text).slice(0, n).join('');
}

export function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
