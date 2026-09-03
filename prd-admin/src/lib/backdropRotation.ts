/**
 * 背景轮换：每 N 天换一张，纯函数、零状态。
 *
 * 为什么不是「存一个上次更换时间，到点了就换」：那个状态存哪都有坑——存本地则每台设备
 * 各换各的、清缓存就重来；存后端则要为一张装饰图建表和写接口。而**周期索引**
 * `floor(天数 / 每轮天数) % 素材数` 是纯函数：任何设备、任何时刻算出来都是同一张，
 * 可单测、可预告「下一张什么时候来」，而且换设备不会跳图。
 *
 * 代价（写明白，别让后来人以为是 bug）：所有人同一天看到的是同一张。
 * 这正是「我们自己的风格」想要的——它是产品的季节感，不是个人壁纸。
 */

export type BackdropAsset = {
  /** 稳定 id。素材换图不换 id 时，顺序不会被打乱。 */
  id: string;
  /** 展示名，设置面板里给人看的。 */
  name: string;
  /** 图片地址。留空表示「这一档就是不放图」。 */
  url: string;
  /** 一句话出处/风格说明。设置面板里显示，也是「我们自己的风格」的可核对之处。 */
  note?: string;
  /**
   * 这张图专用的压暗罩不透明度（0-1）。不写就走批次默认值。
   *
   * 存在的理由：随包素材之间明暗差很大，全批共用一个值必然有一头是错的——
   * 亮的那张压不住会抢标题，暗的那张压死了等于没放图。只在明显偏亮的条目上写。
   */
  dim?: number;
  /**
   * 这张图有意思的那一块该落在哪（CSS background-position，如 `70% 80%`）。
   *
   * 默认 cover + center 会把每张图的主体随机塞到画面正中——那正是内容所在，
   * 于是图最好看的部分永远被罩压得最狠，剩下四角是空的。写这个字段等于
   * 手动把主体挪到内容之外，是「背景和页面结合」里最便宜也最有效的一半。
   */
  focus?: string;
};

/** 一轮多少天。用户定的 10 天。 */
export const ROTATION_DAYS = 10;

const MS_PER_DAY = 86_400_000;

/** 从 epoch 起的天数（UTC）。用 UTC 而不是本地日：跨时区的人不会在同一时刻看到不同张。 */
export function dayIndex(at: number | Date = Date.now()): number {
  const ms = at instanceof Date ? at.getTime() : at;
  return Math.floor(ms / MS_PER_DAY);
}

/** 当前是第几轮。轮次单调递增，用来算「下一次换」。 */
export function cycleIndex(at: number | Date = Date.now(), days: number = ROTATION_DAYS): number {
  const d = Math.max(1, Math.floor(days));
  return Math.floor(dayIndex(at) / d);
}

/**
 * 当前该显示哪一张。空素材集返回 null——调用方据此完全不渲染背景层，
 * 页面不靠背景图成立（潜像场自己就够）。
 */
export function pickBackdrop<T>(assets: readonly T[], at: number | Date = Date.now(), days: number = ROTATION_DAYS): T | null {
  if (!assets.length) return null;
  const i = ((cycleIndex(at, days) % assets.length) + assets.length) % assets.length;
  return assets[i]!;
}

/** 下一次更换的时刻（该轮结束的那一瞬）。 */
export function nextRotationAt(at: number | Date = Date.now(), days: number = ROTATION_DAYS): Date {
  const d = Math.max(1, Math.floor(days));
  return new Date((cycleIndex(at, d) + 1) * d * MS_PER_DAY);
}

/**
 * 距下次更换还有几天。
 *
 * 向上取整：还剩 0.2 天时要说「还有 1 天」而不是「还有 0 天」——
 * 说「0 天」用户会以为现在就该换了，然后发现没换。
 */
export function daysUntilRotation(at: number | Date = Date.now(), days: number = ROTATION_DAYS): number {
  const now = at instanceof Date ? at.getTime() : at;
  return Math.max(1, Math.ceil((nextRotationAt(now, days).getTime() - now) / MS_PER_DAY));
}
