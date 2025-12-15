import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    // 避免与仓库内其他 Vite 项目（默认 5173）冲突
    // 需要自定义时：PORT=xxxx pnpm dev
    port: Number.parseInt(process.env.PORT || '', 10) || 5180,
    strictPort: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
