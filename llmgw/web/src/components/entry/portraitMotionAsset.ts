// Versioned CDN URLs. Integrity and authoring inputs are recorded in the acceptance manifests.
export type PortraitAssets = { open: string; closed: string; motion: string; opening?: string };

export const PORTRAIT_ASSETS: Record<'dark' | 'light', PortraitAssets> = {
  "dark": {
    "open": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night/companion-993c6d49f03e0854.webp",
    "closed": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night/companion-sleep-6a8da8cc2d5fd272.webp",
    "motion": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/night/portrait-motion-0e8698b234df-0e8698b234dfac8c.mp4"
  },
  "light": {
    "open": "https://cfi.miduo.org/data/web-hosting/sites/9a1ddb2322a84f4fa2a4d0d60173e3cf/daylight/settled-8880adf870ef3418.webp",
    "closed": "https://cfi.miduo.org/data/web-hosting/sites/93078f743f7543d6957d4af8414f4cf1/daylight/daylight-closed-de7cbfdb42c0ef6f.webp",
    "motion": "https://cfi.miduo.org/data/web-hosting/sites/9a1ddb2322a84f4fa2a4d0d60173e3cf/daylight/portrait-motion-05c8a2d277469c57.mp4",
    "opening": "https://cfi.miduo.org/data/web-hosting/sites/9a1ddb2322a84f4fa2a4d0d60173e3cf/daylight/opening-76c92b60a1ed0aff.webp"
  }
};
