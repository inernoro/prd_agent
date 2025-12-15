import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    // 需要自定义时：PORT=xxxx pnpm dev
    // 默认 8000（与后端 5000 端口区分开，便于联调）
    port: Number.parseInt(process.env.PORT || '', 10) || 8000,
    strictPort: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
