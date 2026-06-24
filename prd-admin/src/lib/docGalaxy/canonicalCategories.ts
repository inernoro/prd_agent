// 知识库文档星系 —— canonical appname 分类 SSOT（前端侧）
//
// 对齐 doc/rule.doc.naming.md 的「canonical appname 分类（固化清单）」：
// 文档命名 {type}.{appname}[.{子模块}].md 里第二段 appname 归四大类。
// 本表只在「文档库走点分命名约定」时用作根分类增强；通用知识库（任意 GitHub 仓库）
// 不依赖本表，buildDocGalaxy 会退回文件夹/parentId 层级。
//
// 注意：这是「分类增强」而非硬依赖。新增应用 Agent 时同步本表与
// prd-api 的 AppCallerRegistry / rule.platform.app-identity。

export const CANONICAL_CATEGORY = {
  APP_AGENT: '应用 Agent',
  PLATFORM: '平台基础设施',
  CROSS_CUT: '跨切面保留域',
  TOP_LEVEL: '顶层产品',
  UNCLASSIFIED: '未分类',
} as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORY)[keyof typeof CANONICAL_CATEGORY];

// 一、应用 Agent（对齐 app-identity appKey）
const APP_AGENT_NAMES = [
  'visual-agent', 'literary-agent', 'defect-agent', 'report-agent', 'video-agent',
  'review-agent', 'pr-review', 'workflow-agent', 'product-agent', 'speech-agent',
  'shortcuts-agent', 'front-end-agent', 'channel-agent', 'ccas-agent', 'page-agent',
  'prd-agent', 'agent-universe', 'emergence', 'marketplace', 'open-platform',
  'knowledge-base', 'web-hosting', 'daily-tips', 'team-activity', 'ai-toolbox',
  'arena', 'md-to-ppt', 'submission-gallery', 'executive-dashboard', 'admin',
  'desktop', 'infra-sandbox-agent', 'acceptance',
];

// 二、平台基础设施
const PLATFORM_NAMES = ['cds', 'platform'];

// 三、跨切面保留域
const CROSS_CUT_NAMES = ['frontend', 'skill', 'doc'];

// 四、顶层产品（无 appname 段，保留概念名）
const TOP_LEVEL_NAMES = ['prd', 'srs', 'project-vision'];

const CATEGORY_BY_APPNAME: Record<string, CanonicalCategory> = Object.fromEntries([
  ...APP_AGENT_NAMES.map((a) => [a, CANONICAL_CATEGORY.APP_AGENT] as const),
  ...PLATFORM_NAMES.map((a) => [a, CANONICAL_CATEGORY.PLATFORM] as const),
  ...CROSS_CUT_NAMES.map((a) => [a, CANONICAL_CATEGORY.CROSS_CUT] as const),
  ...TOP_LEVEL_NAMES.map((a) => [a, CANONICAL_CATEGORY.TOP_LEVEL] as const),
]);

/**
 * 把 appname 归到 canonical 四大类之一；不在清单里返回「未分类」。
 * 供 buildDocGalaxy 作为可注入的 classifyAppname 使用（仅在点分命名库启用）。
 */
export function classifyCanonicalAppname(appname: string): CanonicalCategory {
  return resolveCanonicalAppname(appname).category;
}

export interface ResolvedAppname {
  category: CanonicalCategory;
  /** 命中的 canonical appname（精确或前缀匹配到的），未命中则原样返回。 */
  appname: string;
  /** 旧扁平名前缀匹配后剩余的部分，作为子模块下钻。 */
  sub?: string;
}

/**
 * 解析 appname → 分类 + 规范 appname + 剩余子模块。
 * 比 classifyCanonicalAppname 多做「最长 canonical 前缀匹配」，容忍旧扁平命名：
 *   cds-project-migration → { 平台基础设施, cds, project-migration }
 *   team-activity-voc     → { 应用 Agent, team-activity, voc }
 * 精确命中优先（defect-agent 整段命中，不会被拆成 defect + agent）。
 */
export function resolveCanonicalAppname(appname: string): ResolvedAppname {
  const exact = CATEGORY_BY_APPNAME[appname];
  if (exact) return { category: exact, appname };

  let best = '';
  for (const c of Object.keys(CATEGORY_BY_APPNAME)) {
    if (appname.startsWith(c + '-') && c.length > best.length) best = c;
  }
  if (best) {
    return { category: CATEGORY_BY_APPNAME[best], appname: best, sub: appname.slice(best.length + 1) };
  }
  return { category: CANONICAL_CATEGORY.UNCLASSIFIED, appname };
}

/** 该 appname 是否在 canonical 清单内（可从根索引到，非悬空）。 */
export function isCanonicalAppname(appname: string): boolean {
  return appname in CATEGORY_BY_APPNAME;
}
