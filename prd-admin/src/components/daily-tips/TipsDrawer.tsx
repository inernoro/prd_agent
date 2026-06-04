import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sparkles, X, Pin, PinOff, MapPin, ChevronLeft, ChevronRight, GraduationCap } from 'lucide-react';
import { OPEN_TIPS_DRAWER_EVENT } from './TipsEntryButton';
import { matchPageGuide, isEditorPageGuide } from './pageGuideMatch';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { writeSpotlightPayload } from './TipsRotator';
import { trackTip, dismissTipForever } from '@/services/real/dailyTips';
import { TipCard } from './TipCard';

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

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // 各页头部内嵌的 <TipsEntryButton/> 点击时派发 OPEN_TIPS_DRAWER_EVENT → 展开抽屉
  useEffect(() => {
    const onOpen = () => { void load({ force: true }); setExpanded(true); };
    window.addEventListener(OPEN_TIPS_DRAWER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TIPS_DRAWER_EVENT, onOpen);
  }, [load]);

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

  // ── expanded / 轮播 临时状态 ────────────────────────
  const [expanded, setExpanded] = useState<boolean>(false);
  // 轮播索引(抽屉当前展示第几条 tip)
  const [carouselIndex, setCarouselIndex] = useState<number>(0);

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
    () => matchPageGuide(items, dismissed, location.pathname),
    [items, dismissed, location.pathname],
  );

  // ── 推送自动展开:按 tip.id 记忆,每条定向 tip 本 session 只弹一次 ──
  // 轮询时如果管理员新推了一条,tips 里会多出一个 isTargeted 的新 id,它不在
  // 已弹过集合里 → 再自动弹一次。解决「session 第二条推送不弹」的坑。
  useEffect(() => {
    if (!loaded) return;
    if (location.pathname === '/') return; // 首页(登录落地页)只展示通知,不自动弹教程抽屉;首页若有专属教程走下方 Spotlight 自动开讲
    if (pageGuideHere) return; // 本页有未走完教程 → 由 Spotlight 自动开讲,不抢着展开抽屉(避免叠加)
    if (hasAutoOpenedToday()) return; // 每天只自动弹一次
    const opened = readAutoOpenedIds();
    const newTargeted = tips.find((t) => t.isTargeted && !opened.has(t.id));
    if (!newTargeted) return;

    opened.add(newTargeted.id);
    writeAutoOpenedIds(opened);
    markAutoOpenedToday();

    // hidden 状态时先把书拉回来
    if (hiddenByUser) {
      setHiddenByUser(false);
    }
    setExpanded(true);
    // pageGuideHere 必须进 deps:否则首屏若落在「有教程页」early-return 后,
    // 切到「无教程页」时本 effect 不再 fire,自动弹窗整 session 失效(Bugbot)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tips, pageGuideHere]);

  // ── 新用户兜底:本 session 第一次访问、有任意 tip 时自动弹一次 ──
  // 让用户第一次看到书时就知道它是做什么的(管理员没推送也能看到 seed 内容)
  // 新用户兜底:本日第一次访问、有任意 tip 时自动弹一次
  // 让用户第一次看到书时就知道它是做什么的(管理员没推送也能看到 seed 内容)
  // 日级节流 AUTO_OPEN_DATE_KEY 是单一 source of truth;
  // 历史的 FIRST_VISIT_SHOWN_KEY 已删除以避免与日级节流双 flag 不一致
  // (bugbot ref1: 旧 flag 会在 targeted-tip 路径先触发时永远不被写入,跨日 remount 会让新用户路径误触发)
  useEffect(() => {
    if (!loaded) return;
    if (location.pathname === '/') return; // 首页(登录落地页)只展示通知,不自动弹教程抽屉;首页若有专属教程走下方 Spotlight 自动开讲
    if (pageGuideHere) return; // 本页有未走完教程 → 走 Spotlight 自动开讲,不展开抽屉(避免叠加)
    if (tips.length === 0) return;
    if (hasAutoOpenedToday()) return; // 每天只自动弹一次
    markAutoOpenedToday();
    setExpanded(true);
    // pageGuideHere 必须进 deps:deps 仅在 tips 首次加载时翻一次,若那一刻当前页有教程被
    // early-return,切到无教程页后本 effect 永不再 fire → 抽屉整 session 不再自动弹(Bugbot)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tips.length > 0, pageGuideHere]);

  // ── 强制新手引导:进入任意页面,若该页有「未走完」的本页教程(*-page-guide),自动开讲一次 ──
  // 目标(用户 2026-06-02 强调):人人都过一次,避免「不知道怎么操作」;每个应用走自己的完整教程。
  // 机制:tips 已被后端过滤掉「已学会」的——所以本页教程还在 tips 里 = 没走完 → 自动开讲。
  //   只标 markLearned(末步「完成」)才算过,中途关闭不算,下次进该页(跨 session)会再弹。
  //   本 session 每条只自动弹一次(sessionStorage 记忆),避免同 session 内切来切去反复打断。
  useEffect(() => {
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
    void trackTip(guide.id, 'clicked');
    writeSpotlightPayload(guide);
  }, [loaded, pageGuideHere]);

  // tips 变化时把轮播索引收敛到有效范围
  useEffect(() => {
    if (tips.length === 0) {
      setCarouselIndex(0);
    } else if (carouselIndex >= tips.length) {
      setCarouselIndex(tips.length - 1);
    }
  }, [tips.length, carouselIndex]);

  // 抽屉每次「打开」时选一条 tip,避免用户每次都看到同一条;
  // 优先级:当前页面有匹配的「本页教程」→ 选它(让用户在正确位置看到「这页有教程」);否则随机。
  const pageMatchedIndex = useMemo(() => {
    if (tips.length === 0) return -1;
    // 先按 matchPageGuide 的编辑器感知规则定位本页教程:在 /visual-agent/:id 这类编辑器子路由
    // 上,它只命中 *-editor-page-guide,不会误选同 actionUrl 前缀的列表教程(后者 CTA 会把用户
    // 导离编辑器,Codex P2)。
    const guide = matchPageGuide(tips, dismissed, location.pathname);
    if (guide) {
      const gi = tips.findIndex((t) => t.id === guide.id);
      if (gi >= 0) return gi;
    }
    // 非教程类 tip 兜底:完整匹配 / 列表路由前缀匹配(/defect-agent 匹配 /defect-agent/123)
    return tips.findIndex((t) => {
      if (!t.actionUrl) return false;
      return location.pathname === t.actionUrl
        || location.pathname.startsWith(t.actionUrl + '/');
    });
  }, [tips, dismissed, location.pathname]);

  const lastExpandedRef = useRef(false);
  useEffect(() => {
    if (expanded && !lastExpandedRef.current) {
      // 上次未打开 → 这次打开 → 重新选 index
      if (pageMatchedIndex >= 0) {
        setCarouselIndex(pageMatchedIndex);
      } else if (tips.length > 0) {
        setCarouselIndex(Math.floor(Math.random() * tips.length));
      }
    }
    lastExpandedRef.current = expanded;
  }, [expanded, pageMatchedIndex, tips.length]);

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

  // ── 上报 seen(轮播模式下只上报当前展示的那一条,减少一次性打 4-5 条 API 的负载)──
  const seenReportedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expanded || tips.length === 0) return;
    const current = tips[Math.min(carouselIndex, tips.length - 1)];
    if (!current || seenReportedRef.current.has(current.id)) return;
    seenReportedRef.current.add(current.id);
    void trackTip(current.id, 'seen');
  }, [expanded, tips, carouselIndex]);

  const handleOpenTip = useCallback(
    (tip: (typeof tips)[number]) => {
      void trackTip(tip.id, 'clicked');
      writeSpotlightPayload(tip);
      // 抽屉故意保留打开,让用户边跟着 Spotlight 引导,边对照教程步骤 /
      // 决定点「不再提示」;不再像以前那样 setExpanded(false) 把引导面板秒关。
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
    // 列表清空时自动收起,避免用户看到空抽屉
    if (tips.length <= 1) {
      setExpanded(false);
    }
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
            教程
            {tips.length > 0 && (() => {
              const cur = tips[Math.min(carouselIndex, tips.length - 1)];
              return (
                <button
                  type="button"
                  onClick={() => handleMarkLearned(cur.id)}
                  title="我已学会(收起本条;升级后会再次出现)"
                  style={{
                    border: 'none',
                    background: 'rgba(52,211,153,0.12)',
                    color: 'rgba(52,211,153,0.95)',
                    cursor: 'pointer',
                    padding: '3px 7px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    marginLeft: 2,
                  }}
                >
                  <GraduationCap size={11} strokeWidth={2.4} />
                  我已学会
                </button>
              );
            })()}
            {tips.length > 1 && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  marginLeft: 4,
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setCarouselIndex((i) => (i - 1 + tips.length) % tips.length)
                  }
                  title="上一条"
                  style={{
                    border: 'none',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(255,255,255,0.65)',
                    cursor: 'pointer',
                    padding: '3px 4px',
                    display: 'inline-flex',
                    borderRadius: 6,
                  }}
                >
                  <ChevronLeft size={12} />
                </button>
                <span
                  style={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.55)',
                    fontFamily: 'ui-monospace, Menlo, monospace',
                    minWidth: 32,
                    textAlign: 'center',
                  }}
                >
                  {Math.min(carouselIndex, tips.length - 1) + 1} / {tips.length}
                </span>
                <button
                  type="button"
                  onClick={() => setCarouselIndex((i) => (i + 1) % tips.length)}
                  title="下一条"
                  style={{
                    border: 'none',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(255,255,255,0.65)',
                    cursor: 'pointer',
                    padding: '3px 4px',
                    display: 'inline-flex',
                    borderRadius: 6,
                  }}
                >
                  <ChevronRight size={12} />
                </button>
              </div>
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
          {tips.length === 0 ? (
            <div
              style={{
                padding: '32px 12px',
                textAlign: 'center',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              暂无教程
              <br />
              <span style={{ fontSize: 11, opacity: 0.7 }}>
                有新教程时这里会自动弹出
              </span>
            </div>
          ) : (() => {
            // 轮播模式:只渲染当前索引的 tip;分页器在上面 header 里
            const t = tips[Math.min(carouselIndex, tips.length - 1)];
            const stepCount = t.autoAction?.steps?.length ?? 0;
            const stepsPreview =
              stepCount > 0
                ? `📍 ${stepCount} 步 · 跳转 → 高亮 → 点击`
                : null;
            return (
              <TipCard
                key={t.id}
                icon={<MapPin size={14} />}
                accent={
                  t.isTargeted
                    ? 'rgba(244,63,94,0.95)'
                    : 'rgba(52,211,153,0.95)'
                }
                title={t.title}
                body={
                  <>
                    {stepsPreview && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'rgba(196,181,253,0.85)',
                          marginBottom: 6,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        }}
                      >
                        {stepsPreview}
                      </div>
                    )}
                    {t.body && (
                      <span style={{ whiteSpace: 'pre-wrap' }}>{t.body}</span>
                    )}
                  </>
                }
                targeted={t.isTargeted}
                ctaText={t.ctaText ?? '去看看'}
                onCta={() => handleOpenTip(t)}
                onClose={() => handleDismissTip(t.id)}
                onDismissForever={() => handleDismissForever(t.id)}
                variant="card"
              />
            );
          })()}
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
