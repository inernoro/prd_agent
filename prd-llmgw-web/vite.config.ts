import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 独立 mini-app：自带 dev server（默认 8100，避开 prd-admin 8000）。
// API base 走 VITE_LLMGW_API_BASE（默认 /gw），dev 时把 /gw 反代到**独立网关 console 后端**。
// 默认 5090：docker-compose.dev.yml 把 llmgw（prd-llmgw）映射为 5090:8090（容器内 8090）。
// 不能默认 5000——那是主 API（prd-api），不提供 /gw/auth/login、/gw/logs 等 console 端点（Codex P2）。
// 本地直接 dotnet run prd-llmgw（监听 8090）时，用 LLMGW_PROXY_TARGET=http://localhost:8090 覆盖。
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
        target: process.env.LLMGW_PROXY_TARGET || 'http://localhost:5090',
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
