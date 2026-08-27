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
let inflight: Promise<Record<string, string>> | null = null;

async function load(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const base = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
      const res = await fetch(`${base}/api/v1/landing/preview-assets`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return {};
      const body = (await res.json()) as { success?: boolean; data?: Record<string, string> | null };
      return body?.success && body.data ? body.data : {};
    } catch {
      // 取不到配图不该影响首页任何其它内容，静默退化成「没有配图」→ 各幕回落到手绘底图
      return {};
    } finally {
      inflight = null;
    }
  })();
  cache = await inflight;
  return cache;
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
