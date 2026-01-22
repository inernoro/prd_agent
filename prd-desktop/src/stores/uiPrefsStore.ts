import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type UiPrefsState = {
  /** AI（Assistant）回复正文缩放倍数：0.8 = 默认 */
  assistantFontScale: number;
  increaseAssistantFont: () => void;
  decreaseAssistantFont: () => void;
  resetAssistantFont: () => void;
  /** AI 回复开关：true = 总是回复，false = 跳过回复 */
  aiAnyway: boolean;
  toggleAiAnyway: () => void;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// 经验值：默认偏大时，允许下探到 0.75；上探到 1.25（避免把布局撑爆）
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.25;
const STEP = 0.05;
const DEFAULT_SCALE = 0.8;

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
      aiAnyway: true,
      toggleAiAnyway: () => set((s) => ({ aiAnyway: !s.aiAnyway })),
    }),
    {
      name: 'ui-prefs-storage',
      version: 2,
      partialize: (s) => ({
        assistantFontScale: s.assistantFontScale,
        aiAnyway: s.aiAnyway,
      }),
      merge: (persisted: any, current) => {
        const p = (persisted as any) || {};
        const raw = Number(p?.assistantFontScale ?? (current as any)?.assistantFontScale ?? DEFAULT_SCALE);
        const safe = Number.isFinite(raw) ? clamp(raw, MIN_SCALE, MAX_SCALE) : DEFAULT_SCALE;
        // 兼容旧版本：skipAiReply 取反 = aiAnyway
        let aiAnyway = true;
        if (typeof p?.aiAnyway === 'boolean') {
          aiAnyway = p.aiAnyway;
        } else if (typeof p?.skipAiReply === 'boolean') {
          aiAnyway = !p.skipAiReply; // 旧数据迁移
        }
        return { ...current, assistantFontScale: safe, aiAnyway } as UiPrefsState;
      },
    }
  )
);

export const assistantFontScaleBounds = { min: MIN_SCALE, max: MAX_SCALE, step: STEP, def: DEFAULT_SCALE };


