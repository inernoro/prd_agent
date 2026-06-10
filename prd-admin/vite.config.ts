import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { execSync } from 'child_process';

function getGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getBuildId(): string {
  const raw = process.env.VITE_BUILD_ID || process.env.GITHUB_SHA || (() => {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'local';
    }
  })();
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'local';
}

const buildId = getBuildId();

export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    __GIT_BRANCH__: JSON.stringify(process.env.VITE_GIT_BRANCH || getGitBranch()),
  },
  // 默认 Vite 只暴露 VITE_ 前缀；这里额外暴露 TENCENT_ 前缀，便于前端拼接 COS 公网资源地址（如头像）
  envPrefix: ['VITE_', 'TENCENT_'],
  server: {
    // 需要自定义时：PORT=xxxx pnpm dev
    // 默认 8000（与后端 5000 端口区分开，便于联调）
    port: Number.parseInt(process.env.PORT || '', 10) || 8000,
    strictPort: false,
    // Allow all hosts — the dev server runs behind nginx reverse-proxy whose Host header
    // won't match the container hostname. Security is enforced at the nginx layer.
    allowedHosts: true,
    // 本地联调：通过同源 /api 反代到后端，彻底避免 CORS/OPTIONS 预检 403
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        // VLM 图片分析等长时间请求需要足够的超时时间（默认太短会导致代理层提前断开）
        timeout: 180_000,
        // 禁用代理缓冲，确保 SSE 流式响应能立即传递到浏览器
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            // 如果是 SSE 请求，禁用缓冲
            if (req.headers.accept?.includes('text/event-stream')) {
              proxyReq.setHeader('X-Accel-Buffering', 'no');
            }
          });
          proxy.on('proxyRes', (proxyRes, _req, _res) => {
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
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // CDS static 部署在共享主机上 vite build 易 OOM（exitCode=137）。
    // 关 sourcemap + esbuild minify 降内存，与 cds/web/vite.config.ts 对齐。
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${buildId}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildId}.js`,
        assetFileNames: `assets/[name]-[hash]-${buildId}[extname]`,
      },
    },
  },
});
