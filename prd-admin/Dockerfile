# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN NODE_OPTIONS='--max-old-space-size=2048' pnpm run build

# Stage 2: Serve
FROM node:20-slim AS runner

RUN npm install -g serve@14

COPY --from=builder /app/dist ./dist

EXPOSE 8080

CMD ["serve", "-s", "dist", "-l", "8080"]
