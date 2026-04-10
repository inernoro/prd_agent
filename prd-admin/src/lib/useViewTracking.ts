import { useEffect, useRef } from 'react';
import { logEntryView, leaveEntryView } from '@/services';

/**
 * 知识库文档浏览埋点 hook。
 *
 * 行为：
 *   - entryId 变化时：若之前有正在计时的 viewEvent，先补写时长；再对新 entry 发起 logEntryView
 *   - 组件卸载或页面关闭（beforeunload / visibilitychange hidden）时：补写时长
 *   - 页面从 hidden 恢复到 visible 时：重置计时起点，不新建事件（避免短暂切 tab 被多算一次访问）
 *
 * 匿名访客用 sessionStorage 里的 anonToken 作为区分，避免同一人同一 tab 被多次计算为独立访客。
 */
export function useViewTracking(entryId: string | undefined | null) {
  // 用 ref 同步存储当前事件的状态，让 cleanup / 事件 handler 能拿到最新值
  const stateRef = useRef<{ viewEventId: string | null; enteredAt: number }>({
    viewEventId: null,
    enteredAt: 0,
  });

  useEffect(() => {
    if (!entryId) {
      flushIfAny(stateRef);
      return;
    }

    // 切换到新 entry 前，把上一个 entry 的时长补完
    flushIfAny(stateRef);

    stateRef.current = { viewEventId: null, enteredAt: Date.now() };
    let cancelled = false;
    const localEntryId = entryId;

    (async () => {
      const anonToken = ensureAnonToken();
      const res = await logEntryView(localEntryId, anonToken);
      // 避免竞态：如果期间 entryId 又变了，就丢弃本次返回的 id
      if (cancelled) return;
      if (res.success) {
        stateRef.current.viewEventId = res.data.viewEventId;
      }
    })();

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushIfAny(stateRef);
      } else if (document.visibilityState === 'visible' && stateRef.current.viewEventId == null) {
        // 可见 + 当前已 flushed → 重新起一次记录（视为同 tab 的新访问）
        stateRef.current.enteredAt = Date.now();
        (async () => {
          const res = await logEntryView(localEntryId, ensureAnonToken());
          if (!cancelled && res.success) {
            stateRef.current.viewEventId = res.data.viewEventId;
          }
        })();
      }
    };
    const handleBeforeUnload = () => flushIfAny(stateRef, true);

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      flushIfAny(stateRef);
    };
  }, [entryId]);
}

type StateRef = React.MutableRefObject<{ viewEventId: string | null; enteredAt: number }>;

function flushIfAny(stateRef: StateRef, preferBeacon = false) {
  const { viewEventId, enteredAt } = stateRef.current;
  if (!viewEventId || !enteredAt) return;
  const durationMs = Math.max(0, Date.now() - enteredAt);
  stateRef.current = { viewEventId: null, enteredAt: 0 };

  const url = `/api/document-store/view-events/${viewEventId}/leave`;
  const payload = JSON.stringify({ durationMs });
  if (preferBeacon && 'sendBeacon' in navigator) {
    try {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      return;
    } catch {
      /* fallthrough */
    }
  }
  try {
    void leaveEntryView(viewEventId, durationMs);
  } catch {
    /* ignore */
  }
}

function ensureAnonToken(): string | undefined {
  try {
    let token = sessionStorage.getItem('docStore.anonViewToken');
    if (!token) {
      token = `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('docStore.anonViewToken', token);
    }
    return token;
  } catch {
    return undefined;
  }
}
