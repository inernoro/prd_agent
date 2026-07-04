import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sparkles, X, Pin, PinOff, MapPin, GraduationCap } from 'lucide-react';
import { OPEN_TIPS_DRAWER_EVENT, START_TUTORIAL_EVENT } from './TipsEntryButton';
import { matchPageGuide, isEditorPageGuide, filterPageTips, isUpdateTip, isUpdateReminderTip, pickAutoOpenUpdateTip, routePathOf } from './pageGuideMatch';
import { difficultyMeta } from './difficultyMeta';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { writeSpotlightPayload, SPOTLIGHT_PAYLOAD_UPDATED_EVENT } from './TipsRotator';
import { trackTip, dismissTipForever } from '@/services/real/dailyTips';

/**
 * 右下角「教程小书」悬浮球。
 *
 * 状态机:
 * - collapsed:常驻显示书图标(默认)
 * - expanded:抽屉展开,显示完整 tip 列表
 * - hidden:用户主动 X 收起,书图标缩到屏幕右边缘只露半截书脊
 * - edge-peek:hidden 状态下,鼠标进入右下 140px 区域时书图标自动滑出
 *
 * pinned 模式:用户点钉子后,小书永远完全显示,不会自动 collapse / hide。
 * 持久化:pinned + hidden 状态走 sessionStorage(用户偏好,关闭标签页重置)。
 *
 * 推送自动展开:有定向 tip 且未 seen 时,自动 collapsed → expanded;5s 内
 * 用户没 hover/点击则自动 collapsed,徽章保留。
 */

const PIN_KEY = 'tipsBookPinned';
const HIDDEN_KEY = 'tipsBookHidden';
/** 本 session 已自动弹过的 tip id 集合(按 id 记忆,新推送的 tip 还能再弹) */
const AUTO_OPENED_IDS_KEY = 'tipsBookAutoOpenedIds';
/** 自动弹出的日级节流:记录今日已自动弹过的日期串(YYYY-M-D)。
 *  无论是「首次兜底」还是「新推送定向 tip」,每天只允许自动弹一次。
 *  受 no-localStorage 规则约束走 sessionStorage,同 tab 内严格只弹一次;
 *  新 tab 同日仍会弹一次,这是 sessionStorage 的固有边界。 */
const AUTO_OPEN_DATE_KEY = 'tipsBookAutoOpenedDate';
/** 强制新手引导:本 session 已「自动开讲」过的本页教程(*-page-guide)sourceId 集合。
 *  tips 已由后端过滤掉「已学会」的——还在 tips 里 = 用户没走完整套，进该页就自动开讲一次，
 *  逼着人人都过一遍；本 session 内每条只自动开一次（避免切页反复弹），跨 session 未完成会再弹，
 *  直到用户点「完成」走完最后一步（SpotlightOverlay 末步才 markLearned）。 */
const AUTO_STARTED_GUIDES_KEY = 'tipsAutoStartedGuides';
/** 轻微提醒更新:本 session 已自动「悬浮气泡」弹过的 *-update-reminder sourceId 集合。
 *  跨 session 的「只弹一次」由 markLearned(服务端)兜底——气泡弹出当下即标记学会,
 *  之后不管用户取消还是点「知道了」都不再显示。本 session set 仅防同 session 内切页重弹。 */
const AUTO_STARTED_REMINDERS_KEY = 'tipsAutoStartedReminders';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hasAutoOpenedToday(): boolean {
  try {
    return sessionStorage.getItem(AUTO_OPEN_DATE_KEY) === todayStr();
  } catch {
    return false;
  }
}

function markAutoOpenedToday() {
  try {
    sessionStorage.setItem(AUTO_OPEN_DATE_KEY, todayStr());
  } catch {
    /* noop */
  }
}
/** 悬浮组整体折叠(书 + AppShell toast 铃铛联动):由任一端写,另一端订阅事件。
 *  AppShell 通过 import 这个常量读同一 key,避免字符串字面量漂移。 */
export const FLOATING_DOCK_COLLAPSED_KEY = 'floatingDockCollapsed';
/** 折叠状态变更事件名(同 tab 内 storage 事件不触发,必须用 CustomEvent) */
export const FLOATING_DOCK_EVENT = 'floating-dock-collapsed-changed';
/** dock 总高度变更事件:TipsDrawer 在抽屉展开/收起时广播,AppShell 通知卡据此动态定位避免重叠 */
export const FLOATING_DOCK_HEIGHT_EVENT = 'floating-dock-height-changed';
const AUTO_COLLAPSE_MS = 5000;

