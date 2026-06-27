import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 独立 mini-app：自带 dev server（默认 8100，避开 prd-admin 8000）。
// API base 走 VITE_LLMGW_API_BASE（默认 /gw），dev 时把 /gw 反代到本地网关后端。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number.parseInt(process.env.PORT || '', 10) || 8100,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/gw': {
        target: process.env.LLMGW_PROXY_TARGET || 'http://localhost:5000',
        changeOrigin: true,
        timeout: 180_000,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
