import { create } from 'zustand';
import type { DailyTip } from '@/services/real/dailyTips';
import { listVisibleTips } from '@/services/real/dailyTips';

const DISMISSED_KEY = 'dailyTipDismissedIds';

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function writeDismissed(ids: Set<string>) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* sessionStorage may be unavailable (privacy mode) */
  }
}

interface DailyTipsState {
  items: DailyTip[];
  loaded: boolean;
  loading: boolean;
  dismissed: Set<string>;
  load: () => Promise<void>;
  dismiss: (id: string) => void;
  /** 「text」类 tip(副标题轮播使用) */
  textTips: () => DailyTip[];
  /** 「card」/「spotlight」类 tip(右上角抽屉使用),已自动过滤 session 关闭项 */
  cardTips: () => DailyTip[];
}

export const useDailyTipsStore = create<DailyTipsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  dismissed: readDismissed(),

  async load() {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await listVisibleTips();
      if (res.success && res.data) {
        set({ items: res.data.items ?? [], loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  dismiss(id: string) {
    const next = new Set(get().dismissed);
    next.add(id);
    writeDismissed(next);
    set({ dismissed: next });
  },

  textTips() {
    return get().items.filter((t) => t.kind === 'text');
  },

  cardTips() {
    const { dismissed } = get();
    return get()
      .items.filter((t) => t.kind === 'card' || t.kind === 'spotlight')
      .filter((t) => !dismissed.has(t.id));
  },
}));
