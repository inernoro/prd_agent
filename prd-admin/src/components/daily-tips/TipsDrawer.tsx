import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, BookOpen, Pin, PinOff, MapPin, EyeOff } from 'lucide-react';
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
/** 首次访问自动弹过一次的标志(全域 session 级,只兜底提示新用户) */
const FIRST_VISIT_SHOWN_KEY = 'tipsBookFirstVisitShown';
/** 悬浮组整体折叠(书 + AppShell toast 铃铛联动):由 TipsDrawer 写,AppShell 读 */
export const FLOATING_DOCK_COLLAPSED_KEY = 'floatingDockCollapsed';
const AUTO_COLLAPSE_MS = 5000;
const EDGE_PEEK_ZONE = 140; // 右下角触发区域大小(px)

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

type Mode = 'collapsed' | 'expanded' | 'hidden' | 'edge-peek';

export function TipsDrawer() {
  const navigate = useNavigate();
  const loaded = useDailyTipsStore((s) => s.loaded);
  const load = useDailyTipsStore((s) => s.load);
  const cardTips = useDailyTipsStore((s) => s.cardTips);
  const dismiss = useDailyTipsStore((s) => s.dismiss);
  const items = useDailyTipsStore((s) => s.items);
  const dismissed = useDailyTipsStore((s) => s.dismissed);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  const tips = cardTips();
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
      window.dispatchEvent(new CustomEvent('floating-dock-collapsed-changed', {
        detail: { collapsed: hiddenByUser },
      }));
    } catch {
      /* noop */
    }
  }, [hiddenByUser]);

  // ── expanded / edge-peek / hover 临时状态 ────────────────────────
  const [expanded, setExpanded] = useState<boolean>(false);
  const [edgeHover, setEdgeHover] = useState<boolean>(false);
  const [bookHover, setBookHover] = useState<boolean>(false);

  // ── 悬浮组整体折叠(书 + 铃铛一起贴边) ───────────────────────
  // 这个状态通过 sessionStorage 广播,AppShell 的 toast 按钮订阅同样的 key
  // 实现「两个一起收」的效果。hiddenByUser 是其别名(键名兼容)。
  const setDockCollapsed = useCallback((collapsed: boolean) => {
    try {
      if (collapsed) sessionStorage.setItem(FLOATING_DOCK_COLLAPSED_KEY, '1');
      else sessionStorage.removeItem(FLOATING_DOCK_COLLAPSED_KEY);
      // 用自定义事件通知 AppShell(同 tab 内 storage 事件不会触发)
      window.dispatchEvent(new CustomEvent('floating-dock-collapsed-changed', {
        detail: { collapsed },
      }));
    } catch {
      /* noop */
    }
    setHiddenByUser(collapsed);
  }, []);

  // ── 当前最终模式 ─────────────────────────────────────
  const mode: Mode = (() => {
    if (expanded) return 'expanded';
    if (pinned) return 'collapsed'; // pinned 时永远显示书
    if (hiddenByUser) return edgeHover ? 'edge-peek' : 'hidden';
    return 'collapsed';
  })();

  // ── 推送自动展开:按 tip.id 记忆,每条定向 tip 本 session 只弹一次 ──
  // 轮询时如果管理员新推了一条,tips 里会多出一个 isTargeted 的新 id,它不在
  // 已弹过集合里 → 再自动弹一次。解决「session 第二条推送不弹」的坑。
  useEffect(() => {
    if (!loaded) return;
    const opened = readAutoOpenedIds();
    const newTargeted = tips.find((t) => t.isTargeted && !opened.has(t.id));
    if (!newTargeted) return;

    opened.add(newTargeted.id);
    writeAutoOpenedIds(opened);

    // hidden 状态时先把书拉回来
    if (hiddenByUser) {
      setHiddenByUser(false);
    }
    setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tips]);

  // ── 新用户兜底:本 session 第一次访问、有任意 tip 时自动弹一次 ──
  // 让用户第一次看到书时就知道它是做什么的(管理员没推送也能看到 seed 内容)
  useEffect(() => {
    if (!loaded) return;
    if (tips.length === 0) return;
    try {
      if (sessionStorage.getItem(FIRST_VISIT_SHOWN_KEY)) return;
      sessionStorage.setItem(FIRST_VISIT_SHOWN_KEY, '1');
    } catch {
      return;
    }
    setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tips.length > 0]);

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

  // ── 鼠标贴右下角触发 edge-peek ──────────────────────────
  // 触发区域覆盖书的位置(右下 200px),hidden 时鼠标靠近就把书拉回来
  useEffect(() => {
    if (!hiddenByUser) {
      setEdgeHover(false);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const inZone =
        window.innerWidth - e.clientX < EDGE_PEEK_ZONE &&
        window.innerHeight - e.clientY < EDGE_PEEK_ZONE + 60;
      setEdgeHover(inZone);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [hiddenByUser]);

  // ── 徽章计数 ────────────────────────────────────────
  const badgeCount = tips.filter((t) => t.isTargeted).length || tips.length;

  // ── 上报 seen ────────────────────────────────────────
  const seenReportedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expanded) return;
    for (const t of tips) {
      if (seenReportedRef.current.has(t.id)) continue;
      seenReportedRef.current.add(t.id);
      void trackTip(t.id, 'seen');
    }
  }, [expanded, tips]);

  const handleOpenTip = useCallback(
    (tip: (typeof tips)[number]) => {
      void trackTip(tip.id, 'clicked');
      writeSpotlightPayload(tip);
      // 抽屉故意保留打开,让用户边跟着 Spotlight 引导,边对照教程步骤 /
      // 决定点「不再提示」;不再像以前那样 setExpanded(false) 把引导面板秒关。
      // 跳转后如果 5s 没 hover 抽屉,自动 collapse 的定时器会把它收起。
      navigate(tip.actionUrl || '/');
    },
    [navigate],
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

  // 小书「永远存在」:即使 tips 为空、也没 pinned,依然在右下角悬浮,
  // 保证用户随时能点进来看有什么教程。没有 tip 时点开会显示空状态。

  // ── 视觉:书图标本体 ──────────────────────────────────
  // AppShell 的通知铃铛在 bottom:20 right:20(48x48),所以书放在它正上方,
  // 间距 12px,bottom = 20 + 48 + 12 = 80。hidden 时挪到右边缘只露书脊。
  const BOOK_BOTTOM = 80;
  const bookRight = mode === 'hidden' ? -20 : mode === 'edge-peek' ? 12 : 20;
  const bookOpacity = mode === 'hidden' ? 0.6 : 1;

  const bookBtn = (
    <button
      type="button"
      onClick={() => {
        // 任何打开动作都强制刷新一次,避免管理员刚推送但用户还在等 60s 轮询
        void load({ force: true });
        if (hiddenByUser) {
          // 从 hidden 点击 → 取消 hidden(用户主动召回)
          setDockCollapsed(false);
          setExpanded(true);
          return;
        }
        setExpanded((v) => !v);
      }}
      onMouseEnter={(e) => {
        setBookHover(true);
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow =
          '0 14px 36px -8px rgba(139,92,246,0.65), 0 0 0 1px rgba(255,255,255,0.08) inset';
      }}
      onMouseLeave={(e) => {
        setBookHover(false);
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow =
          '0 10px 30px -8px rgba(139,92,246,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset, 0 1px 0 rgba(255,255,255,0.14) inset';
      }}
      title={tips.length === 0 ? '教程(暂无)' : `教程 (${badgeCount})`}
      style={{
        position: 'fixed',
        bottom: BOOK_BOTTOM,
        right: bookRight,
        width: 48,
        height: 48,
        borderRadius: 999,
        background:
          'linear-gradient(135deg, rgba(168,85,247,0.30), rgba(99,102,241,0.22))',
        border: '1px solid rgba(196,181,253,0.40)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 50,
        color: '#f3e8ff',
        opacity: bookOpacity,
        boxShadow:
          '0 10px 30px -8px rgba(139,92,246,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset, 0 1px 0 rgba(255,255,255,0.14) inset',
        transition:
          'right 240ms cubic-bezier(.2,.8,.2,1), opacity 240ms ease-out, transform 180ms ease-out, box-shadow 180ms ease-out',
      }}
    >
      <BookOpen
        size={20}
        strokeWidth={2.1}
        style={{ filter: 'drop-shadow(0 0 6px rgba(196,181,253,0.6))' }}
      />
      {badgeCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 999,
            background: 'linear-gradient(135deg, #f43f5e, #a855f7)',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '18px',
            textAlign: 'center',
            boxShadow:
              '0 0 10px rgba(244,63,94,0.6), 0 0 0 2px rgba(15,16,20,0.95)',
          }}
        >
          {badgeCount}
        </span>
      )}
    </button>
  );

  // ── 抽屉本体 ────────────────────────────────────────
  const drawer =
    mode === 'expanded' ? (
      <div
        onMouseEnter={() => {
          drawerHoveredRef.current = true;
        }}
        onMouseLeave={() => {
          drawerHoveredRef.current = false;
        }}
        style={{
          position: 'fixed',
          bottom: BOOK_BOTTOM + 56, // 小书上方 (80 + 48 + 8)
          right: 20,
          width: 360,
          maxHeight: 'calc(100vh - 180px)',
          borderRadius: 18,
          background:
            'linear-gradient(180deg, rgba(24,22,34,0.96), rgba(16,16,22,0.97))',
          border: '1px solid rgba(196,181,253,0.20)',
          backdropFilter: 'blur(22px) saturate(140%)',
          WebkitBackdropFilter: 'blur(22px) saturate(140%)',
          zIndex: 51,
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
          ) : (
            tips.map((t) => (
              <TipCard
                key={t.id}
                icon={<MapPin size={14} />}
                accent={
                  t.isTargeted
                    ? 'rgba(244,63,94,0.95)'
                    : 'rgba(52,211,153,0.95)'
                }
                title={t.title}
                body={t.body ?? undefined}
                targeted={t.isTargeted}
                ctaText={t.ctaText ?? '去看看'}
                onCta={() => handleOpenTip(t)}
                onClose={() => handleDismissTip(t.id)}
                onDismissForever={() => handleDismissForever(t.id)}
                variant="card"
              />
            ))
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

  // ── 悬浮组整体折叠把手 ──
  // 书 hover 时左侧露出一个小按钮,点一下把整组(书 + 铃铛)收到边缘
  const collapseHandle =
    bookHover && !hiddenByUser && !pinned ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(false);
          setDockCollapsed(true);
        }}
        title="收起悬浮组(书 + 通知一起贴边)"
        onMouseEnter={() => setBookHover(true)}
        style={{
          position: 'fixed',
          bottom: BOOK_BOTTOM + 14,
          right: 74,
          width: 22,
          height: 22,
          borderRadius: 999,
          background: 'rgba(15,16,20,0.92)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: 'rgba(255,255,255,0.7)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 52,
          boxShadow: '0 4px 14px -4px rgba(0,0,0,0.5)',
          animation: 'tipsHandleFade 160ms ease-out',
        }}
      >
        <EyeOff size={11} />
        <style>{`
          @keyframes tipsHandleFade {
            from { opacity: 0; transform: translateX(4px); }
            to { opacity: 1; transform: translateX(0); }
          }
        `}</style>
      </button>
    ) : null;

  return createPortal(
    <>
      {bookBtn}
      {collapseHandle}
      {drawer}
    </>,
    document.body,
  );
}
