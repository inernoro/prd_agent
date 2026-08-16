# syntax=docker/dockerfile:1.4
# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# 这些值只允许承载公开展示配置。域名、邮箱和项目入口由部署流水线在构建镜像时注入，
# 不在源码中提供任何第一方环境默认值；密钥不得使用 VITE_*（会进入浏览器产物）。
ARG VITE_CONTACT_EMAIL=""
ARG VITE_FRONT_END_PDA_LINKS_JSON=""
ARG VITE_FRONT_END_PROJECT_REGISTRY_JSON=""
ARG VITE_PA_LEARN_MORE_URL=""
ARG VITE_PUBLIC_DOCS_URL=""
ENV VITE_CONTACT_EMAIL=${VITE_CONTACT_EMAIL} \
    VITE_FRONT_END_PDA_LINKS_JSON=${VITE_FRONT_END_PDA_LINKS_JSON} \
    VITE_FRONT_END_PROJECT_REGISTRY_JSON=${VITE_FRONT_END_PROJECT_REGISTRY_JSON} \
    VITE_PA_LEARN_MORE_URL=${VITE_PA_LEARN_MORE_URL} \
    VITE_PUBLIC_DOCS_URL=${VITE_PUBLIC_DOCS_URL}

# Install pnpm via corepack (matches the packageManager field in package.json)
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Copy lockfile and manifest first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies needed for the build).
# BuildKit cache mount：pnpm content-addressable store 跨 build 复用，避免每个分支
# 预览都从零重新下载全量依赖（这是构建耗时长的主因之一，见根 CLAUDE.md 性能说明）。
# store 目录走 pnpm 默认位置 $XDG_DATA_HOME/pnpm/store = /root/.local/share/pnpm/store。
RUN --mount=type=cache,id=pnpm-store-admin,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy the rest of the source
COPY . .

# Build the app — increase heap to handle the large dependency tree.
# 4096 而非 2048：GitHub Actions runner（7GB）下 2048 上限会在 vite build 时
# OOM（exit 134）。CI 预构建（branch-image.yml）依赖此镜像构建成功。
RUN NODE_OPTIONS='--max-old-space-size=4096' pnpm run build

# ── Stage 2: serve ────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# Install `serve` globally — lightweight static file server
RUN npm install -g serve@14

WORKDIR /app

# Copy only the compiled output from the build stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts/start-static.mjs ./scripts/start-static.mjs

EXPOSE 8080

# 容器启动时生成公开 runtime-config.js，再以 SPA fallback 提供静态站。
CMD ["node", "scripts/start-static.mjs"]
