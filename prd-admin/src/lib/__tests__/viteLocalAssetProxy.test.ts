import { describe, expect, it } from 'vitest';
import viteConfig from '../../../vite.config';

describe('Vite local asset proxy contract', () => {
  it('forwards LocalAssetStorage URLs to the API in direct dev mode', () => {
    const config = viteConfig as {
      server?: {
        proxy?: Record<string, { target?: string; changeOrigin?: boolean }>;
      };
    };

    expect(config.server?.proxy?.['/local-assets']).toMatchObject({
      target: 'http://localhost:5001',
      changeOrigin: true,
    });
  });
});