function isVisualAuditMode(search: string): boolean {
  try {
    return new URLSearchParams(search).get('visualAudit') === '1';
  } catch {
    return false;
  }
}

function readAutoOpenedIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(AUTO_OPENED_IDS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeAutoOpenedIds(ids: Set<string>) {
  try {
    sessionStorage.setItem(AUTO_OPENED_IDS_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* noop */
  }
}

export function TipsDrawer() {
  const navigate = useNavigate();
  const location = useLocation();
  const loaded = useDailyTipsStore((s) => s.loaded);
  const load = useDailyTipsStore((s) => s.load);
  const cardTips = useDailyTipsStore((s) => s.cardTips);
  const dismiss = useDailyTipsStore((s) => s.dismiss);
  const markLearned = useDailyTipsStore((s) => s.markLearned);
  const items = useDailyTipsStore((s) => s.items);
  const dismissed = useDailyTipsStore((s) => s.dismissed);
  const visualAuditMode = isVisualAuditMode(location.search);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // 各页头部内嵌的 <TipsEntryButton/> 点击时派发 OPEN_TIPS_DRAWER_EVENT → 展开抽屉
  useEffect(() => {
    const onOpen = () => { void load({ force: true }); setExpanded(true); };
    window.addEventListener(OPEN_TIPS_DRAWER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TIPS_DRAWER_EVENT, onOpen);
  }, [load]);

  // Spotlight 教程一旦「开讲」(任何 writeSpotlightPayload 调用都会广播此事件)就立刻收起教程抽屉。
  // 否则抽屉浮层(右上角,z-301)会盖住页面里被高亮的目标元素 —— 光圈打在抽屉自己的卡片上,
  // 用户看到的是「教程被小技巧(抽屉)拦住了」。抽屉本身已无存在必要:Spotlight 卡片自带步骤清单 + 进度。
  useEffect(() => {
    const onTourStart = () => setExpanded(false);
    window.addEventListener(SPOTLIGHT_PAYLOAD_UPDATED_EVENT, onTourStart);
    return () => window.removeEventListener(SPOTLIGHT_PAYLOAD_UPDATED_EVENT, onTourStart);
  }, []);

  // 编辑器教程(*-editor-page-guide)的锚点只在编辑器深层路由(/{agent}/:id、旧版 -fullscreen/)内存在。
  // 不在对应编辑器路由时,把它从抽屉轮播里过滤掉 —— 否则用户手动翻页到它、点 CTA 会跳到列表页起一个
  // 找不到 visual-editor-* 锚点的 tour,卡 10 秒超时(Codex P2)。在编辑器内则保留,供用户手动重开。
  const tips = cardTips().filter((t) => {
    if (!isEditorPageGuide(t.sourceId)) return true;
    const url = t.actionUrl || '';
    return location.pathname.startsWith(url + '/') || location.pathname.startsWith(url + '-fullscreen/');
  });
  // 触发(重新)挂钩:items / dismissed 变化时列表应刷新
  void items;
  void dismissed;

  // ── pin & hidden 状态(持久化) ──────────────────────────
  const [pinned, setPinned] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(PIN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [hiddenByUser, setHiddenByUser] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      if (pinned) sessionStorage.setItem(PIN_KEY, '1');
      else sessionStorage.removeItem(PIN_KEY);
    } catch {
      /* noop */
    }
  }, [pinned]);

  useEffect(() => {
    try {
      if (hiddenByUser) {
        sessionStorage.setItem(HIDDEN_KEY, '1');
        sessionStorage.setItem(FLOATING_DOCK_COLLAPSED_KEY, '1');
      } else {
        sessionStorage.removeItem(HIDDEN_KEY);
        sessionStorage.removeItem(FLOATING_DOCK_COLLAPSED_KEY);
      }
      window.dispatchEvent(new CustomEvent(FLOATING_DOCK_EVENT, {
        detail: { collapsed: hiddenByUser },
      }));
    } catch {
      /* noop */
    }
  }, [hiddenByUser]);

  // ── 订阅 dock 事件:AppShell 的铃铛召回时通知 TipsDrawer 同步 hidden state ──
  // 避免只单向广播(书 → 铃铛)导致铃铛召回后书仍然贴边,两个元素失步
  useEffect(() => {
    const onDockChange = (e: Event) => {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail;
      if (detail == null) return;
      // 只处理外部发起的变更(值不同 = 别人广播的),避免自己 useEffect dispatch
      // 触发自己的监听器形成循环
      setHiddenByUser((prev) => (prev === detail.collapsed ? prev : detail.collapsed));
    };
    window.addEventListener(FLOATING_DOCK_EVENT, onDockChange);
    return () => window.removeEventListener(FLOATING_DOCK_EVENT, onDockChange);
  }, []);

  // ── expanded 临时状态 ────────────────────────
  const [expanded, setExpanded] = useState<boolean>(false);
  // 「本页教程」语义:抽屉默认只展示与当前页相关的教程,避免在 A 页打开却弹出 B 页的教程
  //(用户 2026-06-04 反馈:每页顶部「本页教程」打开的却是别人的教程)。
  // 用户可显式切到「全部教程」浏览所有页面的教程;关闭抽屉后自动复位回「本页」。
  const [showAllPages, setShowAllPages] = useState<boolean>(false);

  // 注:右下角「教程小书」入口已删除(改为各页头部内嵌 TipsEntryButton),
  // 本组件只剩「展开后的教程抽屉气泡」一种可见形态——展开 = 渲染抽屉,未展开 = 不渲染。
  // 原先的 collapsed/hidden/edge-peek 状态机随小书一并移除;hiddenByUser 仅保留
  // 用于与 AppShell 通知铃铛的「整组贴边」联动(铃铛自带 edge-peek + 召回,见 AppShell)。

  // 当前页是否有「未走完的本页教程」(tips 已过滤掉已学会的)。渲染级单一真值:
  // 既供「强制自动开讲」用,也供下面两个抽屉自动展开 effect 做抑制判断——
  // 不依赖 effect 声明顺序(否则抽屉先展开、晚一步才标记节流,会和 Spotlight 叠加,Bugbot Medium)。
  // 用 store 稳定引用 items + dismissed(而非 cardTips() 每次新建的 tips 数组),memo 才真正能缓存(Bugbot)。
  // 与 TipsEntryButton 共用 matchPageGuide,避免两份 inline 拷贝随规则漂移。
  const pageGuideHere = useMemo(
    () => matchPageGuide(items, dismissed, location.pathname, location.search),
    [items, dismissed, location.pathname, location.search],
  );

  // ── 本页相关教程子集 ──────────────────────────────────
  // 与 TipsEntryButton 共用 filterPageTips(SSOT):只展示属于本页的教程,
  // 彻底消除「开 A 页弹 B 页教程」。带 location.search 让 query-scoped tip 按 tab 精确匹配(Codex P2)。
  const pageTips = useMemo(
    () => filterPageTips(items, dismissed, location.pathname, location.search),
    [items, dismissed, location.pathname, location.search],
  );
  // 抽屉实际展示的列表:默认「本页」,用户可切「全部」浏览所有页面的教程。
  const viewTips = showAllPages ? tips : pageTips;

  // ── 本页更新教程自动展开:抽屉唯一的自动弹出路径 ──────────────
  // 规则(用户 2026-06-11):推送只跟页面走 —— 没教程的页面绝不自动弹任何东西;
  // 有教程的页面只在两种情况自动出现:
  //   1) 新人没走完本页 *-page-guide → Spotlight 自动开讲(下面的 effect,优先级更高);
  //   2) 本页功能有更新(*-update-* / feature-release)且未学会 → 自动展开抽屉提醒一次(本 effect)。
  // 决策只看 pageTips(filterPageTips 按页过滤后的子集),且绝不自动切「全部教程」——
  // 这是「不会在 A 页弹 B 页教程」的结构性保证。
  //
  // 旧版「管理员定向推送(isTargeted)自动弹 + 不属本页就切全部教程」已删除:推送后台已下线,
  // 而 Track 统计埋点会给「看过一眼」的 tip 建 Delivery 记录,被 /visible 误判成 isTargeted,
  // 导致在无教程页面弹出「全部教程」面板(用户 2026-06-11 反馈「莫名其妙弹出,像病毒一样」)。
  useEffect(() => {
    if (visualAuditMode) return;
    if (!loaded) return;
    if (pageGuideHere) return; // 本页有未走完教程 → 由 Spotlight 自动开讲,不抢着展开抽屉(避免叠加)
    // 本页有未学会的「轻微提醒更新」且其精确目标页正是当前页 → 由下面的 Spotlight 气泡 effect 独占
    // 自动弹,抽屉不抢(避免双弹)。必须带精确路由判断:filterPageTips 会把 reminder 前缀匹配到子路由
    // (/visual-agent/:id),但 reminder 只在精确列表页弹;不判精确路由的话,子路由上的周更新教程抽屉会被
    // 这条「其实不会弹」的 reminder 误抑制(Bugbot Medium)。
    if (pageTips.some((t) => isUpdateReminderTip(t) && !t.learned && location.pathname === routePathOf(t.actionUrl))) return;
    if (hasAutoOpenedToday()) return; // 每天只自动弹一次
    const opened = readAutoOpenedIds();
    const updateTip = pickAutoOpenUpdateTip(pageTips, opened);
    if (!updateTip) return;

    opened.add(updateTip.id);
    writeAutoOpenedIds(opened);
    markAutoOpenedToday();

    // hidden 状态时先把书拉回来
    if (hiddenByUser) {
      setHiddenByUser(false);
    }
    setExpanded(true); // 保持「本页教程」语义(showAllPages 默认 false),绝不自动切「全部教程」
    // pageGuideHere 必须进 deps:否则首屏若落在「有教程页」early-return 后,
    // 切到「有更新页」时本 effect 不再 fire,更新提醒整 session 失效(Bugbot)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, pageTips, pageGuideHere, location.pathname, visualAuditMode]);

  // ── 轻微提醒更新:进入页面自动「悬浮气泡」弹一次,看过即不再显示 ──────────────
  // 用户诉求(2026-06-11):刚上线的小功能(如视觉创作首页可粘贴图片),用一个轻量悬浮气泡
  // 提醒「这里更新了」即可,不要做成要走流程的教程。进入对应页默认弹一次、只弹一次,
  // 不管用户取消还是点「知道了」都不再显示。
  //
  // 机制:写 Spotlight payload 直接在功能位置弹单步气泡(writeSpotlightPayload),
  // 同时立即 markLearned —— 非 page-guide 学会即从 items 移除 + 服务端持久化,跨 session 永不再弹。
  // 与抽屉自动展开互斥(上面的 effect 已用 isUpdateReminderTip 抑制)。优先级低于本页 *-page-guide
  // 强制开讲(新人先走完整套教程,reminder 等下次进页时再弹)。
  useEffect(() => {
    if (visualAuditMode) return;
    if (!loaded) return;
    if (pageGuideHere) return; // 本页有未走完的新手教程 → 先让 Spotlight 走完整套,不抢
    const reminder = pageTips.find((t) => isUpdateReminderTip(t) && !t.learned);
    if (!reminder || !reminder.sourceId) return;
    // 只在「精确目标页」弹/标记学会(Codex P2):reminder 是非 page-guide,filterPageTips 会把它
    // 前缀匹配到子路由(如 /visual-agent/:id 编辑器),但锚点(visual-image-btn)只在列表页存在。
    // 精确路由(非子路由前缀)即可阻止「在编辑器子路由弹空目标 + markLearned 永久消费」。
    // 不在此处再 document.querySelector(锚点):列表页走 Suspense 懒加载,本 effect 首次跑时锚点可能
    // 还没挂上;若因找不到锚点就 return 且不再重试(deps 不含 DOM 就绪信号),reminder 可能永远不自动弹
    // (Bugbot High)。锚点就绪交给 SpotlightOverlay 自身轮询(最多 10s + 「正在定位」提示)兜底:
    // 写 payload 后它会等锚点出现再画气泡;精确路由已保证锚点终会出现,不会误消费。
    if (location.pathname !== routePathOf(reminder.actionUrl)) return;
    // 同 session 内本页 *-page-guide 刚自动开讲/走完(完成时 markLearned 让 pageGuideHere 同 session 变 null)
    // → 不要紧接着再弹更新提醒:新人刚走完整套教程(里面已讲到该新功能),立刻又弹气泡是重复打断(Codex P2)。
    // 留到「下次进页」(page-guide 非本 session 新开)再弹。filterPageTips 不按 learned 过滤,
    // 已学会的 page-guide 仍在 pageTips 里,可据此拿到本页 page-guide 的 sourceId。
    let startedGuides: Set<string>;
    try { startedGuides = new Set(JSON.parse(sessionStorage.getItem(AUTO_STARTED_GUIDES_KEY) || '[]')); }
    catch { startedGuides = new Set(); }
    const pageGuide = pageTips.find((t) => typeof t.sourceId === 'string' && t.sourceId.endsWith('-page-guide'));
    if (pageGuide?.sourceId && startedGuides.has(pageGuide.sourceId)) return;

    let started: Set<string>;
    try { started = new Set(JSON.parse(sessionStorage.getItem(AUTO_STARTED_REMINDERS_KEY) || '[]')); }
    catch { started = new Set(); }
    if (started.has(reminder.sourceId)) return;
    started.add(reminder.sourceId);
    try { sessionStorage.setItem(AUTO_STARTED_REMINDERS_KEY, JSON.stringify(Array.from(started))); } catch { /* noop */ }
    // 占用当天「自动弹一次」额度:reminder 弹出当下即 markLearned 会把它移出 pageTips,
    // 上方抽屉自动展开 effect 的「有未学会 reminder 就跳过」守卫随之失效;若本页同时还有未学会的
    // 周更新教程,抽屉会在 reminder 气泡上层再自动展开(Bugbot Medium)。这里占掉日额度,抽屉本 session 不再自动弹。
    markAutoOpenedToday();
    void trackTip(reminder.id, 'clicked');
    writeSpotlightPayload(reminder); // 在 [data-tour-id=...] 位置弹单步气泡
    void markLearned(reminder.id);   // 看过即标记学会 → 之后永不再弹(取消/知道了都一样)
  }, [loaded, pageTips, pageGuideHere, markLearned, location.pathname, visualAuditMode]);

  // ── 新用户兜底自动弹抽屉:已移除 ──────────────────────────
  // 历史上「本日第一次访问且本页有任意 tip 就自动展开抽屉」会在用户没点任何按钮时
  // 自己弹出教程(例如本页 *-page-guide 已学会、却把残留的「本周改动」公告弹出来),
  // 用户 2026-06-04 反馈「没点按钮却弹窗出来教程」。教程入口已是页头常驻按钮(TipsEntryButton),
  // 不需要再自动展开抽屉来「证明书的存在」。保留的自动行为只剩两类(均为明确意图、均按页限定):
  //   1) 本页有未学会的更新教程 → 上面的 effect 自动弹(本页列表);
  //   2) 本页未走完的 *-page-guide → 下面的 effect 走 Spotlight 强制开讲(onboarding 规则)。

  // 关闭抽屉后复位回「本页」,保证下次打开还是本页教程语义
  useEffect(() => {
    if (!expanded) setShowAllPages(false);
  }, [expanded]);

  // ── dock 总高度广播:小书移除后底部不再有悬浮组,抽屉也改到右上角,dockBottom 恒为 20 ──
  // 不再随 expanded 变化、也不需要 ResizeObserver(它过去测书的高度,现在恒定 20,纯属空转,Bugbot)。
  // 只需在挂载时广播一次,把 AppShell 通知卡从书时代的默认底距(136)纠正到 20。
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(FLOATING_DOCK_HEIGHT_EVENT, { detail: { dockBottom: 20 } }));
  }, []);

  // ── 自动收起:expanded 5s 内无 hover / 点击就 collapsed ──────
  const drawerHoveredRef = useRef(false);
  useEffect(() => {
    if (!expanded) return;
    const timer = window.setTimeout(() => {
      if (drawerHoveredRef.current) return; // 鼠标在抽屉上,不收
      setExpanded(false);
    }, AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  // ── 徽章计数 ────────────────────────────────────────

  // ── 上报 seen(列表模式:抽屉展开时把当前可见的每条 tip 各上报一次)──
  const seenReportedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expanded) return;
    viewTips.forEach((t) => {
      if (seenReportedRef.current.has(t.id)) return;
      seenReportedRef.current.add(t.id);
      void trackTip(t.id, 'seen');
    });
  }, [expanded, viewTips]);

  const handleOpenTip = useCallback(
    (tip: (typeof tips)[number]) => {
      void trackTip(tip.id, 'clicked');
      // writeSpotlightPayload 会广播 SPOTLIGHT_PAYLOAD_UPDATED_EVENT,上面的 effect 据此收起抽屉,
      // 让 Spotlight 高亮的是页面真实元素而非被抽屉浮层挡住(用户:「教程被小技巧拦住了」)。
      writeSpotlightPayload(tip);
      const url = tip.actionUrl || '/';
      // 编辑器教程(*-editor-page-guide)的锚点在编辑器深层路由内 → 已经在该 url 或其子路由
      // (/{agent}/:id、旧版全屏 /{agent}-fullscreen/:id)时不 navigate,否则把用户从编辑器弹回列表页。
      // 普通(列表页)教程的锚点只在列表页存在 → 即便当前停在编辑器子路由(轮播可能先选中同
      // actionUrl 前缀的列表教程),也必须回到 actionUrl,否则 tour 在编辑器里找不到锚点,
      // 卡在「目标未找到」(Codex P2)。
      const isEditorGuide = isEditorPageGuide(tip.sourceId);
      // 编辑器教程的锚点只在深层路由(/{agent}/:id、旧版 -fullscreen/)存在 —— 停在列表页(pathname === url)
      // 不算「已在目标」,否则手动轮播到编辑器教程并在列表页点 CTA 会跳过导航、起一个找不到锚点的 tour(Bugbot)。
      // 故编辑器教程只认深层前缀;普通列表教程才用精确匹配。
      const alreadyAtTarget = isEditorGuide
        ? (location.pathname.startsWith(url + '/')
          || location.pathname.startsWith(url + '-fullscreen/'))
        : location.pathname === url;
      if (!alreadyAtTarget) {
        navigate(url);
      }
    },
    [navigate, location.pathname],
  );

  // ── 强制新手引导:进入任意页面,若该页有「未走完」的本页教程(*-page-guide),自动开讲一次 ──
  // 目标(用户 2026-06-02 强调):人人都过一次,避免「不知道怎么操作」;每个应用走自己的完整教程。
  // 机制:tips 已被后端过滤掉「已学会」的——所以本页教程还在 tips 里 = 没走完 → 自动开讲。
  //   只标 markLearned(末步「完成」)才算过,中途关闭不算,下次进该页(跨 session)会再弹。
  //   本 session 每条只自动弹一次(sessionStorage 记忆),避免同 session 内切来切去反复打断。
  useEffect(() => {
    if (visualAuditMode) return;
    if (!loaded) return;
    const guide = pageGuideHere;
    if (!guide || !guide.sourceId) return;
    let started: Set<string>;
    try { started = new Set(JSON.parse(sessionStorage.getItem(AUTO_STARTED_GUIDES_KEY) || '[]')); }
    catch { started = new Set(); }
    if (started.has(guide.sourceId)) return;
    started.add(guide.sourceId);
    try { sessionStorage.setItem(AUTO_STARTED_GUIDES_KEY, JSON.stringify(Array.from(started))); } catch { /* noop */ }
    // 两个抽屉自动展开 effect 已用 pageGuideHere 抑制,这里直接用 CTA 同款机制开讲
    handleOpenTip(guide);
  }, [loaded, pageGuideHere, handleOpenTip, visualAuditMode]);

  // 单套教程直接开讲(TipsEntryButton 派发 START_TUTORIAL_EVENT):找到该 tip 直接走 handleOpenTip,不展开面板。
  useEffect(() => {
    const onStart = (e: Event) => {
      const tipId = (e as CustomEvent<{ tipId?: string }>).detail?.tipId;
      if (!tipId) return;
      const tip = useDailyTipsStore.getState().items.find((t) => t.id === tipId);
      if (tip) handleOpenTip(tip);
    };
    window.addEventListener(START_TUTORIAL_EVENT, onStart);
    return () => window.removeEventListener(START_TUTORIAL_EVENT, onStart);
  }, [handleOpenTip]);

  const handleDismissTip = (tipId: string) => {
    void trackTip(tipId, 'dismissed');
    dismiss(tipId);
  };

  // 永久「不再提示」:写 User.DismissedTipIds,同时本 session 也不再展示
  const handleDismissForever = (tipId: string) => {
    void dismissTipForever(tipId);
    dismiss(tipId);
  };

  // 「我已学会」:写 User.LearnedTips,本地立即移除;
  // 与 dismiss-forever 不同 — 管理员升级 tip.Version 后会重新出现。
  const handleMarkLearned = (tipId: string) => {
    void markLearned(tipId);
    // 点「我已学会」即视为确认 → 收起抽屉。page-guide 学会后仍保留在 items 里(可重看),
    // 但此刻关掉抽屉给用户「已确认」的反馈;入口按钮仍在,随时可再点开重看。
    setExpanded(false);
  };

  // 小书「永远存在」:即使 tips 为空、也没 pinned,依然在右下角悬浮,
  // 保证用户随时能点进来看有什么教程。没有 tip 时点开会显示空状态。

  // ── 抽屉本体 ────────────────────────────────────────
  const drawer =
    expanded ? (
      <div
        onMouseEnter={() => {
          drawerHoveredRef.current = true;
        }}
        onMouseLeave={() => {
          drawerHoveredRef.current = false;
        }}
        style={{
          position: 'fixed',
          top: 56, // 头部教程入口下方(右上角)作为下拉气泡展开
          right: 16,
          width: 360,
          maxHeight: 'min(360px, calc(100vh - 120px))',
          borderRadius: 18,
          background:
            'linear-gradient(180deg, rgba(24,22,34,0.96), rgba(16,16,22,0.97))',
          border: '1px solid rgba(196,181,253,0.20)',
          backdropFilter: 'blur(22px) saturate(140%)',
          WebkitBackdropFilter: 'blur(22px) saturate(140%)',
          zIndex: 301,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow:
            '0 30px 80px -20px rgba(76,29,149,0.45), 0 0 0 1px rgba(255,255,255,0.03), 0 1px 0 rgba(255,255,255,0.06) inset',
          animation: 'tipsDrawerSlide 260ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div
          style={{
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary, #fff)',
            }}
          >
            <Sparkles size={14} style={{ color: '#c4b5fd' }} />
            {showAllPages ? '全部教程' : '本页教程'}
            {/* 「本页 / 全部」切换:仅当其它页面还有更多教程时才展示,避免无意义按钮 */}
            {(showAllPages || tips.length > pageTips.length) && (
              <button
                type="button"
                onClick={() => setShowAllPages((v) => !v)}
                title={showAllPages ? '只看本页教程' : '浏览全部页面的教程'}
                style={{
                  border: '1px solid rgba(196,181,253,0.30)',
                  background: 'rgba(196,181,253,0.10)',
                  color: '#c4b5fd',
                  cursor: 'pointer',
                  padding: '2px 7px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 600,
                  marginLeft: 2,
                }}
              >
                {showAllPages ? '只看本页' : `全部 ${tips.length}`}
              </button>
            )}
            {viewTips.length > 0 && (
              <span
                style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.55)',
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  marginLeft: 2,
                }}
              >
                {viewTips.length} 套
              </span>
            )}
            {pinned && (
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'rgba(196,181,253,0.16)',
                  color: '#c4b5fd',
                }}
              >
                已锁定
              </span>
            )}
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button
              type="button"
              onClick={() => setPinned((v) => !v)}
              title={pinned ? '取消锁定(可被自动收起)' : '锁定(始终显示)'}
              style={{
                border: 'none',
                background: pinned ? 'rgba(196,181,253,0.16)' : 'transparent',
                color: pinned ? '#c4b5fd' : 'rgba(255,255,255,0.45)',
                cursor: 'pointer',
                padding: 5,
                display: 'inline-flex',
                borderRadius: 6,
              }}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                if (!pinned) setHiddenByUser(true); // 非锁定时收到边缘
              }}
              title={pinned ? '关闭(锁定中,书继续显示)' : '关闭并收起到边缘'}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'rgba(255,255,255,0.45)',
                cursor: 'pointer',
                padding: 5,
                display: 'inline-flex',
                borderRadius: 6,
              }}
            >
              <X size={13} />
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '10px 10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {viewTips.length === 0 ? (
            <div
              style={{
                padding: '32px 12px',
                textAlign: 'center',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {/* 本页没有相关教程时,不再随机展示别页教程,而是给出明确空态 + 可主动浏览全部 */}
              {!showAllPages && tips.length > 0 ? (
                <>
                  本页暂无专属教程
                  <br />
                  <button
                    type="button"
                    onClick={() => setShowAllPages(true)}
                    style={{
                      marginTop: 10,
                      border: '1px solid rgba(196,181,253,0.35)',
                      background: 'rgba(196,181,253,0.12)',
                      color: '#c4b5fd',
                      cursor: 'pointer',
                      padding: '5px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    浏览全部教程({tips.length})
                  </button>
                </>
              ) : (
                <>
                  暂无教程
                  <br />
                  <span style={{ fontSize: 11, opacity: 0.7 }}>
                    有新教程时这里会自动弹出
                  </span>
                </>
              )}
            </div>
          ) : (
            // 列表模式(选择面板,诉求 4/7):本页每套教程一张卡,展示步数/约时/状态 + 「跟我做」。
            viewTips.map((t) => {
              const stepCount = t.autoAction?.steps?.length ?? 0;
              const estMin = stepCount > 0 ? Math.max(1, Math.round(stepCount * 0.5)) : 0;
              const diff = difficultyMeta(t.difficulty);
              const xpReward = t.xpReward ?? 0;
              const isUpdate = isUpdateTip(t);
              const isPageGuide = t.sourceId?.endsWith('-page-guide') ?? false;
              const accent = t.isTargeted
                ? 'rgba(244,63,94,0.95)'
                : t.learned
                  ? 'rgba(52,211,153,0.85)'
                  : 'rgba(167,139,250,0.95)';
              const chip = t.learned
                ? { text: '已学会', bg: 'rgba(52,211,153,0.14)', fg: 'rgba(52,211,153,0.95)', cap: true }
                : t.isTargeted
                  ? { text: '为你推送', bg: 'rgba(244,63,94,0.14)', fg: 'rgba(244,63,94,0.95)', cap: false }
                  : isUpdate
                    ? { text: '更新', bg: 'rgba(56,189,248,0.14)', fg: 'rgba(125,211,252,0.95)', cap: false }
                    : isPageGuide
                      ? { text: '推荐', bg: 'rgba(167,139,250,0.16)', fg: '#c4b5fd', cap: false }
                      : null;
              return (
                <div
                  key={t.id}
                  style={{
                    position: 'relative',
                    borderRadius: 12,
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderLeft: `3px solid ${accent}`,
                    background: 'rgba(255,255,255,0.03)',
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{ color: accent, marginTop: 1, flexShrink: 0, display: 'inline-flex' }}>
                      {stepCount > 0 ? <MapPin size={14} /> : <Sparkles size={14} />}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary,#fff)', lineHeight: 1.4 }}>
                        {t.title}
                      </div>
                      {(stepCount > 0 || chip) && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                          {stepCount > 0 && (
                            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                              {stepCount} 步 · 约 {estMin} 分钟 · +{xpReward} 经验
                            </span>
                          )}
                          {stepCount > 0 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600, background: diff.bg, color: diff.fg }}>
                              {diff.label}
                            </span>
                          )}
                          {chip && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600, background: chip.bg, color: chip.fg }}>
                              {chip.cap && <GraduationCap size={10} strokeWidth={2.6} />}
                              {chip.text}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDismissTip(t.id)}
                      title="本次关闭"
                      style={{ border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: 2, display: 'inline-flex', flexShrink: 0 }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {t.body && (
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'rgba(255,255,255,0.62)', whiteSpace: 'pre-wrap', paddingLeft: 22 }}>
                      {t.body}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 22 }}>
                    <button
                      type="button"
                      onClick={() => handleOpenTip(t)}
                      style={{
                        flex: 1,
                        border: '1px solid rgba(167,139,250,0.4)',
                        background: 'linear-gradient(135deg, rgba(168,85,247,0.22), rgba(99,102,241,0.16))',
                        color: '#c4b5fd',
                        cursor: 'pointer',
                        padding: '6px 10px',
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                      }}
                    >
                      <MapPin size={12} />
                      {stepCount > 0 ? (t.learned ? '重看一遍' : '跟我做') : (t.ctaText ?? '去看看')}
                    </button>
                    {!t.learned && stepCount > 0 && (
                      <button
                        type="button"
                        onClick={() => handleMarkLearned(t.id)}
                        title="我已学会(升级后会再次提醒)"
                        style={{ border: 'none', background: 'rgba(52,211,153,0.12)', color: 'rgba(52,211,153,0.95)', cursor: 'pointer', padding: '6px 9px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
                      >
                        <GraduationCap size={12} strokeWidth={2.4} />
                        已会
                      </button>
                    )}
                    {!isPageGuide && (
                      <button
                        type="button"
                        onClick={() => handleDismissForever(t.id)}
                        title="不再提示这条"
                        style={{ border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: '6px 4px', borderRadius: 8, fontSize: 11, flexShrink: 0 }}
                      >
                        不再提示
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <style>{`
          @keyframes tipsDrawerSlide {
            from { opacity: 0; transform: translateY(10px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>
      </div>
    ) : null;

  // 入口已改为内嵌进各页头部的 <TipsEntryButton/>(不再悬浮);本组件只负责展开后的教程抽屉气泡。
  return createPortal(drawer, document.body);
}
