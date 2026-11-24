import { GROUP_MODE_LABELS, type GroupMode } from './siteGrouping';

export interface HeadlineInput {
  mode: GroupMode;
  /** 当前看的是哪一批：文件夹名 / 分组名 / 来源名；全部时传 null */
  scopeLabel?: string | null;
  /** 服务端口径的空间总数 */
  total: number;
  /** 本次已加载到前端的条数（分页未取完时 < total） */
  loaded: number;
  /** 当前是否真的加了筛选（文件夹/分组/标签/来源/搜索任一）；没加就不报「筛出多少」 */
  filtered: boolean;
  /** 已加载条目里最近 N 天新增的条数 */
  recentCount: number;
  recentDays?: number;
  /** 搜索/筛选后实际展示的条数；等于 loaded 时不单列 */
  shown: number;
}

export interface HeadlineView {
  /** 第一行主句：现在按什么组织、看的是哪一批 */
  lead: string;
  /** 第二段统计：总数 + 新增 + 筛选后条数 */
  stats: string;
}

/**
 * 主控台列表上方的结论行（设计稿屏 1·A：「按时间 · 本周  184 个站点 · 最近 7 天 12 个新增」）。
 *
 * 一条纪律：**分页没取完就不报「最近 N 天新增」**。
 * 列表一次只拉 200 条，若服务端总数更多，本地数出来的新增数只是这 200 条里的，
 * 说出来就是把局部当全局。宁可少说一句，也不给一个看着精确其实错的数
 * （`.claude/rules/no-rootless-tree.md`）。
 */
export function buildLibraryHeadline(input: HeadlineInput): HeadlineView {
  const days = input.recentDays ?? 7;
  const scope = input.scopeLabel?.trim() || '全部';
  const lead = `${GROUP_MODE_LABELS[input.mode]} · ${scope}`;

  const parts = [`${input.total.toLocaleString()} 个站点`];
  // loaded >= total 才代表「手里这批就是全部」，此时本地统计才等于全局统计
  if (input.loaded >= input.total && input.recentCount > 0) {
    parts.push(`最近 ${days} 天 ${input.recentCount.toLocaleString()} 个新增`);
  }
  if (input.filtered) {
    parts.push(`当前筛出 ${input.shown.toLocaleString()} 个`);
  }
  return { lead, stats: parts.join(' · ') };
}

/** 数「最近 N 天内创建」的条数；createdAt 解析不出来的不计入 */
export function countRecent(items: { createdAt: string }[], days = 7, now = Date.now()): number {
  const from = now - days * 86400000;
  let n = 0;
  for (const it of items) {
    const t = new Date(it.createdAt).getTime();
    if (!Number.isNaN(t) && t >= from && t <= now) n += 1;
  }
  return n;
}
