# syntax=docker/dockerfile:1.4
# prd-video-renderer 生产镜像
# 关键决策：用 ghcr.io/puppeteer/puppeteer 官方镜像作为基座
# - 自带 Chromium + Node.js 20 + 系统字体
# - 避免 runtime apt install chromium（耗时 10+ 分钟，每次容器重启都要重做）
# - 镜像层 ~1.5GB 但只 pull 一次

FROM ghcr.io/puppeteer/puppeteer:23.10.1 AS base
USER root
RUN npm install -g pnpm@9 --silent && \
    printf '#!/bin/sh\nexec "$PUPPETEER_EXECUTABLE_PATH" --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage "$@"\n' \
        > /usr/local/bin/chromium-docker && \
    chmod +x /usr/local/bin/chromium-docker

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
COPY --from=video package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store-video,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ─── 运行时 ───
FROM base AS final
WORKDIR /renderer
COPY --from=build /renderer/node_modules ./node_modules
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
