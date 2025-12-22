FROM node:20-bookworm-slim AS build

WORKDIR /repo

# pnpm via corepack（避免生产机构建；这里只在 CI 构建）
RUN corepack enable

# 先拷贝依赖清单以提升缓存命中
COPY prd-admin/package.json prd-admin/pnpm-lock.yaml prd-admin/ ./

WORKDIR /repo/prd-admin
RUN pnpm install --frozen-lockfile

# 再拷贝源码并构建
COPY prd-admin/ ./

# 同域部署：让前端请求走 /api/v1/...（base 为空 => joinUrl 返回 /api/v1/...）
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN pnpm build

FROM nginx:1.27-alpine AS runtime

COPY deploy/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/prd-admin/dist/ /usr/share/nginx/html/


