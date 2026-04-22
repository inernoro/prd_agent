import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, ChevronRight, BookOpen, Pin, PinOff } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { writeSpotlightPayload } from './TipsRotator';
import { trackTip } from '@/services/real/dailyTips';

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
const AUTO_OPENED_KEY = 'tipsDrawerAutoOpened';
const AUTO_COLLAPSE_MS = 5000;
const EDGE_PEEK_ZONE = 140; // 右下角触发区域大小(px)

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
      if (hiddenByUser) sessionStorage.setItem(HIDDEN_KEY, '1');
      else sessionStorage.removeItem(HIDDEN_KEY);
    } catch {
      /* noop */
    }
  }, [hiddenByUser]);

  // ── expanded / edge-peek 临时状态 ────────────────────────
  const [expanded, setExpanded] = useState<boolean>(false);
  const [edgeHover, setEdgeHover] = useState<boolean>(false);

  // ── 当前最终模式 ─────────────────────────────────────
  const mode: Mode = (() => {
    if (expanded) return 'expanded';
    if (pinned) return 'collapsed'; // pinned 时永远显示书
    if (hiddenByUser) return edgeHover ? 'edge-peek' : 'hidden';
    return 'collapsed';
  })();

  // ── 推送自动展开:首次出现定向 tip 时弹一次 ─────────────────
  useEffect(() => {
    if (!loaded) return;
    const hasTargeted = tips.some((t) => t.isTargeted);
    if (!hasTargeted) return;
    try {
      if (sessionStorage.getItem(AUTO_OPENED_KEY)) return;
      sessionStorage.setItem(AUTO_OPENED_KEY, '1');
    } catch {
      /* noop */
    }
    // hidden 状态时不要强弹,只把书显出来
    if (hiddenByUser) {
      setHiddenByUser(false);
    }
    setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tips.length]);

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
  useEffect(() => {
    if (!hiddenByUser) {
      setEdgeHover(false);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const inZone =
        window.innerWidth - e.clientX < EDGE_PEEK_ZONE &&
        window.innerHeight - e.clientY < EDGE_PEEK_ZONE;
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
      setExpanded(false);
      navigate(tip.actionUrl || '/');
    },
    [navigate],
  );

  const handleDismissTip = (tipId: string) => {
    void trackTip(tipId, 'dismissed');
    dismiss(tipId);
  };

  // 没有任何 tip 且未锁定 → 完全不渲染(避免占据右下角)
  if (tips.length === 0 && !pinned) return null;

  // ── 视觉:书图标本体 ──────────────────────────────────
  // hidden 模式时挪到右边缘只露 18px 书脊;edge-peek 时滑回正常位置
  const bookRight =
    mode === 'hidden' ? -32 : mode === 'edge-peek' ? 12 : 20;
  const bookOpacity = mode === 'hidden' ? 0.55 : 1;

  const bookBtn = (
    <button
      type="button"
      onClick={() => {
        if (hiddenByUser) {
          // 从 hidden 点击 → 取消 hidden(用户主动召回)
          setHiddenByUser(false);
          setExpanded(true);
          return;
        }
        setExpanded((v) => !v);
      }}
      title={tips.length === 0 ? '教程' : `教程 (${badgeCount})`}
      style={{
        position: 'fixed',
        bottom: 20,
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
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow =
          '0 14px 36px -8px rgba(139,92,246,0.65), 0 0 0 1px rgba(255,255,255,0.08) inset';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow =
          '0 10px 30px -8px rgba(139,92,246,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset, 0 1px 0 rgba(255,255,255,0.14) inset';
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
          bottom: 80,
          right: 20,
          width: 360,
          maxHeight: 'calc(100vh - 120px)',
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
              <div
                key={t.id}
                style={{
                  borderRadius: 14,
                  border: t.isTargeted
                    ? '1px solid rgba(244,63,94,0.45)'
                    : '1px solid rgba(255,255,255,0.06)',
                  background: t.isTargeted
                    ? 'linear-gradient(135deg, rgba(244,63,94,0.14), rgba(168,85,247,0.10))'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015))',
                  padding: '13px 14px',
                  position: 'relative',
                  boxShadow: t.isTargeted
                    ? '0 6px 20px -10px rgba(244,63,94,0.35)'
                    : '0 2px 8px -4px rgba(0,0,0,0.3)',
                }}
              >
                <button
                  type="button"
                  onClick={() => handleDismissTip(t.id)}
                  title="本次会话不再显示"
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    border: 'none',
                    background: 'transparent',
                    color: 'rgba(255,255,255,0.35)',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'inline-flex',
                  }}
                >
                  <X size={12} />
                </button>
                {t.isTargeted && (
                  <div
                    style={{
                      display: 'inline-block',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#fff',
                      background: 'linear-gradient(135deg, #f43f5e, #a855f7)',
                      borderRadius: 999,
                      padding: '1px 7px',
                      marginBottom: 6,
                      letterSpacing: '0.04em',
                    }}
                  >
                    为你
                  </div>
                )}
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text-primary, #fff)',
                    marginBottom: t.body ? 4 : 8,
                    paddingRight: 18,
                    lineHeight: 1.35,
                  }}
                >
                  {t.title}
                </div>
                {t.body && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.62)',
                      lineHeight: 1.55,
                      marginBottom: 8,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {t.body}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handleOpenTip(t)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 12,
                    fontWeight: 600,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--accent-primary, #818CF8)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {t.ctaText || '去看看'}
                  <ChevronRight size={12} />
                </button>
              </div>
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

  return createPortal(
    <>
      {bookBtn}
      {drawer}
    </>,
    document.body,
  );
}
