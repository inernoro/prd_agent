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
  // 正式控制台挂载在 /llmgw/。默认固定公开 base，确保 CSS 内嵌的字体 URL 也落到
  // /llmgw/assets，而不是误请求 MAP 主站的 /assets 并得到 404。
  // CDS 预览把控制台放在独立子域的根路径（<slug>-llmgw.<root>/），Vite 开发服务器
  // 只认 base 之下的路径：MAP 单点登录跳到根路径的 /auth/map 会被直接拒掉
  // （「did you mean to visit /llmgw/auth/map」）。
  // 判定顺序：显式 LLMGW_WEB_BASE > 在 CDS 里跑（平台对每个容器强制注入 VITE_GIT_BRANCH，
  // 且 CDS 恒把本控制台发布在独立子域根路径）则 "/" > 其余（CI 镜像构建、本地）保持 /llmgw/。
  // 不只靠 compose 里的 LLMGW_WEB_BASE：repo 的 cds-compose.yml 只是结构种子，
  // 环境变量要经 CDS 导入审批才生效，靠它会让修复推上去却不起作用。
  // 前端路由由 runtimeBase.ts 按实际路径推断，两种挂载都成立。
  base: process.env.LLMGW_WEB_BASE || (process.env.VITE_GIT_BRANCH ? '/' : '/llmgw/'),
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
