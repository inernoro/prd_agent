# syntax=docker/dockerfile:1.4
# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

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

EXPOSE 8080

# Serve the dist folder on port 8080 with SPA fallback (-s)
CMD ["serve", "-s", "dist", "-l", "8080"]
