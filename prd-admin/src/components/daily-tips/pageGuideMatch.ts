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
 * 取 actionUrl 的路由路径部分(去掉 ?query 和 #hash),用于和 location.pathname 比较。
 * 导航仍用完整 actionUrl(handleOpenTip),query 只在匹配阶段剥离。
 */
export function routePathOf(actionUrl: string): string {
  return actionUrl.split('?')[0].split('#')[0];
}

/**
 * actionUrl 的 query 约束是否被当前 location.search 满足。
 * - actionUrl 不带 query(绝大多数 tip)→ 恒真,只按路径匹配。
 * - actionUrl 带 query(deep-link 到具体子页 tab,如 nav-order-customize 的 `/settings?tab=nav-order`)
 *   → 要求其每个参数在当前 search 中同值出现,这样:
 *     · 仅路径比较会「永远匹配不上」(Codex:入口被隐藏)——已用 routePathOf 解决路径侧;
 *     · 仅剥离 query 又会「过度匹配」到 /settings 的每个 tab(Codex:account/skin tab 也弹 nav-order 教程)。
 *   两者都不对,正解是路径用 routePathOf 比 + query 用本函数 gate。
 */
export function actionQuerySatisfied(actionUrl: string, search: string): boolean {
  const qIndex = actionUrl.indexOf('?');
  if (qIndex < 0) return true;
  const want = new URLSearchParams(actionUrl.slice(qIndex + 1).split('#')[0]);
  const have = new URLSearchParams(search || '');
  for (const [k, v] of want) {
    if (have.get(k) !== v) return false;
  }
  return true;
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
  search = '',
): DailyTip | null {
  return items.find((t) => {
    if (dismissed.has(t.id)) return false;
    if (t.learned) return false; // 已学会的不再算「未走完」→ 不自动开讲、入口不脉冲(仍可手动重看)
    if (t.kind !== 'card' && t.kind !== 'spotlight') return false;
    if (typeof t.sourceId !== 'string' || !t.sourceId.endsWith('-page-guide') || !t.actionUrl) return false;
    if (!actionQuerySatisfied(t.actionUrl, search)) return false;
    const isEditor = isEditorPageGuide(t.sourceId);
    const url = routePathOf(t.actionUrl);
    if (pathname === url) return !isEditor;
    if (pathname.startsWith(url + '/') || pathname.startsWith(url + '-fullscreen/')) return isEditor;
    return false;
  }) ?? null;
}

/**
 * 当前路由「本页教程」集合 —— TipsDrawer(抽屉作用域)与 TipsEntryButton(按钮是否显示)
 * 共用的单一过滤逻辑(SSOT,避免两份 inline 拷贝随规则漂移)。
 *
 * 规则:
 * - 只看 card / spotlight 类,排除已 dismiss 的。
 * - 管理员定向推送(isTargeted):不限页面,始终纳入(否则会漏掉用户被推送的内容)。
 * - *-page-guide:按编辑器感知规则匹配(非编辑器走精确路由、编辑器走深层路由前缀),
 *   与 matchPageGuide 一致,避免列表页教程在编辑器子路由里被误纳入。
 * - 其余(功能公告 / 旧版短教程):按 actionUrl 精确或前缀匹配当前页。
 *
 * 入参用 store 的稳定引用 items + dismissed,这样调用方 useMemo([items, dismissed, pathname]) 能真正缓存。
 */
export function filterPageTips(
  items: DailyTip[],
  dismissed: Set<string>,
  pathname: string,
  search = '',
): DailyTip[] {
  return items.filter((t) => {
    if (dismissed.has(t.id)) return false;
    if (t.kind !== 'card' && t.kind !== 'spotlight') return false;
    if (t.isTargeted) return true;
    if (!t.actionUrl) return false;
    if (!actionQuerySatisfied(t.actionUrl, search)) return false;
    const url = routePathOf(t.actionUrl);
    const isPageGuide = typeof t.sourceId === 'string' && t.sourceId.endsWith('-page-guide');
    if (isPageGuide) {
      const isEditor = isEditorPageGuide(t.sourceId);
      if (pathname === url) return !isEditor;
      if (pathname.startsWith(url + '/') || pathname.startsWith(url + '-fullscreen/')) return isEditor;
      return false;
    }
    return pathname === url || pathname.startsWith(url + '/');
  });
}
