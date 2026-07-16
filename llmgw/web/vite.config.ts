import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 独立 mini-app：自带 dev server（默认 8100，避开 prd-admin 8000）。
// API base 走 VITE_LLMGW_API_BASE（默认 /gw）。dev/CDS 源码模式同时代理控制台与四协议入口，
// 避免 llmgw-web 只能依赖 GHCR 预构建 nginx 镜像，GitHub 故障时无法验收当前提交。
// 默认 5090：docker-compose.dev.yml 把 llmgw（llmgw/console-api）映射为 5090:8090（容器内 8090）。
// 不能默认 5000——那是主 API（prd-api），不提供 /gw/auth/login、/gw/logs 等 console 端点（Codex P2）。
// 本地直接 dotnet run llmgw/console-api（监听 8090）时，用 LLMGW_PROXY_TARGET=http://localhost:8090 覆盖。
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
      // 必须放在 /gw 之前：GW Native 属于 serving，不是 console API。
      '/gw/v1': {
        target: process.env.LLMGW_SERVING_PROXY_TARGET || 'http://localhost:5091',
        changeOrigin: true,
        timeout: 3_600_000,
      },
      '/v1': {
        target: process.env.LLMGW_SERVING_PROXY_TARGET || 'http://localhost:5091',
        changeOrigin: true,
        timeout: 3_600_000,
      },
      '/v1beta': {
        target: process.env.LLMGW_SERVING_PROXY_TARGET || 'http://localhost:5091',
        changeOrigin: true,
        timeout: 3_600_000,
      },
      '/gemini/v1beta': {
        target: process.env.LLMGW_SERVING_PROXY_TARGET || 'http://localhost:5091',
        changeOrigin: true,
        timeout: 3_600_000,
      },
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
