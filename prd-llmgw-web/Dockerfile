# 独立 LLM 网关前端站 prd-llmgw-web —— 多阶段构建：pnpm 构建静态产物 → nginx 托管。
# 与 prd-admin 同款 pnpm/corepack 流程；nginx 负责 SPA 回退 + /gw 反代到网关后端容器。
# syntax=docker/dockerfile:1.4
FROM node:20-slim AS build
WORKDIR /app

# 启用 corepack 固定 pnpm 版本（与 prd-admin 一致）
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# 先拷贝 manifest 利用缓存层
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 拷贝源码并构建
COPY . .
RUN pnpm run build

# ── 运行阶段：nginx 静态托管 ──
FROM nginx:1.27-alpine AS final
ARG GIT_COMMIT=""
ARG BUILD_TIME_UTC=""
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME_UTC=$BUILD_TIME_UTC

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
