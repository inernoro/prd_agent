import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type UiPrefsState = {
  /** AI（Assistant）回复正文缩放倍数：1.0 = 默认 */
  assistantFontScale: number;
  increaseAssistantFont: () => void;
  decreaseAssistantFont: () => void;
  resetAssistantFont: () => void;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// 经验值：默认偏大时，允许下探到 0.75；上探到 1.25（避免把布局撑爆）
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.25;
const STEP = 0.05;
const DEFAULT_SCALE = 1.0;

export const useUiPrefsStore = create<UiPrefsState>()(
  persist(
    (set) => ({
      assistantFontScale: DEFAULT_SCALE,
      increaseAssistantFont: () => set((s) => ({
        assistantFontScale: clamp(Number((s.assistantFontScale ?? DEFAULT_SCALE)) + STEP, MIN_SCALE, MAX_SCALE),
      })),
      decreaseAssistantFont: () => set((s) => ({
        assistantFontScale: clamp(Number((s.assistantFontScale ?? DEFAULT_SCALE)) - STEP, MIN_SCALE, MAX_SCALE),
      })),
      resetAssistantFont: () => set(() => ({ assistantFontScale: DEFAULT_SCALE })),
    }),
    {
      name: 'ui-prefs-storage',
      version: 1,
      partialize: (s) => ({
        assistantFontScale: s.assistantFontScale,
      }),
      merge: (persisted: any, current) => {
        const p = (persisted as any) || {};
        const raw = Number(p?.assistantFontScale ?? (current as any)?.assistantFontScale ?? DEFAULT_SCALE);
        const safe = Number.isFinite(raw) ? clamp(raw, MIN_SCALE, MAX_SCALE) : DEFAULT_SCALE;
        return { ...current, assistantFontScale: safe } as UiPrefsState;
      },
    }
  )
);

export const assistantFontScaleBounds = { min: MIN_SCALE, max: MAX_SCALE, step: STEP, def: DEFAULT_SCALE };


