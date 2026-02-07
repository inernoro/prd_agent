import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // 默认 Vite 只暴露 VITE_ 前缀；这里额外暴露 TENCENT_ 前缀，便于前端拼接 COS 公网资源地址（如头像）
  envPrefix: ['VITE_', 'TENCENT_'],
  server: {
    // 需要自定义时：PORT=xxxx pnpm dev
    // 默认 8000（与后端 5000 端口区分开，便于联调）
    port: Number.parseInt(process.env.PORT || '', 10) || 8000,
    strictPort: false,
    // 本地联调：通过同源 /api 反代到后端，彻底避免 CORS/OPTIONS 预检 403
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        // 禁用代理缓冲，确保 SSE 流式响应能立即传递到浏览器
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            // 如果是 SSE 请求，禁用缓冲
            if (req.headers.accept?.includes('text/event-stream')) {
              proxyReq.setHeader('X-Accel-Buffering', 'no');
            }
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            // 如果是 SSE 响应，禁用缓冲
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
              proxyRes.headers['cache-control'] = 'no-cache';
            }
          });
        },
      },
    },
  },
  build: {
    // Safari 兼容：确保现代 JS 语法降级到 Safari 14+ 支持的范围
    target: ['es2021', 'chrome100', 'safari14'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
