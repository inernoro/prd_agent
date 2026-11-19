// Versioned CDN paths. Integrity and authoring inputs are recorded in the acceptance manifests.
export type PortraitAssets = { open: string; closed: string; motion: string; opening?: string };

export function createPortraitAssets(
  origin: string = import.meta.env?.VITE_ENTRY_MEDIA_CDN_ORIGIN ?? '',
): Record<'dark' | 'light', PortraitAssets> {
  const sites = `${origin.trim().replace(/\/+$/, '')}/data/web-hosting/sites`;
  const original = `${sites}/93078f743f7543d6957d4af8414f4cf1`;
  const daylight = `${sites}/9a1ddb2322a84f4fa2a4d0d60173e3cf/daylight`;
  return {
    dark: {
      open: `${original}/night/companion-993c6d49f03e0854.webp`,
      closed: `${original}/night/companion-sleep-6a8da8cc2d5fd272.webp`,
      motion: `${original}/night/portrait-motion-0e8698b234df-0e8698b234dfac8c.mp4`,
    },
    light: {
      open: `${daylight}/settled-8880adf870ef3418.webp`,
      closed: `${original}/daylight/daylight-closed-de7cbfdb42c0ef6f.webp`,
      motion: `${daylight}/portrait-motion-05c8a2d277469c57.mp4`,
      opening: `${daylight}/opening-76c92b60a1ed0aff.webp`,
    },
  };
}

export const PORTRAIT_ASSETS = createPortraitAssets();
