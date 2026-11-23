import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { clearConsciousnessArrival } from '@/components/effects/ConsciousnessScene';
import { finishEntryArrival } from '@/components/effects/entryArrival';

export type EntrySkin = 'standard' | 'companion';
export const ENTRY_SKINS = [
  { value: 'standard', label: '标准工作台', description: '简洁登录，直接进入完整工作台' },
  { value: 'companion', label: '智能伙伴', description: '角色背景轻柔过渡，登录后即可使用工作台' },
] as const;
export const useEntrySkinStore = create<{ skin: EntrySkin; setSkin: (skin: EntrySkin) => void }>()(persist(
  set => ({ skin: 'standard', setSkin: skin => {
    clearConsciousnessArrival(); finishEntryArrival(); set({ skin });
  } }),
  { name: 'map-entry-skin', storage: createJSONStorage(() => localStorage),
    partialize: state => ({ skin: state.skin }),
    merge: (persisted, current) => ({ ...current, skin: (persisted as { skin?: string })?.skin === 'companion' ? 'companion' : 'standard' }),
  },
));
