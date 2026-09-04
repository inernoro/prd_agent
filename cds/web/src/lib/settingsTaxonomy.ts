/*
 * settingsTaxonomy — CDS 设置页分组的唯一词表（SSOT）。
 *
 * 背景（2026-09-02 用户反馈「当前 cds 项目的分类有点问题」）：项目设置原来只有
 * 「接入 / 运行时 / 危险区」三组，11 个页签全塞在「运行时」里——环境变量、存储、
 * 周期备份、统计、活动日志混在一起，用户找「数据库隔离」这种数据类设置时没有
 * 一眼能落的位置。系统设置那边也是各写各的组名（常用 / 接入 / 运行时）。
 *
 * 借鉴 GitHub 仓库设置（General / Access / Code and automation / Security /
 * Integrations / Danger zone）与 Vercel 项目设置（General / Git / Environment /
 * Data / Security / Advanced）的共同做法：**按用户来这里要回答的问题分组**，
 * 而不是按实现所在的模块分组。同一套组名两页共用，用户在哪一页都能凭直觉找。
 *
 * 六组的定义与顺序见 SETTINGS_GROUP_ORDER；每组只回答一个问题：
 *
 *   常用   — 我今天最可能来点什么（只允许系统设置用，项目设置不设快捷组）
 *   接入   — 这是谁、从哪来、谁能进
 *   运行   — 它怎么跑起来（环境、镜像、模式、compose）
 *   数据   — 它的数据放哪、分不分、备不备、搬不搬
 *   观测   — 它跑得怎么样（统计、日志、痕迹）
 *   危险区 — 删了就回不来的操作，永远垫底
 *
 * 页面里 TabGroup.label 的类型必须是 SettingsGroupLabel：写了词表外的组名直接
 * 编译不过；组的先后顺序由 tests/web/settings-taxonomy-guard.test.ts 守住。
 *
 * 新增页签时先问它回答哪个问题，再落组；答不上来的说明页签本身没想清楚。
 */

export const SETTINGS_GROUP_ORDER = ['常用', '接入', '运行', '数据', '观测', '危险区'] as const;

export type SettingsGroupLabel = (typeof SETTINGS_GROUP_ORDER)[number];

export interface SettingsGroupMeta {
  /** 这一组回答用户的哪个问题。放页签时先对这一句。 */
  question: string;
  /** 只有系统设置允许有这一组（项目设置不设快捷组，页签少、直接按问题找）。 */
  systemOnly?: boolean;
}

export const SETTINGS_GROUP_META: Record<SettingsGroupLabel, SettingsGroupMeta> = {
  常用: { question: '我今天最可能来点什么', systemOnly: true },
  接入: { question: '这是谁、从哪来、谁能进' },
  运行: { question: '它怎么跑起来' },
  数据: { question: '它的数据放哪、分不分、备不备、搬不搬' },
  观测: { question: '它跑得怎么样' },
  危险区: { question: '删了就回不来的操作' },
};

/**
 * 数据分类（与设置分组正交）。设置页「数据」组里的每个页签都应能说出自己管的是
 * 哪一类数据；不同类别的处置规则不同，混着管就会出「备份把可丢弃缓存也备了、
 * 却漏了唯一一份业务库」这类事。
 */
export const DATA_CLASS_ORDER = ['配置', '业务数据', '运行态', '审计证据'] as const;

export type DataClassLabel = (typeof DATA_CLASS_ORDER)[number];

export interface DataClassMeta {
  /** 丢了能不能从别处重建 */
  regenerable: boolean;
  /** 周期备份要不要管它 */
  backup: boolean;
  /** 分支删除时是否随之清理 */
  perBranchLifecycle: boolean;
  example: string;
}

export const DATA_CLASS_META: Record<DataClassLabel, DataClassMeta> = {
  配置: { regenerable: true, backup: true, perBranchLifecycle: false, example: 'BuildProfile、项目环境变量、虚拟 compose、配置快照' },
  业务数据: { regenerable: false, backup: true, perBranchLifecycle: false, example: 'Mongo / MySQL / Postgres 里的库（共享库或分支独立库）' },
  运行态: { regenerable: true, backup: false, perBranchLifecycle: true, example: '容器、包缓存挂载、构建产物、worktree' },
  审计证据: { regenerable: false, backup: true, perBranchLifecycle: false, example: '活动日志、Webhook 投递记录、验收报告、发布记录' },
};

/** 按词表顺序给分组排序；词表外的组名排最后（类型层已经拦住，这里只是兜底）。 */
export function compareSettingsGroups(a: string, b: string): number {
  const ia = (SETTINGS_GROUP_ORDER as readonly string[]).indexOf(a);
  const ib = (SETTINGS_GROUP_ORDER as readonly string[]).indexOf(b);
  return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
}
