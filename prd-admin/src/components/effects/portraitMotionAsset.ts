// MAP and Gateway use the same immutable night portraits.
export function createPortraitAssets(origin: string = import.meta.env?.VITE_ENTRY_MEDIA_CDN_ORIGIN ?? '') {
  const night = `${origin.trim().replace(/\/+$/, '')}/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night`;
  return {
    open: `${night}/companion-993c6d49f03e0854.webp`,
    closed: `${night}/companion-sleep-6a8da8cc2d5fd272.webp`,
    motion: `${night}/portrait-motion-0e8698b234df-0e8698b234dfac8c.mp4`,
  };
}

export const PORTRAIT_ASSETS = createPortraitAssets();
