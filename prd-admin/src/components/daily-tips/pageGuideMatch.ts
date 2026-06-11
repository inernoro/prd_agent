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
 * 是否为「更新教程」(*-update-YYYYwNN / feature-release)——本页功能本周有更新时的提醒类 tip。
 * TipsDrawer 的卡片 chip 与「本页更新自动展开」共用,避免两处 inline 判定漂移。
 */
export function isUpdateTip(t: DailyTip): boolean {
  return (t.sourceId?.includes('-update-') ?? false) || t.sourceType === 'feature-release';
}

/**
 * 是否为「轻微提醒更新」(sourceId 含 `-update-reminder`)——单步悬浮气泡式的新功能提醒,
 * 进入对应页面自动以 Spotlight 弹一次、看过即标记学会、之后永不再弹(不管取消还是知道了)。
 *
 * 与普通「更新教程」(*-update-YYYYwNN / feature-release)的区别:后者自动展开**抽屉**让用户
 * 主动「跟我做」,前者直接在功能位置弹一个**悬浮气泡**轻提醒。两条路径互斥:reminder 由
 * TipsDrawer 的专用 effect 走 Spotlight,因此必须从 pickAutoOpenUpdateTip(抽屉路径)里排除,
 * 否则同一条 tip 会既弹抽屉又弹气泡。
 */
export function isUpdateReminderTip(t: DailyTip): boolean {
  return t.sourceId?.includes('-update-reminder') ?? false;
}

/**
 * 「本页更新教程自动展开」的唯一决策函数(用户 2026-06-11 规则:推送只跟页面走)。
 *
 * 自动弹出仅两类,且都严格限定在「本页有教程」的页面:
 *   1) 新人没走完本页 *-page-guide → Spotlight 自动开讲(matchPageGuide,优先级更高,由调用方先判);
 *   2) 本页功能有更新(*-update-* / feature-release)且未学会 → 自动展开抽屉提醒一次(本函数)。
 * 没有教程的页面 pageTips 为空 → 恒返回 null,绝不弹任何东西。
 *
 * 入参 pageTips 必须是 filterPageTips 按当前页过滤后的子集 —— 这是「不会在 A 页弹 B 页教程」的
 * 结构性保证;历史 bug:旧版用全量 tips + isTargeted 判定,而 Track 统计埋点会给「看过一眼」的 tip
 * 建 Delivery 记录,被 /visible 误判成 isTargeted → 在无教程页面弹出「全部教程」面板
 * (用户 2026-06-11 反馈「莫名其妙弹出,像病毒一样」)。
 */
export function pickAutoOpenUpdateTip(
  pageTips: DailyTip[],
  alreadyOpened: Set<string>,
): DailyTip | null {
  // 排除「轻微提醒更新」(*-update-reminder):它走 Spotlight 悬浮气泡路径(TipsDrawer 专用 effect),
  // 不走抽屉自动展开,否则同一条会双弹。
  return pageTips.find(
    (t) => isUpdateTip(t) && !isUpdateReminderTip(t) && !t.learned && !alreadyOpened.has(t.id),
  ) ?? null;
}

/**
 * 当前路由「本页教程」集合 —— TipsDrawer(抽屉作用域)与 TipsEntryButton(按钮是否显示)
 * 共用的单一过滤逻辑(SSOT,避免两份 inline 拷贝随规则漂移)。
 *
 * 规则:
 * - 只看 card / spotlight 类,排除已 dismiss 的。
 * - 管理员定向推送 / 被投递的 tip(isTargeted):
 *   · 带 actionUrl(指向某个具体页面,如被投递给用户的 /web-pages、/settings 教程)→ 和普通教程一样
 *     **按页面限定**,只在该页的「本页教程」里出现。否则被投递过的教程会在**每个**页面的「本页教程」
 *     里冒出来(用户 2026-06-04 二次反馈:「当前页面出现了其他页面的教程」——网页托管/导航排序教程
 *     出现在不相干的页面上)。
 *   · 无 actionUrl(页面无关的纯个人消息,如「为你修复」通知,本就无处可去)→ 不限页面纳入,
 *     否则会漏掉这类个人推送。这类消息不属于任何页面,不会被误认成「别页教程」。
 *     注:被投递的 tip 仍由 TipsDrawer 的「定向推送自动展开」effect 用全量 tips 兜一次(本 session),
 *     即便按页限定后不在本页列表里,也不会真的漏看。
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
    // 被投递的 tip 若没有落点页面(actionUrl 为空)= 页面无关的纯个人消息,任意页保留;
    // 有 actionUrl 的被投递 tip 不在这里短路,继续往下走与普通教程相同的「按页面限定」匹配。
    if (t.isTargeted && !t.actionUrl) return true;
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
