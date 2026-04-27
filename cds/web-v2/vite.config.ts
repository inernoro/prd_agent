import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// CDS web-v2 build config.
//
// Output goes to ../web-v2-dist/ (sibling of cds/web/) so the existing
// Express static fallback at cds/web/ stays untouched. The dev server uses
// /v2/ as base path to mirror production routing under Express, which mounts
// the built dist at /v2/* before the SPA fallback for /index.html.
//
// During local dev, run `pnpm dev` and access pages at http://localhost:5173/v2/.
// The dev proxy forwards /api/* to the running CDS scheduler on :9900.
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../web-v2-dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'radix-vendor': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tabs',
            '@radix-ui/react-slot',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:9900',
        changeOrigin: true,
      },
    },
  },
});
