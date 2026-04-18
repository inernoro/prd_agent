import { create } from 'zustand';
import { getHomepageAssetsPublic } from '@/services';
import type { HomepageAssetDto, HomepageAssetsMap } from '@/services/contracts/homepageAssets';
import { agentImageSlot, agentVideoSlot, cardSlot, type HomepageCardSlot } from '@/lib/homepageAssetSlots';

interface HomepageAssetsState {
  loaded: boolean;
  loading: boolean;
  assets: HomepageAssetsMap;
  error: string | null;
  /** 拉取资源；默认跳过已 loaded；上传/删除后调用 `refresh()` 强制重拉 */
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** 强制重新拉取，等价 load({force:true}) */
  refresh: () => Promise<void>;
  /** 原始记录访问 */
  get: (slot: string) => HomepageAssetDto | undefined;
}

/**
 * 用 updatedAt 做缓存爆破：上传新图后同一 URL 会附带新的 `?v=...`，
 * 浏览器与 CDN 都会重新获取。
 */
function appendCacheBust(url: string, updatedAt?: string | null): string {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!updatedAt) return u;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return u;
  const v = Math.floor(t / 1000);
  return u.includes('?') ? `${u}&v=${v}` : `${u}?v=${v}`;
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

  async refresh() {
    return await get().load({ force: true });
  },

  get(slot) {
    return get().assets[slot];
  },
}));

/**
 * 组件里订阅用的 hook —— 代替 `getState()` 快照取值，
 * 保证 store 刷新时消费方自动重渲染，且返回的 URL 已附缓存爆破。
 */
export function useCardBgUrl(id: HomepageCardSlot['id']): string | null {
  const asset = useHomepageAssetsStore((s) => s.assets[cardSlot(id)]);
  return asset ? appendCacheBust(asset.url, asset.updatedAt) : null;
}

export function useAgentImageUrl(agentKey: string | undefined): string | null {
  const slot = agentKey ? agentImageSlot(agentKey) : '';
  const asset = useHomepageAssetsStore((s) => (slot ? s.assets[slot] : undefined));
  return asset ? appendCacheBust(asset.url, asset.updatedAt) : null;
}

export function useAgentVideoUrl(agentKey: string | undefined): string | null {
  const slot = agentKey ? agentVideoSlot(agentKey) : '';
  const asset = useHomepageAssetsStore((s) => (slot ? s.assets[slot] : undefined));
  return asset ? appendCacheBust(asset.url, asset.updatedAt) : null;
}
