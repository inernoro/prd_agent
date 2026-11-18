// Versioned CDN URLs. Integrity and authoring inputs are recorded in the acceptance manifests.
export type PortraitAssets = { open: string; closed: string; motion: string };

export const PORTRAIT_ASSETS: Record<'dark' | 'light', PortraitAssets> = {
  "dark": {
    "open": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night/companion-993c6d49f03e0854.webp",
    "closed": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night/companion-sleep-6a8da8cc2d5fd272.webp",
    "motion": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night/portrait-motion-0e8698b234df-0e8698b234dfac8c.mp4"
  },
  "light": {
    "open": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/daylight/daylight-open-b65ff9396b44cd52.webp",
    "closed": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/daylight/daylight-closed-de7cbfdb42c0ef6f.webp",
    "motion": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/daylight/portrait-motion-7ff66cc3b1d4357e.mp4"
  }
};
