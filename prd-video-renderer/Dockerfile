# syntax=docker/dockerfile:1.4
# prd-video-renderer 生产镜像：Node 20 + 系统 Chromium + prd-video 源码 + Remotion 依赖
# 通过 --build-context video=./prd-video 把 prd-video 注入；renderer 自身代码 COPY .

FROM node:20-bullseye-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium fonts-noto curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage "$@"\n' \
        > /usr/local/bin/chromium-docker && \
    chmod +x /usr/local/bin/chromium-docker && \
    npm install -g pnpm@9 --silent

# ─── 渲染器自身依赖 ───
FROM base AS renderer-deps
WORKDIR /renderer
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store-renderer,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

# ─── 渲染器编译 ───
FROM base AS build
WORKDIR /renderer
COPY package.json pnpm-lock.yaml* tsconfig.json ./
COPY src ./src
RUN --mount=type=cache,id=pnpm-store-renderer,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
RUN pnpm build

# ─── prd-video 依赖（独立 stage 避免和 renderer 互相污染）───
FROM base AS video-deps
WORKDIR /prd-video
# "video" 是构建时通过 --build-context video=./prd-video 传入的命名上下文
COPY --from=video package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store-video,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ─── 运行时镜像 ───
FROM base AS final
WORKDIR /renderer
COPY --from=renderer-deps /renderer/node_modules ./node_modules
COPY --from=build /renderer/dist ./dist
COPY package.json ./

# 嵌入 prd-video 源码 + 已装依赖
COPY --from=video . /prd-video
COPY --from=video-deps /prd-video/node_modules /prd-video/node_modules

ENV NODE_ENV=production
ENV PORT=5001
ENV PRD_VIDEO_PATH=/prd-video
ENV CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/chromium-docker

EXPOSE 5001
CMD ["node", "dist/server.js"]
