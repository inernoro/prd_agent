# syntax=docker/dockerfile:1.4
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
# BuildKit cache mount：pnpm store 跨 build 复用，避免每次重建 CDS 镜像都全量重新下载依赖。
RUN --mount=type=cache,id=pnpm-store-cds,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm build

# CDS needs Docker socket for container management
# Mount /var/run/docker.sock when running
EXPOSE 9900 5500

CMD ["node", "dist/index.js"]
