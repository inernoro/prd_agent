import { useEffect, useState } from 'react';

/**
 * 首页产物图的读取 —— 由管理员在「系统设置 → 首页预览图」生成，这里只负责取回来。
 *
 * 走匿名端点（`/api/v1/landing/preview-assets`）：`/home` 不登录就能打开，
 * 拿不到 token，用不了登录后那套 `api/homepage/assets`。
 *
 * 全页只拉一次，各幕共用：第一个挂载的组件负责发请求，其余等它。
 */

let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string> | null> | null = null;

/**
 * 只缓存**成功**的那一次。
 *
 * 失败也写进缓存的话，API 刚起来时的一次 502、或者切页那一下的网络抖动，
 * 会被记成「这个 SPA 会话里首页永远没有配图」——后端早就好了、图也早就生成了，
 * 用户却要整页刷新才看得到。失败就不写缓存，下一次挂载重新去拉。
 *
 * 反过来「成功但确实一张都没配」是要缓存的：那是真实答案，不是失败。
 */
async function load(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async (): Promise<Record<string, string> | null> => {
      try {
        const base = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
        const res = await fetch(`${base}/api/v1/landing/preview-assets`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const body = (await res.json()) as { success?: boolean; data?: Record<string, string> | null };
        return body?.success ? (body.data ?? {}) : null;
      } catch {
        // 取不到配图不该影响首页任何其它内容，静默退化成「没有配图」→ 各幕回落到手绘底图
        return null;
      }
    })();
  }
  const pending = inflight;
  const result = await pending;
  // 只有还是自己这一轮时才清 inflight，避免把后来者的在途请求清掉
  if (inflight === pending) inflight = null;
  if (result) cache = result;
  return result ?? {};
}

/**
 * 取某个槽位的图片地址。没有配、或这次没拉到，返回 null —— 调用方**必须**能在
 * null 时照常渲染（回落到原来的手绘底图），配图是替换不是前提。
 */
export function useLandingAsset(slot: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void load().then((map) => { if (alive) setUrl(map[slot] ?? null); });
    return () => { alive = false; };
  }, [slot]);
  return url;
}
