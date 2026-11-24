import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { parseInstanceCatalog } from '../src/shared/instance-catalog';

// CDS web build config (React + Vite + Tailwind + shadcn/ui).
//
// Output lives at cds/web/dist/ (Vite default). Express serves it under root
// for every non-API dashboard route; React Router owns page-level routing.
//
// Local dev: `pnpm dev` → http://localhost:5173/. The dev proxy forwards
// /api/* to the running CDS scheduler on :9900.
export default defineConfig({
  base: '/',
  plugins: [react(), {
    name: 'cds-instance-catalog',
    generateBundle() {
      // Keep the public catalog in the same prebuilt artifact as the control panel.
      const file = path.resolve(__dirname, '../../cds-instances.json');
      this.emitFile({ type: 'asset', fileName: 'cds-instances.json', source: fs.existsSync(file)
        ? JSON.stringify(parseInstanceCatalog(JSON.parse(fs.readFileSync(file, 'utf8')))) : JSON.stringify({ version: 1, instances: [] }) });
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, './dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // One-time generation boundary for the atomic dist rollout. The
        // executable banner is retained in every emitted module, forcing new
        // fingerprints so browsers cannot reuse a previously failed chunk.
        banner: 'globalThis.__CDS_ATOMIC_WEB_DIST_GENERATION__ = "v1";',
      },
    },
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
