import type { DailyTip } from '@/services/real/dailyTips';

/**
 * sourceId 是否为「编辑器页教程」(*-editor-page-guide)——锚点只在编辑器深层路由
 * (/{agent}/:id、旧版 -fullscreen/) 内存在。统一判定,避免 TipsDrawer 的轮播过滤、
 * handleOpenTip 的导航守卫、matchPageGuide 三处各写各的 includes('editor') 而漂移(Bugbot)。
 * 必须同时满足 endsWith('-page-guide'),否则未来出现 sourceId 含 "editor" 的普通 tip 会被误判。
 */
export function isEditorPageGuide(sourceId: string | null | undefined): boolean {
  return typeof sourceId === 'string'
    && sourceId.endsWith('-page-guide')
    && sourceId.includes('editor');
}

/**
 * 去掉 actionUrl 的 query/hash,只取 pathname 部分。
 * 所有「location.pathname vs actionUrl」比对的唯一口径——actionUrl 可能带 query
 * (如 /marketplace?type=skill),而 React Router 的 location.pathname 永远不含 query/hash。
 */
export function actionUrlPath(actionUrl: string | null | undefined): string {
  return (actionUrl || '').split('?')[0].split('#')[0];
}

/**
 * 当前路由是否「落在」某条 tip 的目标页。**所有路由比对的唯一实现**——
 * matchPageGuide / TipsDrawer 的 tips 过滤 / pageMatchedIndex 兜底 / handleOpenTip 的
 * alreadyAtTarget 全部走这里,杜绝「某处 strip query 某处没 strip」的反复漂移(Bugbot 连环报)。
 *
 * - 编辑器教程(isEditor=true):深层前缀匹配(urlPath + '/' 或旧版 urlPath + '-fullscreen/')。
 * - 普通页面(isEditor=false):pathname 精确等于 urlPath;
 *   opts.allowListPrefix=true 时额外允许「列表路由前缀」(/defect-agent 命中 /defect-agent/123),
 *   用于非教程类 tip 的兜底匹配。
 */
export function routeMatchesActionUrl(
  pathname: string,
  actionUrl: string | null | undefined,
  isEditor: boolean,
  opts?: { allowListPrefix?: boolean },
): boolean {
  const urlPath = actionUrlPath(actionUrl);
  if (!urlPath) return false;
  if (isEditor) {
    return pathname.startsWith(urlPath + '/') || pathname.startsWith(urlPath + '-fullscreen/');
  }
  if (pathname === urlPath) return true;
  if (opts?.allowListPrefix) return pathname.startsWith(urlPath + '/');
  return false;
}

/**
 * 「为了让这条 tip 的 tour 锚点挂载,需不需要导航 + 导航到哪」的**唯一实现**。
 * 返回需要 navigate 的完整 url(含 query/hash);若当前已在目标状态则返回 null。
 *
 * 与「页面匹配」相反:页面匹配 strip query(判断 tip 属于哪个页面),但导航必须**保留 query 作为目标状态**
 * (如 /settings?tab=nav-order 必须切到该 tab 锚点才挂载)。handleOpenTip(CTA)与强制自动开讲 effect
 * 都走这里,避免「一处导航带 query 一处不带」的漂移(Bugbot/Codex 连环报)。
 *
 * - 编辑器教程:在深层路由(/{agent}/:id、旧版 -fullscreen/)即已到,query 无关 → null。
 * - 普通页 + actionUrl 含 query/hash:要求 pathname+search+hash 完全一致才算已到,否则返回完整 url。
 * - 普通页 + actionUrl 无 query:pathname 命中即算已到(不抹掉用户当前 query,不打扰)。
 */
export function tipNavTarget(
  tip: { actionUrl?: string | null; sourceId?: string | null },
  current: { pathname: string; search: string; hash: string },
): string | null {
  const url = tip.actionUrl || '/';
  const targetPath = actionUrlPath(url);
  if (isEditorPageGuide(tip.sourceId)) {
    return routeMatchesActionUrl(current.pathname, url, true) ? null : url;
  }
  const targetHasState = url.length > targetPath.length; // url 带 query/hash = 目标状态含 query
  if (targetHasState) {
    return (current.pathname + current.search + current.hash) === url ? null : url;
  }
  return current.pathname === targetPath ? null : url;
}

/**
 * 当前路由是否有「未走完的本页教程」——TipsDrawer(自动开讲 + 抑制抽屉自动展开)与
 * TipsEntryButton(入口闪烁/强调态)共用的单一匹配逻辑,避免两份 inline 拷贝随规则漂移(Bugbot)。
 *
 * 入参用 store 的稳定引用 items + dismissed(而非 cardTips() 每次新建的数组),
 * 这样调用方 useMemo([items, dismissed, pathname]) 才真正能缓存。
 *
 * 规则:
 * - tips 已被后端过滤掉「已学会」的 → 还在 items 里 = 没走完。
 * - 普通 *-page-guide 走「列表路由」(pathname === actionUrl)。
 * - *-editor-page-guide 走「深层路由」:pathname 以 actionUrl + '/' 或 actionUrl + '-fullscreen/' 开头
 *   (后者兼容旧版全屏编辑器路由,如 /visual-agent-fullscreen/:id)。
 */
export function matchPageGuide(
  items: DailyTip[],
  dismissed: Set<string>,
  pathname: string,
): DailyTip | null {
  return items.find((t) => {
    if (dismissed.has(t.id)) return false;
    if (t.kind !== 'card' && t.kind !== 'spotlight') return false;
    if (typeof t.sourceId !== 'string' || !t.sourceId.endsWith('-page-guide') || !t.actionUrl) return false;
    return routeMatchesActionUrl(pathname, t.actionUrl, isEditorPageGuide(t.sourceId));
  }) ?? null;
}
