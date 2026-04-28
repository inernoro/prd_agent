import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// CDS web build config (React + Vite + Tailwind + shadcn/ui).
//
// Output lives at cds/web/dist/ (Vite default). Express serves it under root
// for migrated routes (see installSpaFallback / MIGRATED_REACT_ROUTES in
// cds/src/server.ts); unmigrated paths fall through to cds/web-legacy/.
//
// Local dev: `pnpm dev` → http://localhost:5173/. The dev proxy forwards
// /api/* to the running CDS scheduler on :9900.
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, './dist'),
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
