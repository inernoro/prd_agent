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
    // 2026-05-04 fix:关 sourcemap + 用 esbuild minify 降内存。
    // production CDS host 实测 vite build 在 rollup "rendering chunks" 阶段 OOM。
    // sourcemap 占内存巨大(每个 chunk 都要 inline source) — 关掉省 ~40% RAM。
    // esbuild minifier 比默认 terser 省 ~30% RAM 而且快 10x。
    // 调试用 sourcemap → 本地 `pnpm dev` 走 vite dev server 自带 inline sourcemap。
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2022',
    // 提高 chunk size warning,manualChunks 关掉 — 让 rollup 用默认策略
    // (按 import graph 自动切),减少 cross-chunk reference 表的内存峰值。
    chunkSizeWarningLimit: 1000,
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
