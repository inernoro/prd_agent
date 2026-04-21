import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, ChevronRight, Bell } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { SPOTLIGHT_TARGET_KEY } from './TipsRotator';
import { trackTip } from '@/services/real/dailyTips';

/**
 * 右上角「引导抽屉」。
 * - 聚合所有 card / spotlight 类 tip,以紧凑列表呈现
 * - 定向 tip(isTargeted=true)加「为你」徽章并置顶
 * - 每条 tip 可独立关闭(仅本 session 不再出现)
 * - 抽屉关闭后保留触发按钮,用户可随时点开再看
 */
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

  const [open, setOpen] = useState(() => {
    // 有定向 tip 时自动打开一次,避免用户错过
    try {
      const autoOpenedKey = 'tipsDrawerAutoOpened';
      if (sessionStorage.getItem(autoOpenedKey)) return false;
      return false; // 先不自动开,等 tips 加载后再判断
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!loaded) return;
    const hasTargeted = tips.some((t) => t.isTargeted);
    if (!hasTargeted) return;
    try {
      if (sessionStorage.getItem('tipsDrawerAutoOpened')) return;
      sessionStorage.setItem('tipsDrawerAutoOpened', '1');
    } catch {
      /* noop */
    }
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tips.length]);

  const badgeCount = tips.filter((t) => t.isTargeted).length || tips.length;

  // 记录 seen:抽屉打开且 tip 真正被渲染到画面时,每条只上报一次(本 session 内)
  const seenReportedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    for (const t of tips) {
      if (seenReportedRef.current.has(t.id)) continue;
      seenReportedRef.current.add(t.id);
      void trackTip(t.id, 'seen');
    }
  }, [open, tips]);

  const handleOpenTip = (tip: (typeof tips)[number]) => {
    void trackTip(tip.id, 'clicked');
    if (tip.targetSelector) {
      try {
        sessionStorage.setItem(SPOTLIGHT_TARGET_KEY, tip.targetSelector);
      } catch {
        /* noop */
      }
    }
    setOpen(false);
    navigate(tip.actionUrl || '/');
  };

  const handleDismissTip = (tipId: string) => {
    void trackTip(tipId, 'dismissed');
    dismiss(tipId);
  };

  if (tips.length === 0) return null;

  const triggerBtn = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      title="小贴士"
      style={{
        position: 'fixed',
        top: 72,
        right: 20,
        width: 40,
        height: 40,
        borderRadius: 999,
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.14)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 50,
        color: 'var(--text-primary, #fff)',
        boxShadow: '0 4px 18px -6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
      }}
    >
      <Bell size={15} />
      {badgeCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            minWidth: 14,
            height: 14,
            padding: '0 3px',
            borderRadius: 999,
            background: 'linear-gradient(135deg, #f43f5e, #a855f7)',
            color: '#fff',
            fontSize: 9,
            fontWeight: 600,
            lineHeight: '14px',
            textAlign: 'center',
            boxShadow: '0 0 8px rgba(244,63,94,0.5)',
          }}
        >
          {badgeCount}
        </span>
      )}
    </button>
  );

  const drawer = open ? (
    <div
      style={{
        position: 'fixed',
        top: 70,
        right: 20,
        width: 340,
        maxHeight: 'calc(100vh - 120px)',
        borderRadius: 16,
        background: 'linear-gradient(180deg, rgba(22,22,28,0.96), rgba(15,16,20,0.96))',
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
        zIndex: 51,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 30px 80px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03)',
        animation: 'tipsDrawerSlide 240ms cubic-bezier(.2,.8,.2,1)',
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
          小贴士
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'rgba(255,255,255,0.45)',
            cursor: 'pointer',
            padding: 4,
            display: 'inline-flex',
          }}
          title="关闭"
        >
          <X size={14} />
        </button>
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
        {tips.map((t) => (
          <div
            key={t.id}
            style={{
              borderRadius: 12,
              border: t.isTargeted
                ? '1px solid rgba(244,63,94,0.5)'
                : '1px solid rgba(255,255,255,0.08)',
              background: t.isTargeted
                ? 'linear-gradient(135deg, rgba(244,63,94,0.12), rgba(168,85,247,0.08))'
                : 'rgba(255,255,255,0.03)',
              padding: 12,
              position: 'relative',
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
        ))}
      </div>
      <style>{`
        @keyframes tipsDrawerSlide {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  ) : null;

  return createPortal(
    <>
      {triggerBtn}
      {drawer}
    </>,
    document.body,
  );
}
