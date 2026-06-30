import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getUserPreferences, updateHomeLauncherPreferences } from '@/services';
import { registerLogoutReset } from '@/stores/authStore';
import type { HomeLauncherPreferences } from '@/services/contracts/userPreferences';
import { HOMEPAGE_CARD_SLOTS, type HomepageCardSlot } from '@/lib/homepageAssetSlots';

export type HomeSecondaryQuickLink = 'library' | 'voc';
export type HomeQuickLinkId = HomepageCardSlot['id'];

export const DEFAULT_HOME_QUICK_LINK_IDS: HomeQuickLinkId[] = ['marketplace', 'library', 'showcase', 'updates'];
export const MAX_HOME_QUICK_LINKS = 6;

const ALLOWED_QUICK_LINK_IDS = new Set<HomeQuickLinkId>(HOMEPAGE_CARD_SLOTS.map((slot) => slot.id));

type HomeLauncherPreferencesState = {
  secondaryQuickLink: HomeSecondaryQuickLink;
  quickLinkIds: HomeQuickLinkId[];
  loaded: boolean;
  saving: boolean;
  loadFromServer: () => Promise<void>;
  setSecondaryQuickLink: (value: HomeSecondaryQuickLink) => void;
  setQuickLinkIds: (ids: HomeQuickLinkId[]) => void;
  reset: () => void;
};

const STORAGE_KEY = 'prd-admin-home-launcher-preferences';
const DEFAULT_SECONDARY: HomeSecondaryQuickLink = 'library';
const ALLOWED_SECONDARY = new Set<HomeSecondaryQuickLink>(['library', 'voc']);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeSecondary(value: unknown): HomeSecondaryQuickLink {
  return ALLOWED_SECONDARY.has(value as HomeSecondaryQuickLink)
    ? (value as HomeSecondaryQuickLink)
    : DEFAULT_SECONDARY;
}

export function normalizeHomeQuickLinkIds(
  ids: unknown,
  fallbackSecondary?: unknown
): HomeQuickLinkId[] {
  const result: HomeQuickLinkId[] = [];
  if (Array.isArray(ids)) {
    for (const raw of ids) {
      const id = raw as HomeQuickLinkId;
      if (!ALLOWED_QUICK_LINK_IDS.has(id) || result.includes(id)) continue;
      result.push(id);
      if (result.length >= MAX_HOME_QUICK_LINKS) break;
    }
  }
  if (result.length > 0) return result;

  const secondary = normalizeSecondary(fallbackSecondary);
  if (secondary === 'voc') {
    return DEFAULT_HOME_QUICK_LINK_IDS.map((id) => (id === 'library' ? 'voc' : id));
  }
  return [...DEFAULT_HOME_QUICK_LINK_IDS];
}

function normalizePreferences(prefs: HomeLauncherPreferences | null | undefined): {
  secondaryQuickLink: HomeSecondaryQuickLink;
  quickLinkIds: HomeQuickLinkId[];
} {
  const secondaryQuickLink = normalizeSecondary(prefs?.secondaryQuickLink);
  return {
    secondaryQuickLink,
    quickLinkIds: normalizeHomeQuickLinkIds(prefs?.quickLinkIds, secondaryQuickLink),
  };
}

function scheduleSave(get: () => HomeLauncherPreferencesState, set: (partial: Partial<HomeLauncherPreferencesState>) => void) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const state = get();
    if (state.saving) return;
    set({ saving: true });
    try {
      await updateHomeLauncherPreferences({
        secondaryQuickLink: state.secondaryQuickLink,
        quickLinkIds: state.quickLinkIds,
      });
    } catch (err) {
      console.error('[homeLauncherPreferencesStore] 保存首页快捷入口偏好失败:', err);
    } finally {
      set({ saving: false });
    }
  }, 400);
}

export const useHomeLauncherPreferencesStore = create<HomeLauncherPreferencesState>()(
  persist(
    (set, get) => ({
      secondaryQuickLink: DEFAULT_SECONDARY,
      quickLinkIds: [...DEFAULT_HOME_QUICK_LINK_IDS],
      loaded: false,
      saving: false,

      loadFromServer: async () => {
        if (get().loaded) return;
        try {
          const res = await getUserPreferences();
          if (res.success) {
            const prefs = normalizePreferences(res.data.homeLauncherPreferences);
            set({
              secondaryQuickLink: prefs.secondaryQuickLink,
              quickLinkIds: prefs.quickLinkIds,
              loaded: true,
            });
            return;
          }
          set({ loaded: true });
        } catch (err) {
          console.error('[homeLauncherPreferencesStore] 加载首页快捷入口偏好失败:', err);
          set({ loaded: true });
        }
      },

      setSecondaryQuickLink: (value) => {
        const next = normalizeSecondary(value);
        if (get().secondaryQuickLink === next) return;
        const quickLinkIds = normalizeHomeQuickLinkIds(null, next);
        set({ secondaryQuickLink: next, quickLinkIds });
        scheduleSave(get, set);
      },

      setQuickLinkIds: (ids) => {
        const next = normalizeHomeQuickLinkIds(ids, get().secondaryQuickLink);
        if (JSON.stringify(get().quickLinkIds) === JSON.stringify(next)) return;
        set({
          quickLinkIds: next,
          secondaryQuickLink: next.includes('voc') && !next.includes('library') ? 'voc' : 'library',
        });
        scheduleSave(get, set);
      },

      reset: () => {
        if (saveTimer) clearTimeout(saveTimer);
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore sessionStorage failures
        }
        set({
          secondaryQuickLink: DEFAULT_SECONDARY,
          quickLinkIds: [...DEFAULT_HOME_QUICK_LINK_IDS],
          loaded: false,
          saving: false,
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ secondaryQuickLink: s.secondaryQuickLink, quickLinkIds: s.quickLinkIds }),
    }
  )
);

registerLogoutReset(() => {
  useHomeLauncherPreferencesStore.getState().reset();
});
