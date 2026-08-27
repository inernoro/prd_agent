import { useEffect, useState } from 'react';
import { Reveal } from './Reveal';
import { SCENE, inkTone } from '../scenes/sceneTokens';

/**
 * 每一幕的配图 —— 由管理员在「系统设置 → 首页预览图」生成，这里只负责显示。
 *
 * 两条设计约束：
 *
 * 1. **没配图就什么都不渲染**。十幕本身画的是真实界面的缩微版，配图是锦上添花，
 *    不是这一幕成立的前提。管理员没生成时这一幕必须和以前一模一样 ——
 *    绝不留一个「暂无配图」的空框在对外宣传页上。
 * 2. **图没加载出来也不占位**。`onError` 直接把自己摘掉：公网页面上一个碎图图标
 *    比没有图难看得多。
 *
 * 数据走匿名端点（`/api/v1/landing/preview-assets`）—— `/home` 不登录就能打开，
 * 拿不到 token，不能用登录后那套 `api/homepage/assets`。
 */

/** 全页只拉一次，十幕共用。第一个挂载的组件负责发请求，其余等它。 */
let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;

async function loadLandingAssets(): Promise<Record<string, string>> {
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
      // 配图拿不到不该影响首页任何其它内容，静默退化成「没有配图」
      return {};
    } finally {
      inflight = null;
    }
  })();
  cache = await inflight;
  return cache;
}

export function SceneIllustration({ slot, hue }: { slot: string; hue: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadLandingAssets().then((map) => {
      if (alive) setUrl(map[slot] ?? null);
    });
    return () => { alive = false; };
  }, [slot]);

  if (!url || broken) return null;

  const tone = inkTone(hue);
  return (
    <Reveal offset={24} duration={1800} delay={160}>
      <div
        className="mt-4 overflow-hidden"
        style={{
          borderRadius: '14px',
          border: `1px solid ${SCENE.edge}`,
          background: SCENE.base,
          boxShadow: SCENE.liftMd,
        }}
      >
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className="block w-full"
          style={{ height: 'auto', borderBottom: `1px solid ${tone.border}` }}
        />
      </div>
    </Reveal>
  );
}
