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
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
