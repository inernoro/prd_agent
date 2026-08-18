import { useEffect, useState } from 'react';
import { getSiteContent } from '@/services/real/webPages';
import { canUseSrcDocPreview, hasFetchableHtml, withPreviewBase } from './previewHtml';

/**
 * 取回托管站点入口 HTML，备好可以直接塞进 iframe `srcDoc` 的字符串。
 *
 * 为什么非要绕这一圈：直链 iframe 指向托管域名，Chrome 在这条路径上存在「只绘制空白」的
 * 已知形态（同一份 HTML 下载下来打开却完全正常），而托管域名不返回 ACAO 头、浏览器侧
 * fetch 一律被 CORS 拦掉，所以只能走服务端同源代理 `GET /api/web-pages/{id}/content`。
 * 分享页（PR #1356）已经这么修过一次，这里把同一条路接给缩略图与站内大预览。
 *
 * 拿不到就**如实退回直链**（返回 srcDoc=null），不把「取不回正文」升级成「站点坏了」：
 * 直链在多数站点上仍然显示得好好的。
 */

/** 已经备好的 srcDoc；`null` 表示确认过、这个站点走不了 srcDoc（包装站 / 模块脚本 / 取不回） */
type CacheEntry = { srcDoc: string | null; error: string | null };

/**
 * 进程内缓存。键带上 siteUrl —— 它自带 `?v={Ticks}` 缓存击穿参数，站点一重传就换新键，
 * 不会拿旧正文糊弄用户；列表反复滚动、卡片重挂则命中缓存，不重复打接口。
 */
const cache = new Map<string, CacheEntry>();
/** 同一个键的并发请求合并成一条，避免同屏多张卡片同时打同一个接口 */
const inflight = new Map<string, Promise<CacheEntry>>();

export interface SitePreviewHtmlSite {
  id: string;
  siteUrl: string;
  entryFile?: string;
  wrappedAssetType?: string | null;
  pdfAssetUrl?: string;
}

function cacheKey(site: SitePreviewHtmlSite) {
  return `${site.id}::${site.siteUrl}`;
}

async function loadSrcDoc(site: SitePreviewHtmlSite): Promise<CacheEntry> {
  const key = cacheKey(site);
  const cached = cache.get(key);
  if (cached) return cached;

  const running = inflight.get(key);
  if (running) return running;

  const task = (async (): Promise<CacheEntry> => {
    try {
      const res = await getSiteContent(site.id);
      if (res.success && res.data?.html) {
        const html = res.data.html;
        // 打包型 SPA（入口是外链 module 脚本）必须留在直链：srcDoc 的不透明源会让模块脚本
        // 因缺 CORS 被拦，整页白屏。判据见 canUseSrcDocPreview。
        if (!canUseSrcDocPreview(html)) return { srcDoc: null, error: null };
        return { srcDoc: withPreviewBase(html, site.siteUrl), error: null };
      }
      return { srcDoc: null, error: res.error?.message || '未能取回网页原文' };
    } catch {
      return { srcDoc: null, error: '未能取回网页原文' };
    }
  })();

  inflight.set(key, task);
  try {
    const result = await task;
    cache.set(key, result);
    return result;
  } finally {
    inflight.delete(key);
  }
}

/**
 * @param site   站点；传 null 表示还没有可用站点信息
 * @param enabled 只有真的要显示这一屏时才取（缩略图靠它做「进视口才拉」）
 */
export function useSitePreviewHtml(site: SitePreviewHtmlSite | null, enabled: boolean) {
  const [entry, setEntry] = useState<CacheEntry>({ srcDoc: null, error: null });
  const [loading, setLoading] = useState(false);

  const key = site ? cacheKey(site) : '';
  const fetchable = !!site && hasFetchableHtml(site);

  useEffect(() => {
    if (!site || !enabled || !fetchable) {
      setEntry({ srcDoc: null, error: null });
      setLoading(false);
      return;
    }
    // 命中缓存就同步给出，不闪一下 loading（卡片滚出再滚回时尤其明显）
    const cached = cache.get(key);
    if (cached) {
      setEntry(cached);
      setLoading(false);
      return;
    }

    let alive = true;
    setLoading(true);
    loadSrcDoc(site)
      .then((res) => { if (alive) setEntry(res); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // site 是每次渲染新建的对象字面量，依赖它会无限重取；key 已经涵盖 id + siteUrl 的变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, fetchable]);

  return { srcDoc: entry.srcDoc, error: entry.error, loading };
}

/** 仅供测试：清掉进程内缓存 */
export function __resetSitePreviewHtmlCache() {
  cache.clear();
  inflight.clear();
}
