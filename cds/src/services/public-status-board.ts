/**
 * 公开状态页的对外载荷。
 *
 * 这个文件的全部价值是一条纪律：**对外载荷是白名单构造出来的，不是把内部对象
 * 删几个字段**。两种写法平时看不出差别，区别只在「日后有人给内部结构加了一个
 * 字段」的那一刻——删字段的写法会把新字段一路透出去，而且不会有任何东西变红。
 *
 * 所以这里每一个字段都是显式赋值，禁止 spread、禁止 `delete`、禁止
 * `Object.assign` 内部对象。要加一个对外字段，就得在这里手写一行——
 * 那一行就是「我确认它可以给陌生人看」的签名。
 *
 * 对外只剩四样东西：业务名（对外叫法）、红黄绿、近 7 天条带、更新时间。
 * 地址、判据、实际值、产物 URL、错误日志、分支名、提交号、项目 id、
 * 监控 id、探测间隔——一样都不出去。
 */

/** 对外状态四档。内部的 partial / 零样本 / 未实测在这里统统收敛，不向外解释细节。 */
export type PublicStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface PublicBoardDay {
  /** UTC 日期，YYYY-MM-DD。给「哪天出的事」一个锚点，不带时刻。 */
  day: string;
  status: PublicStatus;
}

export interface PublicBoardItem {
  name: string;
  status: PublicStatus;
  days: PublicBoardDay[];
}

export interface PublicBoardPayload {
  /** 面板标题 = 项目对外名称 */
  title: string;
  /** 一句结论。对外也先给判断，不让人自己数红绿（conclusion-before-numbers）。 */
  headline: string;
  status: PublicStatus;
  items: PublicBoardItem[];
  /** 数据生成时刻（epoch ms） */
  updatedAt: number;
  /** 多久更新一次，页面上写给读者看 */
  refreshHintSeconds: number;
}

/** 这个模块认得的**内部**输入。刻意写窄：多要一个字段就多一分泄漏面。 */
export interface PublicBoardSourceItem {
  /** 内部名，仅在没有对外叫法时兜底 */
  name: string;
  publicName?: string;
  /** 内部状态 */
  status: 'up' | 'down' | 'paused' | 'unknown';
  /** 是否真的探过（按容器状态推出来的不算） */
  measured: boolean;
  /** 被动监控的窗口样本量；0 = 没人用过，对外只说「暂无数据」 */
  sampleCount?: number;
  observeMode?: 'active' | 'passive';
  /** 近 7 天按天聚合，最早在前 */
  days: ReadonlyArray<{ day: string; up: number; down: number }>;
}

const SEVERITY: Record<PublicStatus, number> = { down: 0, degraded: 1, unknown: 2, ok: 3 };

/**
 * 一条业务对外显示成什么。
 *
 * 被动监控窗口内零调用时判 `unknown` 而不是 `ok`：判据确实通过了，但那只证明
 * 「没人用坏」，证明不了「还能用」。对内叫「绿灯不作数」，对外就叫「暂无数据」——
 * 不吓人，也不撒谎。
 */
export function publicStatusOf(item: PublicBoardSourceItem): PublicStatus {
  if (item.status === 'down') return 'down';
  if (item.status === 'paused') return 'unknown';
  if (!item.measured) return 'unknown';
  if (item.observeMode === 'passive' && item.sampleCount === 0) return 'unknown';
  if (item.status === 'up') return 'ok';
  return 'unknown';
}

function dayStatus(day: { up: number; down: number }): PublicStatus {
  if (day.up === 0 && day.down === 0) return 'unknown';
  if (day.down === 0) return 'ok';
  if (day.up === 0) return 'down';
  return 'degraded';
}

function headlineOf(items: ReadonlyArray<PublicBoardItem>): { text: string; status: PublicStatus } {
  if (items.length === 0) {
    return { text: '这个面板还没有公开任何服务', status: 'unknown' };
  }
  const down = items.filter((i) => i.status === 'down').length;
  const degraded = items.filter((i) => i.status === 'degraded').length;
  const rest = items.length - down - degraded;
  if (down > 0) {
    return { text: `${down} 项服务异常，其余 ${items.length - down} 项正常`, status: 'down' };
  }
  if (degraded > 0) {
    return { text: `${degraded} 项服务不稳定，其余 ${rest} 项正常`, status: 'degraded' };
  }
  return { text: `${items.length} 项服务全部正常`, status: 'ok' };
}

export interface PublicBoardInput {
  title: string;
  items: ReadonlyArray<PublicBoardSourceItem>;
  now: number;
  refreshHintSeconds: number;
}

/**
 * 造对外载荷。每个字段显式赋值——这里没有 spread，也不许有。
 */
export function buildPublicStatusBoard(input: PublicBoardInput): PublicBoardPayload {
  const items: PublicBoardItem[] = input.items.map((item) => ({
    name: (item.publicName || '').trim() || item.name,
    status: publicStatusOf(item),
    days: item.days.map((d) => ({ day: d.day, status: dayStatus(d) })),
  }));
  // 排序只按严重度与名字：不按内部 id、不按加入顺序——那两者都会泄漏内部结构。
  items.sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.name.localeCompare(b.name));
  const headline = headlineOf(items);
  return {
    title: input.title,
    headline: headline.text,
    status: headline.status,
    items,
    updatedAt: input.now,
    refreshHintSeconds: input.refreshHintSeconds,
  };
}
