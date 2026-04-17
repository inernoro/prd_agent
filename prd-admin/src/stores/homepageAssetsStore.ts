import { create } from 'zustand';
import { getHomepageAssetsPublic } from '@/services';
import type { HomepageAssetDto, HomepageAssetsMap } from '@/services/contracts/homepageAssets';
import { agentImageSlot, agentVideoSlot, cardSlot, type HomepageCardSlot } from '@/lib/homepageAssetSlots';

interface HomepageAssetsState {
  loaded: boolean;
  loading: boolean;
  assets: HomepageAssetsMap;
  error: string | null;
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** 卡片背景 URL（未上传返回 null） */
  cardBgUrl: (id: HomepageCardSlot['id']) => string | null;
  /** Agent 封面图 URL（未上传返回 null） */
  agentImageUrl: (agentKey: string) => string | null;
  /** Agent 封面视频 URL（未上传返回 null） */
  agentVideoUrl: (agentKey: string) => string | null;
  /** 原始记录访问（用于高级场景） */
  get: (slot: string) => HomepageAssetDto | undefined;
}

export const useHomepageAssetsStore = create<HomepageAssetsState>((set, get) => ({
  loaded: false,
  loading: false,
  assets: {},
  error: null,

  async load(opts) {
    const force = Boolean(opts?.force);
    const state = get();
    if (!force && (state.loaded || state.loading)) return;
    set({ loading: true, error: null });
    try {
      const res = await getHomepageAssetsPublic();
      if (!res.success || !res.data) {
        set({ loading: false, loaded: true, error: res.error?.message || null });
        return;
      }
      set({ assets: res.data, loading: false, loaded: true, error: null });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  cardBgUrl(id) {
    return get().assets[cardSlot(id)]?.url ?? null;
  },
  agentImageUrl(agentKey) {
    return get().assets[agentImageSlot(agentKey)]?.url ?? null;
  },
  agentVideoUrl(agentKey) {
    return get().assets[agentVideoSlot(agentKey)]?.url ?? null;
  },
  get(slot) {
    return get().assets[slot];
  },
}));
