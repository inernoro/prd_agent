import { useEffect, useState } from 'react';
import { getHomepageAssetsPublic } from '@/services';
import { imageryEntryBySlot, imageryModuleById } from '@/lib/imagery';
import type { ImageryReach } from '@/lib/imagery';

/**
 * 系统配图的读取端 —— 管理员在「系统设置 → 系统配图」生成，这里只负责取回来。
 *
 * ## 两个通道，按模块的 reach 分
 *
 * - `public`：对外首页不登录就能打开，拿不到 token，只能走匿名端点
 *   `/api/v1/landing/preview-assets`。后端那个端点**只放行 `landing.` 前缀**——
 *   公网无鉴权面吐出整张表等于白送一份资源清单。
 * - `internal`：登录后的页面走 `api/homepage/assets`，前缀不受限。
 *
 * 两条通道各自缓存：一个 SPA 会话里每条最多拉一次，各处共用。
 *
 * ## 取不到必须能照常渲染
 *
 * 所有返回值都可能是 null / 空表——没配图、请求失败、还没登录都会走到这里。
 * 调用方**必须**有自己的兜底（原来的色块、汉字方块、手绘底图），配图是替换不是前提。
 */

type Cache = { map: Record<string, string> | null; inflight: Promise<Record<string, string> | null> | null };

const caches: Record<ImageryReach, Cache> = {
  public: { map: null, inflight: null },
  internal: { map: null, inflight: null },
};

async function fetchPublic(): Promise<Record<string, string> | null> {
  try {
    const base = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
    const res = await fetch(`${base}/api/v1/landing/preview-assets`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: Record<string, string> | null };
    return body?.success ? (body.data ?? {}) : null;
  } catch {
    return null;
  }
}

async function fetchInternal(): Promise<Record<string, string> | null> {
  try {
    const res = await getHomepageAssetsPublic();
    if (!res.success) return null;
    const out: Record<string, string> = {};
    Object.entries(res.data ?? {}).forEach(([slot, asset]) => {
      if (asset?.url) out[slot] = asset.url;
    });
    return out;
  } catch {
    return null;
  }
}

/**
 * 只缓存**成功**的那一次。
 *
 * 失败也写进缓存的话，API 刚起来时的一次 502、或者切页那一下的网络抖动，
 * 会被记成「这个 SPA 会话里永远没有配图」——后端早就好了、图也早就生成了，
 * 用户却要整页刷新才看得到。失败就不写缓存，下一次挂载重新去拉。
 *
 * 反过来「成功但确实一张都没配」是要缓存的：那是真实答案，不是失败。
 */
async function load(reach: ImageryReach): Promise<Record<string, string>> {
  const cache = caches[reach];
  if (cache.map) return cache.map;
  if (!cache.inflight) {
    cache.inflight = reach === 'public' ? fetchPublic() : fetchInternal();
  }
  const pending = cache.inflight;
  const result = await pending;
  // 只有还是自己这一轮时才清 inflight，避免把后来者的在途请求清掉
  if (cache.inflight === pending) cache.inflight = null;
  if (result) cache.map = result;
  return result ?? {};
}

/**
 * 丢掉缓存，下一次挂载重新去拉。
 *
 * 管理端换过图之后必须调一次：这份缓存是模块级的，同一个 SPA 会话里
 * 生成/替换/删除完再回消费页，拿到的还是换之前那一份，非得整页刷新才看得见——
 * 而他刚刚才亲手换过。
 */
export function invalidateImagery(): void {
  caches.public.map = null;
  caches.internal.map = null;
}

/**
 * 取单个图位的图片地址。没有配、或这次没拉到，返回 null。
 *
 * slot 必须是注册表里登记过的——认不出来直接返回 null 而不是去猜通道，
 * 免得一个拼错的 slot 静默走了公网通道。
 */
export function useImageryAsset(slotKey: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const entry = imageryEntryBySlot(slotKey);
    if (!entry) {
      setUrl(null);
      return undefined;
    }
    let alive = true;
    void load(entry.module.reach).then((map) => { if (alive) setUrl(map[slotKey] ?? null); });
    return () => { alive = false; };
  }, [slotKey]);
  return url;
}

/**
 * 取整个模块的图位表（slot 字符串 → url）。
 *
 * 一次拿一组，给「七卷行」这种同屏要用好几张的地方用：逐个调 `useImageryAsset`
 * 会在同一屏里挂七个 effect 去读同一份缓存，白白多七次渲染。
 */
export function useImageryModule(moduleId: string): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const module = imageryModuleById(moduleId);
    if (!module) {
      setMap({});
      return undefined;
    }
    let alive = true;
    void load(module.reach).then((all) => {
      if (!alive) return;
      const own: Record<string, string> = {};
      module.slots.forEach((s) => { if (all[s.slot]) own[s.slot] = all[s.slot]; });
      setMap(own);
    });
    return () => { alive = false; };
  }, [moduleId]);
  return map;
}
